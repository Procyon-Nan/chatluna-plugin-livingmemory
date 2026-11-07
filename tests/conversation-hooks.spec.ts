import assert from 'node:assert/strict'
import { Context } from 'cordis'
import Routing from '@chatluna/routing'
import SchemaRegistry from '@chatluna/ui-schema-registry'
import { routeIdOf } from '@chatluna/satori'
import { registerRouteSettings, routeSettings } from '../src/routing.ts'
import type { RouteSettings } from '../src/routing.ts'
import type { Agent, TurnMiddleware } from '@chatluna/agent'
import { ChatMessage, contentText } from '@chatluna/message'
import { absorb } from '@chatluna/chat-observer'
import { createSpeakerKey } from '../src/service/memory/speaker_identity.ts'
import { LivingMemoryRecallCoordinator } from '../src/service/workflows/recall/coordinator.ts'
import { LivingMemoryConversationHooks } from '../src/service/conversation_hooks.ts'
import { LivingMemoryChatHistory } from '../src/service/chat_history.ts'
import type { ChatHistoryScope } from '../src/service/chat_history.ts'
import type { LivingMemoryTranscriptMessage } from '../src/contracts/memory.ts'
import { createCapturedLogger, createJobStore } from './workflow-test-utils.ts'
import { FrameworkHistoryFixture, historyMessage } from './chat-history-test-utils.ts'

const settle = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))
}
type Prepare = (input: { agent: Agent; stepNumber: number; messages: readonly ChatMessage[] }) => Promise<{ contribute?: readonly ChatMessage[] } | undefined>

function createHarness(config: {
    overheard?: boolean
    extractionWindow?: number
    recallInterval?: number
    rules?: Partial<RouteSettings>
    settingsOf?: ConstructorParameters<typeof LivingMemoryConversationHooks>[1]['settingsOf']
    onRecallModel?: (input: string) => void
} = {}) {
    const framework = new FrameworkHistoryFixture()
    const listeners = new Map<string, ((payload: any) => unknown)[]>()
    const recalls: { scope: ChatHistoryScope; history: LivingMemoryTranscriptMessage[]; position: number }[] = []
    const extractions: { scope: ChatHistoryScope; boundary: number; eligible?: number; origin: () => Promise<{ header: string }> }[] = []
    const cleared: string[] = []
    const profiles: string[][] = []
    let onTurn!: TurnMiddleware
    const order: string[] = []
    let prepare!: Prepare
    let snapshotText = ''
    let presetId: string | undefined = 'preset-1'
    let sessionId = 'session-1'
    let drainGate: Promise<unknown> = Promise.resolve()
    let currentGate: Promise<unknown> = Promise.resolve()
    let scopeLookups = 0
    const captured = createCapturedLogger(false)
    const emit = (name: string, payload: unknown) => {
        return Promise.all((listeners.get(name) ?? []).map(listener => listener(payload)))
    }
    const ctx = {
        get: (name: string) => name === 'engines' ? { presetOf: (agent: Agent) => agent.options.engine ? presetId : undefined } : undefined,
        agents: {
            turn: (middleware: TurnMiddleware) => { onTurn = middleware; return () => {} },
            prepareStep: (callback: Prepare) => { prepare = callback; return () => {} }
        },
        on: (name: string, listener: (payload: unknown) => unknown) => {
            const entries = listeners.get(name) ?? []
            entries.push(listener)
            listeners.set(name, entries)
            return () => listeners.set(name, entries.filter((entry) => entry !== listener))
        },
        conversations: {
            current: async () => { scopeLookups++; await currentGate; return { sessionId, presetId } }
        },
        chat: {
            drain: async () => { await drainGate; order.push('drain'); return 1 },
            environmentOf: () => ({ guildName: '测试群' })
        }
    } as unknown as Context
    const history = new LivingMemoryChatHistory(framework)
    const onModel = config.onRecallModel
    const hooks = new LivingMemoryConversationHooks(ctx, {
        history,
        recall: onModel ? new LivingMemoryRecallCoordinator('test/model', history, {
            createFailedJob: createJobStore().createFailedJob,
            getLatestSnapshotByScope: async () => undefined,
            upsertSnapshot: async () => {}
        }, { run: async (_settings, _scope, input) => { onModel(input); return null } }, captured.logger) : {
            queue: async (_settings: unknown, scope: ChatHistoryScope,
                history: LivingMemoryTranscriptMessage[], position: number) => {
                recalls.push({ scope, history, position })
            },
            clearByConversation: (key: string) => cleared.push(key)
        } as never,
        extraction: {
            queue: async (scope: ChatHistoryScope, options: { resolveTranscriptOrigin: () => Promise<{ header: string }> },
                boundary: number, eligible?: number) => {
                order.push('extract')
                extractions.push({ scope, boundary, eligible, origin: options.resolveTranscriptOrigin })
            },
            clearByConversation: () => {}
        } as never,
        userProfiles: { renderForSpeakers: async (_preset: string, keys: string[]) => { profiles.push(keys); return keys.length ? '测试画像' : '' } } as never,
        repository: { getLatestSnapshotByScope: async () => snapshotText === '' ? undefined : {
            items: [{ finalText: snapshotText, matchedMemories: [], toolCallSummary: { searchTexts: [], searchKeywords: [], maxCandidates: 0 } }]
        } as never },
        logger: captured.logger,
        settingsOf: config.settingsOf ?? (() => ({
            enableAutoDream: true, enableConversationIsolation: false, snapshotMaxLines: 5,
            enableSnapshotInjection: true, enableUserProfileInjection: false,
            recallIntervalMessages: config.recallInterval ?? 1, recallHistoryMessages: 20,
            extractionWindowMessages: config.extractionWindow ?? 2,
            extractionIncludeOverheard: config.overheard ?? false,
            ...config.rules
        }))
    })
    const dispose = hooks.register()
    const agent = (turn = 1, engine?: string) => ({
        options: { conversationKey: 'conv-1', presetId, engine },
        session: { id: sessionId, lastTurn: turn },
        pending: []
    }) as unknown as Agent
    const user = (position: number) => ChatMessage.user('chat', { meta: { externalId: `m-${position}` } })
    return {
        framework, hooks, recalls, profiles, extractions, cleared, order, dispose, agent, user,
        warnings: captured.warnings,
        get scopeLookups() { return scopeLookups },
        engineTurn: (agent: Agent, turn: number, input: number | ChatMessage[]) => emit('chatluna/engine-turn', {
            agent, turn, input: typeof input === 'number' ? [user(input)] : input
        }),
        input: (agent: Agent, message: ChatMessage, state: 'queued' | 'dropped' | 'taken') => {
            const pending = agent.pending as ChatMessage[]
            if (state === 'queued') pending.push(message)
            else {
                const index = pending.findIndex(item => item.id === message.id)
                assert.notEqual(index, -1, 'only pending messages can be taken or dropped')
                pending.splice(index, 1)
            }
            return emit('chatluna/agent-input', { agent, message, state })
        },
        begin: (agent: Agent, input: number | ChatMessage[]) => onTurn({
            agent, turn: agent.session.lastTurn, input: typeof input === 'number' ? [user(input)] : input,
            signal: new AbortController().signal
        }, async () => ({ reason: 'completed' })),
        prepare: (agent: Agent, messages: ChatMessage[] = [], stepNumber = 1) =>
            prepare({ agent, stepNumber, messages }),
        send: (ids: number[], turn = 1, originPreset = presetId) => emit('send', {
            chatSent: { own: true, reply: { conversationKey: 'conv-1', sessionId, presetId: originPreset, turn },
                messageIds: ids.map(id => 'm-' + id) }
        }),
        observed: async (id: number, text: string, overrides: Parameters<typeof historyMessage>[2] = {}) => {
            const message = historyMessage(id, text, overrides)
            framework.messages.push(message)
            emit('chatluna/observed', { conversationKey: 'conv-1', sessionId, message })
            await settle()
        },
        turn: async (target: Agent) => { emit('chatluna/agent-turn', { agent: target, reason: 'completed' }); await settle() },
        switch: (nextPreset: string | undefined, nextSession = sessionId) => {
            const previous = { sessionId, presetId }
            presetId = nextPreset
            sessionId = nextSession
            emit('chatluna/conversation-change', {
                conversationKey: 'conv-1', previous, current: { sessionId, presetId }, reason: 'preset'
            })
        },
        setSnapshot: (text: string) => { snapshotText = text },
        setDrain: (gate: Promise<unknown>) => { drainGate = gate },
        setCurrent: (gate: Promise<unknown>) => { currentGate = gate }
    }
}

describe('LivingMemoryConversationHooks', () => {
    it('injects the current snapshot on step one only', async () => {
        const harness = createHarness()
        await harness.observed(10, '问')
        harness.setSnapshot('用户喜欢红茶')
        const agent = harness.agent()
        await harness.begin(agent, 10)
        const first = await harness.prepare(agent)
        const second = await harness.prepare(agent, [], 2)
        assert.match(contentText(first!.contribute![0].content), /用户喜欢红茶/)
        assert.equal(second, undefined)
    })

    it('uses the actual input batch while a later user message is already recorded', async () => {
        const harness = createHarness()
        await harness.observed(10, 'earlier')
        await harness.observed(30, 'current')
        await harness.observed(50, 'queued next')
        await harness.begin(harness.agent(), [harness.user(30), harness.user(50)])
        assert.equal(harness.recalls[0].position, 1)
        assert.deepEqual(harness.recalls[0].history.map((message) => message.contentLines.join('')), ['earlier', 'current'])
    })

    it('uses the first wake after quiet chat even when a later input mentions the bot', async () => {
        const h = createHarness({ rules: { enableConversationIsolation: true } })
        for (const id of [1, 2, 3]) await h.observed(id, 'chat', { userId: 'u' + id })
        const ordinary = ChatMessage.user('ordinary wake', { meta: { externalId: 'm-2', wake: { by: 'activity', reason: 'activity' } } })
        const mention = ChatMessage.user('later @', { meta: { externalId: 'm-3', wake: { by: 'chat', reason: 'at-me', direct: true } } })
        const agent = h.agent()
        await h.begin(agent, [h.user(1), ordinary, mention])
        assert.equal(h.recalls[0].position, 1)
        assert.equal(h.hooks.settingsForTurn(agent)?.enableConversationIsolation, true)
    })

    it('locates the original chat in a folded envelope and excludes notices', async () => {
        const harness = createHarness()
        await harness.observed(10, '问')
        const folded = ChatMessage.user([{
            type: 'envelope', kind: 'message', id: 'route:m-10', externalId: 'm-10',
            sender: { id: 'user-1' }, time: 1_010, content: [{ type: 'text', text: '问' }]
        }])
        await harness.begin(harness.agent(), [folded, ChatMessage.notice('internal', 'notice')])
        assert.equal(harness.recalls[0].position, 0)
        await harness.begin(harness.agent(), [ChatMessage.notice('wake', 'proactive wake'), ChatMessage.user('internal steer')])
        assert.equal(harness.recalls.length, 1)
    })

    it('counts the first post-restart user message and preserves the baseline across agent recreation', async () => {
        const harness = createHarness()
        harness.framework.messages.push(historyMessage(10, 'old'))
        await harness.observed(30, 'first new')
        const firstAgent = harness.agent()
        await harness.begin(firstAgent, 30)
        harness.send([40], 1)
        await harness.observed(40, 'answer', { self: true })
        await harness.turn(firstAgent)
        assert.equal(harness.extractions[0].boundary, 0)
        const replacement = harness.agent(2)
        await harness.observed(50, 'second new')
        await harness.begin(replacement, 50)
        harness.send([60], 2)
        await harness.observed(60, 'second answer', { self: true })
        await harness.turn(replacement)
        assert.equal(harness.extractions[1].boundary, 0)
        assert.equal(harness.cleared.length, 0)
    })

    it('resets every preset switch including A to B to A and ignores late old-preset replies', async () => {
        const harness = createHarness()
        await harness.observed(10, 'A')
        const oldAgent = harness.agent()
        await harness.begin(oldAgent, 10)
        harness.switch('preset-2')
        await harness.observed(30, 'B')
        await harness.begin(harness.agent(), 30)
        harness.switch('preset-1')
        await harness.observed(50, 'new A')
        const currentAgent = harness.agent(3)
        await harness.begin(currentAgent, 50)
        await harness.turn(oldAgent)
        assert.equal(harness.extractions.length, 0)
        harness.send([60], 1, 'preset-2')
        await harness.observed(60, 'late B reply', { self: true })
        harness.send([65], 1) // 切回 A 前的同名预设，仍属于旧轮。
        await harness.observed(65, 'late old A reply', { self: true })
        harness.send([70], 3)
        await harness.observed(70, 'new A reply', { self: true })
        await harness.turn(currentAgent)
        assert.equal(harness.extractions[0].boundary, 1)
        assert.equal(harness.extractions[0].scope.presetId, 'preset-1')
        assert.equal(harness.cleared.length, 2)
    })

    it('resets a history switch even when the preset stays the same', async () => {
        const harness = createHarness()
        await harness.observed(10, 'old history')
        await harness.begin(harness.agent(), 10)
        harness.switch('preset-1', 'session-2')
        await harness.observed(80, 'new history')
        const agent = harness.agent()
        await harness.begin(agent, 80)
        assert.deepEqual(harness.recalls.at(-1)!.history.map(m => m.contentLines), [['new history']])
        harness.send([90], 1)
        await harness.observed(90, 'new reply', { self: true })
        await harness.turn(agent)
        assert.equal(harness.extractions[0].scope.sessionId, 'session-2')
        assert.equal(harness.extractions[0].boundary, 0)
    })

    it('triggers overheard extraction for user-only traffic and never counts backfill', async () => {
        const harness = createHarness({ overheard: true })
        await harness.observed(10, 'backfill', { backfilled: true })
        assert.equal(harness.extractions.length, 0)
        await harness.observed(30, 'first overheard')
        await harness.observed(50, 'second overheard')
        assert.deepEqual(harness.extractions.map((call) => call.boundary), [0, 0])
        assert.equal(harness.recalls.length, 0)
    })

    it('waits for full rendering and history commit before normal extraction', async () => {
        const harness = createHarness()
        let release!: () => void
        harness.setDrain(new Promise<void>((resolve) => { release = resolve }))
        await harness.observed(10, 'question')
        const agent = harness.agent()
        await harness.begin(agent, 10)
        await harness.turn(agent)
        harness.send([20], 1)
        await harness.observed(20, 'first split reply', { self: true })
        assert.equal(harness.extractions.length, 0)
        harness.send([30], 1)
        await harness.observed(30, 'second split reply', { self: true })
        Object.assign(agent.session, { lastTurn: 2 })
        await harness.observed(40, 'next question')
        await harness.begin(agent, 40)
        harness.send([50], 2)
        await harness.observed(50, 'next turn partial reply', { self: true })
        release()
        await settle()
        assert.deepEqual(harness.order, ['drain', 'extract'])
        assert.equal(harness.extractions[0].eligible, 2)
        assert.match((await harness.extractions[0].origin()).header, /测试群/)
    })

    it('waits for observation after drain and counts a multi-ID send only once', async () => {
        const harness = createHarness()
        await harness.observed(10, 'question')
        const agent = harness.agent()
        await harness.begin(agent, 10)
        harness.send([20, 21])
        await harness.turn(agent)
        assert.equal(harness.extractions.length, 0)
        await harness.observed(20, 'reply', { self: true })
        await harness.observed(21, 'reply', { self: true })
        assert.deepEqual(harness.extractions.map(x => x.eligible), [1])
    })

    it('attributes a direct engine reply even when the engine skips prepareStep', async () => {
        const harness = createHarness()
        await harness.observed(1, 'question')
        const agent = harness.agent(7, 'test-engine')
        await harness.engineTurn(agent, 7, 1)
        assert.equal(harness.recalls.length, 1)
        assert.deepEqual(harness.recalls[0].history.map(m => m.contentLines), [['question']])
        harness.send([2], 7)
        await harness.observed(2, 'direct answer', { self: true })
        await harness.turn(agent)
        assert.deepEqual(harness.extractions.map(x => x.eligible), [1])
    })

    it('does not trigger normal extraction for a turn without an actually delivered reply', async () => {
        const harness = createHarness()
        await harness.observed(10, 'question')
        const agent = harness.agent()
        await harness.begin(agent, 10)
        await harness.turn(agent)
        assert.equal(harness.extractions.length, 0)
    })

    it('discards a pending scope lookup if the preset changes', async () => {
        const harness = createHarness()
        await harness.observed(10, 'old')
        let release!: () => void
        harness.setCurrent(new Promise<void>((resolve) => { release = resolve }))
        const preparing = harness.begin(harness.agent(), 10)
        await settle()
        harness.switch('preset-2')
        release()
        await preparing
        assert.equal(harness.recalls.length, 0)
        await harness.observed(30, 'new')
        await harness.begin(harness.agent(), 30)
        assert.equal(harness.recalls[0].scope.presetId, 'preset-2')
    })

    it('disables extraction at zero and drops pending delivery callbacks after disposal', async () => {
        const disabled = createHarness({ extractionWindow: 0 })
        await disabled.observed(10, 'question')
        const disabledAgent = disabled.agent()
        await disabled.begin(disabledAgent, 10)
        await disabled.turn(disabledAgent)
        assert.equal(disabled.extractions.length, 0)

        const harness = createHarness()
        let release!: () => void
        harness.setDrain(new Promise<void>((resolve) => { release = resolve }))
        await harness.observed(10, 'question')
        const agent = harness.agent()
        await harness.begin(agent, 10)
        await harness.turn(agent)
        harness.dispose()
        release()
        await settle()
        assert.equal(harness.extractions.length, 0)
    })
})

const foldedChat = (id: number, sender: string, wake?: { by: string; reason: string; direct?: true }) =>
    ChatMessage.user('chat', { meta: { externalId: 'm-' + id, sender: { id: sender }, wake: wake && { ...wake } } })
const direct = { by: 'chat', reason: 'at-me', direct: true } as const

it('freezes Alice’s triggering window on enqueue across folded inputs, buffer rollover and model steps', async () => {
    const h = createHarness({ rules: {
        enableUserProfileInjection: true, enableConversationIsolation: true, recallHistoryMessages: 2
    } })
    await h.observed(0, 'earlier', { userId: 'dave' })
    await h.observed(1, 'question', { userId: 'alice' })
    const a = h.agent(1, 'test-engine')
    const firstInput = absorb(undefined, foldedChat(1, 'alice', direct), 1)
    // 入队通知是同步的，排队等待开轮期间原记录可以滚出缓冲。
    const queued = h.input(a, firstInput, 'queued')
    h.framework.messages.splice(0, 2)
    await queued
    await settle()
    assert.equal(h.recalls.length, 1, 'the accepted wake is scheduled before engine-turn')
    await h.observed(2, 'same batch', { userId: 'bob' })
    const batch = absorb(firstInput, foldedChat(2, 'bob', direct), 2)
    // 框架合批时先丢弃旧信封，再把含两条消息的新信封入队。
    await Promise.all([h.input(a, firstInput, 'dropped'), h.input(a, batch, 'queued')])
    await h.input(a, batch, 'taken')
    assert.equal(h.recalls.length, 1, 'folding keeps the original wake')
    await h.engineTurn(a, 1, [batch])
    assert.equal(h.recalls.length, 1)
    assert.equal(h.recalls[0].position, 1)
    assert.equal(h.hooks.settingsForTurn(a)?.enableConversationIsolation, true)

    await h.observed(3, 'queued next', { userId: 'alice' })
    const first = await h.prepare(a, [h.user(3)])
    assert.match(contentText(first!.contribute![0].content), /测试画像/)
    assert.equal((await h.prepare(a))?.contribute?.[0], first!.contribute![0])
    assert.equal(h.recalls.length, 1)
    assert.deepEqual(h.recalls[0].history.map(m => m.contentLines), [['earlier'], ['question']])
    assert.deepEqual(h.profiles, [['dave', 'alice'].map(id => createSpeakerKey('onebot', id))])

    // Bob 留在频道历史中，下次有真实触发时可进入该轮窗口。
    await h.engineTurn(a, 2, 3)
    assert.equal(h.recalls.length, 2)
    assert.deepEqual(h.recalls[1].history.map(m => m.contentLines), [['same batch'], ['queued next']])
    h.switch('preset-2')
    assert.equal(h.hooks.settingsForTurn(a), undefined)
    assert.equal(await h.prepare(a, [h.user(3)]), undefined)
})

it('schedules a bare agent’s first wake on enqueue and reuses it at turn start', async () => {
    const h = createHarness()
    const a = h.agent()
    await h.observed(1, 'question', { userId: 'alice' })
    const first = foldedChat(1, 'alice', direct)
    const queued = h.input(a, first, 'queued')
    h.framework.messages.splice(0)
    await queued
    await settle()
    assert.equal(h.recalls.length, 1)
    assert.deepEqual(h.recalls[0].history.map(m => m.contentLines), [['question']])
    await h.input(a, first, 'taken')
    await h.begin(a, [first])
    await h.prepare(a)
    assert.equal(h.recalls.length, 1)
})

const proactive = (reason: string) => ChatMessage.notice('timer', '[wake] ' + reason, {
    meta: { wake: { by: 'timer', reason } }
})

it('uses the target DM rule on the first scheduled wake before any chat is observed', async (t) => {
    const ctx = new Context()
    t.after(() => ctx.fiber.dispose())
    await ctx.plugin(SchemaRegistry)
    await ctx.plugin(Routing)
    registerRouteSettings(ctx)
    const dm = { platform: 'test', selfId: 'bot', guildId: 'g', channelId: 'private', isDirect: true, userId: 'bob' }
    ctx.provide('chat')
    ctx.set('chat', { environmentOf: (id: string) => id === 'session-1' ? dm : undefined } as never)
    ctx.provide('chat_observer')
    ctx.set('chat_observer', { identityOfConversation: () => undefined } as never)
    await ctx.routing.save({ id: 'dm', filter: { kind: 'scope', field: 'route', values: [routeIdOf(dm)] },
        values: { livingmemory: { enableConversationIsolation: true } } })
    await ctx.routing.save({ id: 'bob', filter: { kind: 'scope', field: 'user', values: ['bob'] },
        values: { livingmemory: { enableUserProfileInjection: true } } })

    const h = createHarness({ settingsOf: (...args) => routeSettings(ctx, ...args) })
    const agent = h.agent(1, 'test-engine')
    agent.options.location = { platform: 'test', selfId: 'bot', channel: 'private', isDirect: true }
    const timer = proactive('scheduled')
    await h.input(agent, timer, 'queued')
    await h.engineTurn(agent, 1, [timer])
    const settings = h.hooks.settingsForTurn(agent)
    assert.equal(settings?.enableConversationIsolation, true)
    assert.equal(settings.enableUserProfileInjection, false)
})

it('captures each proactive wake at enqueue and shares the first window with profiles', async () => {
    const h = createHarness({ rules: { enableUserProfileInjection: true } })
    const agent = h.agent(1, 'test-engine')
    await h.observed(1, 'quiet chat', { userId: 'alice' })
    const quiet = foldedChat(1, 'alice')
    await h.input(agent, quiet, 'queued')
    assert.equal(h.recalls.length, 0)

    // 这条旁听消息不在 Agent 输入中，但属于通知发出时的频道聊天。
    await h.observed(2, 'before notice', { userId: 'charlie' })
    const timer = proactive('scheduled')
    const queued = h.input(agent, timer, 'queued')
    await h.observed(3, 'after notice', { userId: 'bob' })
    await queued
    assert.deepEqual(h.recalls.map(call => call.history.map(m => m.contentLines)), [[['quiet chat'], ['before notice']]])

    // 首条通知尚在队列，第二个独立 wake 应以自己的时间截取窗口。
    const idle = proactive('idle')
    await h.input(agent, idle, 'queued')
    assert.deepEqual(h.recalls.map(call => call.position), [1, 2])
    assert.deepEqual(h.recalls[1].history.map(m => m.contentLines), [['quiet chat'], ['before notice'], ['after notice']])
    for (const input of [quiet, timer, idle]) await h.input(agent, input, 'taken')
    await h.engineTurn(agent, 1, [quiet, timer, idle])
    await h.prepare(agent)
    assert.equal(h.recalls.length, 2)
    assert.deepEqual(h.profiles, [['alice', 'charlie'].map(id => createSpeakerKey('onebot', id))])
})

it('does not recall for a notice without a wake', async () => {
    const h = createHarness()
    const agent = h.agent()
    await h.observed(1, 'existing chat')
    const notice = ChatMessage.notice('timer', 'status')
    await h.input(agent, notice, 'queued')
    await h.input(agent, notice, 'taken')
    await h.begin(agent, [notice])
    await h.prepare(agent)
    assert.equal(h.recalls.length, 0)
})

it('advances the recall interval with actual chats, never with repeated proactive notices', async () => {
    const inputs: string[] = []
    const h = createHarness({ recallInterval: 2, onRecallModel: input => inputs.push(input) })
    const agent = h.agent()
    const wake = async () => {
        const notice = proactive('idle')
        await h.input(agent, notice, 'queued')
        await h.input(agent, notice, 'taken')
        await settle()
    }
    await h.observed(1, 'first chat')
    await wake()
    assert.equal(inputs.length, 1)
    await wake()
    await wake()
    assert.equal(inputs.length, 1)
    await h.observed(2, 'second chat')
    await wake()
    assert.equal(inputs.length, 1)
    await h.observed(3, 'third chat')
    await wake()
    assert.equal(inputs.length, 2)
    assert.match(inputs[1], /third chat/u)
    assert.doesNotMatch(inputs[1], /idle/u)
})

it('logs a failed enqueue lookup once, skips it at turn start and recovers on the next wake', async () => {
    const h = createHarness()
    h.switch(undefined)
    const agent = h.agent(1, 'test-engine')
    await h.observed(1, 'first chat', { userId: 'alice' })
    const first = foldedChat(1, 'alice', direct)
    h.setCurrent(Promise.reject(new Error('scope lookup failed')))
    await h.input(agent, first, 'queued')
    assert.equal(h.warnings.length, 1)
    const lookups = h.scopeLookups
    h.setCurrent(Promise.resolve())
    h.switch('preset-2')
    await h.input(agent, first, 'taken')
    await h.engineTurn(agent, 1, [first])
    assert.equal(h.scopeLookups, lookups, 'a failed lookup is terminal for this wake')
    assert.equal(h.warnings.length, 1)
    assert.equal(h.recalls.length, 0)

    await h.observed(2, 'next chat', { userId: 'bob' })
    const next = foldedChat(2, 'bob', direct)
    await h.input(agent, next, 'queued')
    await h.input(agent, next, 'taken')
    await h.engineTurn(agent, 2, [next])
    assert.equal(h.recalls.length, 1)
    assert.equal(h.recalls[0].position, 1)
    assert.equal(h.warnings.length, 1)
})

it('defers a wake without a preset and uses its original chat when the preset is ready', async (t) => {
    const h = createHarness()
    h.switch(undefined)
    const agent = h.agent(1, 'test-engine')
    await h.observed(1, 'original question', { userId: 'alice' })
    const wake = foldedChat(1, 'alice', direct)
    await h.input(agent, wake, 'queued')
    assert.equal(h.recalls.length, 0)
    h.framework.messages.splice(0)
    await h.observed(2, 'later chat', { userId: 'bob' })
    h.switch('preset-2')
    await h.input(agent, wake, 'taken')
    const reads = t.mock.method(h.framework, 'recentOfConversation')
    await h.engineTurn(agent, 1, [wake])
    assert.equal(reads.mock.callCount(), 0)
    assert.deepEqual(h.recalls.map(call => call.scope.presetId), ['preset-2'])
    assert.deepEqual(h.recalls[0].history.map(message => message.contentLines), [['original question']])
    assert.equal(h.warnings.length, 0)
})

it('keeps a queued recall in its original preset after a switch before engine-turn', async () => {
    const h = createHarness({ rules: { enableUserProfileInjection: true } })
    const agent = h.agent(1, 'test-engine')
    await h.observed(1, 'question in A', { userId: 'alice' })
    const input = foldedChat(1, 'alice', direct)
    await h.input(agent, input, 'queued')
    await settle()
    assert.deepEqual(h.recalls.map(call => call.scope.presetId), ['preset-1'])
    h.switch('preset-2')
    await h.input(agent, input, 'taken')
    await h.engineTurn(agent, 1, [input])
    assert.equal(await h.prepare(agent), undefined)
    assert.deepEqual(h.recalls.map(call => call.scope.presetId), ['preset-1'])
    assert.deepEqual(h.profiles.flat(), [])
})

it('keeps the group settings and leaves the window empty when the trigger was evicted', async () => {
    const h = createHarness({ rules: { enableUserProfileInjection: true, recallHistoryMessages: 1 } })
    await h.observed(1, 'alice', { userId: 'alice' })
    await h.observed(2, 'bob', { userId: 'bob' })
    h.framework.messages.shift()
    const batch = absorb(absorb(undefined, foldedChat(1, 'alice', direct), 1), foldedChat(2, 'bob', direct), 2)
    const a = h.agent(1, 'test-engine')
    await h.engineTurn(a, 1, [batch])
    assert.equal(h.hooks.settingsForTurn(a)?.enableUserProfileInjection, true)
    assert.equal(h.recalls.length, 0)
    await h.prepare(a)
    assert.deepEqual(h.profiles.flat(), [])
})

it('still injects profiles from the triggering window when recall is disabled', async () => {
    const h = createHarness({ rules: { enableUserProfileInjection: true, recallIntervalMessages: 0, recallHistoryMessages: 1 } })
    await h.observed(1, 'question', { userId: 'alice' })
    await h.observed(2, 'later', { userId: 'bob' })
    const a = h.agent(1, 'test-engine')
    await h.engineTurn(a, 1, [foldedChat(1, 'alice', direct), foldedChat(2, 'bob')])
    h.framework.messages.splice(0)
    await h.prepare(a)
    assert.deepEqual(h.profiles, [[createSpeakerKey('onebot', 'alice')]])
    assert.equal(h.recalls.length, 0)
})
