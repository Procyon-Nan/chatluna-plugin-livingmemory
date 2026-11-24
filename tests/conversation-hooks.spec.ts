import assert from 'node:assert/strict'
import { Context } from 'cordis'
import Routing from '@chatluna/routing'
import SchemaRegistry from '@chatluna/ui-schema-registry'
import { routeIdOf } from '@chatluna/satori'
import { registerRouteSettings, routeSettings, ROUTE_SCHEMA } from '../src/routing.ts'
import type { SnapshotRepository } from '../src/contracts/workflows.ts'
import { withLivingMemoryRepository } from './persistence-test-utils.ts'
import type { RouteSettings } from '../src/routing.ts'
import type { Agent, TurnReason } from '@chatluna/agent'
import { ChatMessage, contentText } from '@chatluna/message'
import { CallId, ModelId, ProviderId } from '@chatluna/symbol'
import { absorb } from '@chatluna/chat-observer'
import { createSpeakerKey } from '../src/service/memory/speaker_identity.ts'
import { LivingMemoryRecallCoordinator } from '../src/service/workflows/recall/coordinator.ts'
import { LivingMemoryConversationHooks } from '../src/service/conversation_hooks.ts'
import { LivingMemoryChatHistory } from '../src/service/chat_history.ts'
import type { ChatHistoryScope } from '../src/service/chat_history.ts'
import type { LivingMemoryTranscriptMessage } from '../src/contracts/memory.ts'
import { createCapturedLogger, createJobStore, createSnapshotItem } from './workflow-test-utils.ts'
import { FrameworkHistoryFixture, historyMessage } from './chat-history-test-utils.ts'

const settle = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))
}
const model = { provider: ProviderId('test'), model: ModelId('chat') }

function createHarness(config: {
    conversationKey?: string
    overheard?: boolean
    extractionWindow?: number
    recallInterval?: number
    snapshots?: Pick<SnapshotRepository, 'getLatestSnapshotByScope'>
    rules?: Partial<RouteSettings>
    settingsOf?: ConstructorParameters<typeof LivingMemoryConversationHooks>[1]['settingsOf']
    onRecallModel?: (input: string) => void | Promise<void>
} = {}) {
    const framework = new FrameworkHistoryFixture(config.conversationKey)
    const listeners = new Map<string, ((payload: any) => unknown)[]>()
    const recalls: { scope: ChatHistoryScope; history: LivingMemoryTranscriptMessage[]; position: number }[] = []
    const extractions: { scope: ChatHistoryScope; boundary: number; eligible?: number }[] = []
    const cleared: string[] = []
    const profiles: string[][] = []
    const order: string[] = []
    let snapshotText = ''
    let presetId: string | undefined = 'preset-1'
    let headPresetId: string | undefined = presetId
    let liveAgent: Agent | undefined
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
        on: (name: string, listener: (payload: unknown) => unknown) => {
            const entries = listeners.get(name) ?? []
            entries.push(listener)
            listeners.set(name, entries)
            return () => listeners.set(name, entries.filter((entry) => entry !== listener))
        },
        presets: { get: () => ({ name: '所长' }) },
        conversations: {
            current: async () => { scopeLookups++; await currentGate; return { sessionId, presetId: headPresetId } },
            live: () => liveAgent && { agent: liveAgent }
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
        }, { run: async (_settings, _scope, input) => { await onModel(input); return null } }, captured.logger) : {
            queue: async (_settings: unknown, scope: ChatHistoryScope,
                history: LivingMemoryTranscriptMessage[], position: number) => {
                recalls.push({ scope, history, position })
            },
            clearByConversation: (key: string) => cleared.push(key)
        } as never,
        extraction: {
            queue: async (scope: ChatHistoryScope, _options: unknown,
                boundary: number, eligible?: number) => {
                order.push('extract')
                extractions.push({ scope, boundary, eligible })
            },
            clearByConversation: () => {}
        } as never,
        userProfiles: { renderForSpeakers: async (_preset: string, keys: string[]) => { profiles.push(keys); return keys.length ? '测试画像' : '' } } as never,
        repository: config.snapshots ?? { getLatestSnapshotByScope: async () => snapshotText === '' ? undefined : {
            items: [{ finalText: snapshotText, matchedMemories: [], toolCallSummary: { searchTexts: [], searchKeywords: [], maxCandidates: 0 } }]
        } as never },
        logger: captured.logger,
        settingsOf: config.settingsOf ?? (() => ({
            enableAutoDream: true, enableConversationIsolation: false, snapshotScope: 'conversation', snapshotMaxLines: 5,
            enableSnapshotInjection: true, enableUserProfileInjection: false,
            recallIntervalMessages: config.recallInterval ?? 1, recallHistoryMessages: 20,
            extractionWindowMessages: config.extractionWindow ?? 2,
            extractionIncludeOverheard: config.overheard ?? false,
            ...config.rules
        }))
    })
    const dispose = hooks.register()
    const agent = (turn = 1, engine?: string) => ({
        options: { conversationKey: framework.conversationKey, presetId, engine },
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
        begin: (agent: Agent, input: number | ChatMessage[]) => emit('agent/before-turn', {
            agent, turn: agent.session.lastTurn, input: typeof input === 'number' ? [user(input)] : input,
            signal: new AbortController().signal
        }),
        request: async (agent: Agent, history: readonly ChatMessage[] = [], attempt = 1) => {
            const messages = Object.freeze([...history])
            const appended: ChatMessage[] = []
            await emit('agent/before-request', {
                agent, messages, attempt,
                append: (...items: ChatMessage[]) => appended.push(...items)
            })
            return [...messages, ...appended]
        },
        send: (ids: number[], turn = 1, originPreset = presetId, routeId = 'route') => emit('send', {
            routeId,
            chatSent: { own: true, reply: { conversationKey: framework.conversationKey, sessionId, presetId: originPreset, turn },
                messageIds: ids.map(id => 'm-' + id) }
        }),
        observed: async (id: number, text: string, overrides: Parameters<typeof historyMessage>[2] = {}) => {
            const message = historyMessage(id, text, overrides)
            framework.messages.push(message)
            emit('chatluna/observed', { conversationKey: framework.conversationKey, sessionId, message })
            await settle()
        },
        turn: async (target: Agent, reason: TurnReason = 'completed') => { emit('chatluna/agent-turn', { agent: target, reason }); await settle() },
        switch: (nextPreset: string | undefined, nextSession = sessionId) => {
            const previous = { sessionId, presetId: headPresetId }
            presetId = nextPreset
            headPresetId = nextPreset
            sessionId = nextSession
            emit('chatluna/conversation-change', {
                conversationKey: framework.conversationKey, previous, current: { sessionId, presetId },
                reason: sessionId === previous.sessionId ? 'preset' : 'reset'
            })
        },
        setSnapshot: (text: string) => { snapshotText = text },
        setHeadPreset: (value: string | undefined) => { headPresetId = value },
        setLiveAgent: (value: Agent | undefined) => { liveAgent = value },
        setDrain: (gate: Promise<unknown>) => { drainGate = gate },
        setCurrent: (gate: Promise<unknown>) => { currentGate = gate }
    }
}

describe('LivingMemoryConversationHooks', () => {
    it('uses the active preset display name for a bot mention in the waking chat', async () => {
        const h = createHarness()
        h.framework.messages.push(historyMessage(1, '@self 想我什么呀'))
        const agent = h.agent()
        await h.begin(agent, 1)
        await h.send([2])
        await h.observed(2, '答', { self: true })
        await h.turn(agent)
        assert.equal(h.recalls[0].scope.presetId, 'preset-1')
        assert.deepEqual(h.recalls[0].history[0].contentLines, ['@所长 想我什么呀'])
    })

    it('uses the waking route when two channels sharing a custom key reuse a platform message id', async () => {
        const h = createHarness({ conversationKey: 'custom:test', rules: { enableConversationIsolation: true } })
        const agent = h.agent()
        h.framework.messages.push(
            historyMessage(1, '乙群上一条', { cid: 'channel:B', routeId: 'B' }),
            historyMessage(2, '乙群唤醒', { cid: 'channel:B', routeId: 'B', platformMessageId: 'same' }),
            historyMessage(3, '甲群稍后的消息', { cid: 'channel:A', routeId: 'A', platformMessageId: 'same' })
        )
        await h.begin(agent, [ChatMessage.user('乙群唤醒', {
            source: { kind: 'user', routeId: 'B' }, meta: { externalId: 'same' }
        })])
        assert.equal(h.hooks.contextForTurn(agent)?.routeId, 'B')
        await h.send([4], 1, undefined, 'B')
        await h.observed(4, '甲群同号回执', { self: true, routeId: 'A', cid: 'channel:A' })
        await h.observed(4, '乙群答复', { self: true, routeId: 'B', cid: 'channel:B' })
        await h.turn(agent)
        assert.deepEqual(h.recalls[0].history.map(row => row.contentLines), [['乙群上一条'], ['乙群唤醒'], ['乙群答复']])
    })

    it('injects the selected snapshot even with automatic recall disabled', async () => {
        await withLivingMemoryRepository(async (_ctx, repository) => {
            for (const [conversationId, text] of [[null, '群 A 的更新'], ['conv-1', '本会话']] as const) {
                await repository.upsertSnapshot({ presetId: 'preset-1', conversationId }, '', [createSnapshotItem(text)])
            }
            for (const [snapshotScope, isolation, expected] of [
                ['preset', false, '群 A 的更新'],
                ['preset', true, '本会话'],
                ['conversation', false, '本会话']
            ] as const) {
                const h = createHarness({ snapshots: repository, rules: {
                    snapshotScope, enableConversationIsolation: isolation, recallIntervalMessages: 0
                } })
                const agent = h.agent()
                await h.begin(agent, 1)
                const [injection] = await h.request(agent)
                assert.equal(contentText(injection.content), `<memory>\n${expected}\n</memory>`)
                await h.send([2])
                await h.observed(2, 'answer', { self: true })
                await h.turn(agent)
                assert.deepEqual(h.recalls, [])
            }
        })
    })

    it('appends one snapshot with profiles and reuses it after tools and on retry', async () => {
        const h = createHarness({ rules: { enableUserProfileInjection: true } })
        await h.observed(1, '问')
        h.setSnapshot('用户喜欢红茶')
        const agent = h.agent()
        const user = h.user(1)
        await h.begin(agent, [user])
        const history = [user]
        const first = await h.request(agent, history)
        assert.deepEqual(first.slice(0, -1), [user])
        const snapshot = first[1]
        assert.equal(contentText(snapshot.content), '<memory>\n用户喜欢红茶\n</memory>\n\n<users_profile>\n测试画像\n</users_profile>')

        h.setSnapshot('更新后的记忆')
        const callId = CallId('call-1')
        const toolCall = ChatMessage.assistant([{ type: 'tool-call', toolCallId: callId, toolName: 'lookup', input: {} }], model)
        const toolResult = ChatMessage.tool(callId, 'lookup', { type: 'text', value: '查询结果' })
        const afterTool = [user, toolCall, toolResult]
        assert.deepEqual(await h.request(agent, afterTool), [...afterTool, snapshot])
        assert.deepEqual(await h.request(agent, afterTool, 2), [...afterTool, snapshot])
        assert.equal(h.profiles.length, 1)
    })

    it('reads new content on the next turn and stops appending after a preset switch', async () => {
        const h = createHarness()
        const agent = h.agent()
        const first = h.user(1)
        const second = h.user(2)
        h.setSnapshot('第一轮')
        await h.begin(agent, [first])
        const initial = await h.request(agent, [first])
        assert.equal(contentText(initial[1].content), '<memory>\n第一轮\n</memory>')
        await h.turn(agent)

        h.setSnapshot('第二轮')
        await h.engineTurn(agent, 2, [second])
        const reply = ChatMessage.assistant('答复', model)
        const notice = ChatMessage.notice('chatluna:character', '本轮通知')
        const history = [first, reply, second, notice]
        const sent = await h.request(agent, history)
        assert.deepEqual(sent.slice(0, -1), history)
        assert.equal(contentText(sent.at(-1)!.content), '<memory>\n第二轮\n</memory>')

        h.switch('preset-2')
        assert.deepEqual(await h.request(agent, history), history)
    })

    it('serves the last ready snapshot while a post-reply recall is still running', async () => {
        const gate = Promise.withResolvers<void>()
        const saved = Promise.withResolvers<void>()
        const h = createHarness({ onRecallModel: async () => {
            await gate.promise
            h.setSnapshot('updated')
            saved.resolve()
        } })
        h.setSnapshot('old')
        await h.observed(1, 'question')
        const agent = h.agent()
        await h.begin(agent, 1)
        await h.send([2])
        await h.observed(2, 'answer', { self: true })
        await h.turn(agent)

        await h.observed(3, 'quick follow-up')
        await h.engineTurn(agent, 2, 3)
        const [old] = await h.request(agent)
        assert.equal(contentText(old.content), '<memory>\nold\n</memory>')
        gate.resolve()
        await saved.promise
        assert.deepEqual(await h.request(agent), [old])
        await h.turn(agent)
        await h.observed(4, 'next question')
        await h.engineTurn(agent, 3, 4)
        const [updated] = await h.request(agent)
        assert.equal(contentText(updated.content), '<memory>\nupdated\n</memory>')
    })

    it('leaves existing history untouched when there is nothing to append', async () => {
        const h = createHarness()
        const agent = h.agent()
        const user = ChatMessage.user('<memory>用户输入</memory>')
        const old = ChatMessage.notice('chatluna:livingmemory', '旧快照')
        await h.begin(agent, [user])
        assert.deepEqual(await h.request(agent, [old, user]), [old, user])
    })

    it('uses the actual input batch while a later user message is already recorded', async () => {
        const harness = createHarness({ rules: { enableUserProfileInjection: true } })
        await harness.observed(10, 'earlier')
        await harness.observed(30, 'current', { userId: 'current' })
        await harness.observed(50, 'queued next', { userId: 'next' })
        const agent = harness.agent()
        await harness.begin(agent, [harness.user(30), harness.user(50)])
        await harness.request(agent)
        assert.deepEqual(harness.profiles, [['user-1', 'current'].map(id => createSpeakerKey('onebot', id))])
    })

    it('uses the first wake after quiet chat even when a later input mentions the bot', async () => {
        const h = createHarness({ rules: { enableUserProfileInjection: true, enableConversationIsolation: true } })
        for (const id of [1, 2, 3]) await h.observed(id, 'chat', { userId: 'u' + id })
        const ordinary = ChatMessage.user('ordinary wake', { meta: { externalId: 'm-2', wake: { by: 'activity', reason: 'activity' } } })
        const mention = ChatMessage.user('later @', { meta: { externalId: 'm-3', wake: { by: 'chat', reason: 'at-me', direct: true } } })
        const agent = h.agent()
        await h.begin(agent, [h.user(1), ordinary, mention])
        await h.request(agent)
        assert.deepEqual(h.profiles, [['u1', 'u2'].map(id => createSpeakerKey('onebot', id))])
        assert.equal(h.hooks.contextForTurn(agent)?.settings.enableConversationIsolation, true)
    })

    it('locates the original chat in a folded envelope and excludes notices', async () => {
        const harness = createHarness({ rules: { enableUserProfileInjection: true } })
        await harness.observed(10, '问')
        const folded = ChatMessage.user([{
            type: 'envelope', kind: 'message', id: 'route:m-10', externalId: 'm-10',
            sender: { id: 'user-1' }, time: 1_010, content: [{ type: 'text', text: '问' }]
        }])
        const agent = harness.agent()
        await harness.begin(agent, [folded, ChatMessage.notice('internal', 'notice')])
        await harness.request(agent)
        assert.deepEqual(harness.profiles, [[createSpeakerKey('onebot', 'user-1')]])
        const next = harness.agent(2)
        await harness.begin(next, [ChatMessage.notice('wake', 'proactive wake'), ChatMessage.user('internal steer')])
        assert.deepEqual(await harness.request(next), [])
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
        const oldAgent = harness.agent(1, 'test-engine')
        await harness.engineTurn(oldAgent, 1, 10)
        harness.switch('preset-1', 'session-2')
        await harness.observed(80, 'new history')
        await harness.engineTurn(oldAgent, 2, 10)
        assert.equal(harness.hooks.contextForTurn(oldAgent), undefined, 'a late old agent cannot reclaim the conversation')
        const agent = harness.agent()
        await harness.begin(agent, 80)
        harness.send([90], 1)
        await harness.observed(90, 'new reply', { self: true })
        await harness.turn(agent)
        assert.deepEqual(harness.recalls.map(call => call.history.map(m => m.contentLines)), [[['new history'], ['new reply']]])
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

    it('starts overheard counting only once the session has a known preset, even with an empty head preset', async () => {
        const h = createHarness({ overheard: true })
        h.setHeadPreset(undefined)
        await h.observed(1, 'cold chat')
        assert.equal(h.extractions.length, 0)

        const agent = h.agent(1, 'test-engine')
        h.setLiveAgent(agent)
        await h.observed(2, 'first attributed chat')
        h.setLiveAgent(undefined)
        await h.observed(3, 'another chat in the same session')
        assert.deepEqual(h.extractions.map(({ scope, boundary, eligible }) => [scope.presetId, boundary, eligible]), [
            ['preset-1', 0, 1], ['preset-1', 0, 2]
        ])

        h.switch(undefined, 'session-2')
        h.setLiveAgent(agent)
        await h.observed(4, 'chat after reset')
        assert.equal(h.extractions.length, 2, 'the previous session’s live agent cannot identify the new session')
    })

    it('waits for full rendering and history commit before recall and extraction', async () => {
        const harness = createHarness({ rules: { recallHistoryMessages: 2 } })
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
        assert.equal(harness.recalls.length, 0)
        release()
        await settle()
        assert.deepEqual(harness.order, ['drain', 'extract'])
        assert.equal(harness.extractions[0].eligible, 2)
        assert.deepEqual(harness.recalls.map(call => call.history.map(m => m.contentLines)), [
            [['first split reply'], ['second split reply']]
        ])
    })

    it('does not use another message when the final reply has no transcript', async () => {
        const h = createHarness()
        await h.observed(1, 'question')
        const agent = h.agent()
        await h.begin(agent, 1)
        await h.send([2])
        await h.observed(2, '', { self: true, content: [] })
        await h.turn(agent)
        assert.deepEqual(h.recalls, [])
    })

    it('waits for observation after drain and counts a multi-ID send only once', async () => {
        const harness = createHarness({ overheard: true })
        await harness.observed(10, 'question')
        const agent = harness.agent()
        await harness.begin(agent, 10)
        harness.send([20, 21])
        await harness.turn(agent)
        assert.equal(harness.recalls.length, 0)
        await harness.observed(20, 'reply', { self: true })
        await harness.observed(21, 'reply', { self: true })
        assert.deepEqual(harness.extractions.map(x => x.eligible), [0, 1])
        assert.deepEqual(harness.recalls.map(x => x.position), [1])
    })

    it('anchors recall to the last segment sent when its observer event arrives first', async () => {
        const h = createHarness()
        const agent = h.agent()
        await h.observed(1, 'question')
        await h.begin(agent, 1)
        await h.send([2])
        await h.send([3])
        await h.turn(agent)
        await h.observed(3, 'last sent', { self: true })
        assert.equal(h.recalls.length, 0)
        await h.observed(2, 'first sent', { self: true })
        assert.deepEqual(h.recalls.map(call => call.history.at(-1)?.contentLines), [['last sent']])
        assert.deepEqual(h.extractions.map(call => call.eligible), [2])
    })

    it('attributes a direct engine reply even when the engine does not request a model', async () => {
        const harness = createHarness()
        await harness.observed(1, 'question')
        const agent = harness.agent(7, 'test-engine')
        await harness.begin(agent, 1)
        assert.equal(harness.recalls.length, 0, 'wait for the engine to resolve its preset')
        await harness.engineTurn(agent, 7, 1)
        assert.equal(harness.recalls.length, 0)
        harness.send([2], 7)
        await harness.observed(2, 'direct answer', { self: true })
        await harness.turn(agent)
        assert.deepEqual(harness.recalls.map(call => call.history.map(m => m.contentLines)), [[['question'], ['direct answer']]])
        assert.deepEqual(harness.extractions.map(x => x.eligible), [1])
    })

    it('does not trigger recall or normal extraction for a turn without an actually delivered reply', async () => {
        const harness = createHarness()
        await harness.observed(10, 'question')
        const agent = harness.agent()
        await harness.begin(agent, 10)
        await harness.turn(agent)
        assert.equal(harness.extractions.length, 0)
        assert.equal(harness.recalls.length, 0)
    })

    it('does not recall from a partial reply on an interrupted turn', async () => {
        const h = createHarness()
        await h.observed(1, 'question')
        const agent = h.agent()
        await h.begin(agent, 1)
        await h.send([2])
        await h.observed(2, 'partial reply', { self: true })
        await h.turn(agent, 'aborted')
        assert.deepEqual(h.recalls, [])
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
        const agent = harness.agent()
        await harness.begin(agent, 30)
        await harness.send([40])
        await harness.observed(40, 'new reply', { self: true })
        await harness.turn(agent)
        assert.equal(harness.recalls[0].scope.presetId, 'preset-2')
    })

    it('disables extraction at zero and drops pending delivery callbacks after disposal', async () => {
        const disabled = createHarness({ extractionWindow: 0 })
        await disabled.observed(10, 'question')
        const disabledAgent = disabled.agent()
        await disabled.begin(disabledAgent, 10)
        await disabled.send([20])
        await disabled.observed(20, 'answer', { self: true })
        await disabled.turn(disabledAgent)
        assert.equal(disabled.extractions.length, 0)
        assert.equal(disabled.recalls.length, 1)

        const harness = createHarness()
        let release!: () => void
        harness.setDrain(new Promise<void>((resolve) => { release = resolve }))
        await harness.observed(10, 'question')
        const agent = harness.agent()
        await harness.begin(agent, 10)
        await harness.send([20])
        await harness.observed(20, 'answer', { self: true })
        await harness.turn(agent)
        harness.dispose()
        release()
        await settle()
        assert.equal(harness.extractions.length, 0)
        assert.equal(harness.recalls.length, 0)
    })
})

const foldedChat = (id: number, sender: string, wake?: { by: string; reason: string; direct?: true }) =>
    ChatMessage.user('chat', { meta: { externalId: 'm-' + id, sender: { id: sender }, wake: wake && { ...wake } } })
const direct = { by: 'chat', reason: 'at-me', direct: true } as const

it('freezes Alice’s triggering window on enqueue across folded inputs, buffer rollover and model steps', async () => {
    const h = createHarness({ rules: {
        enableUserProfileInjection: true, enableConversationIsolation: true, recallHistoryMessages: 2
    } })
    h.setHeadPreset(undefined)
    await h.observed(0, 'earlier', { userId: 'dave' })
    await h.observed(1, 'question', { userId: 'alice' })
    const a = h.agent(1, 'test-engine')
    const firstInput = absorb(undefined, foldedChat(1, 'alice', direct), 1)
    // 入队通知是同步的，排队等待开轮期间原记录可以滚出缓冲。
    const queued = h.input(a, firstInput, 'queued')
    h.framework.messages.splice(0, 2)
    await queued
    await settle()
    await h.observed(2, 'same batch', { userId: 'bob' })
    const batch = absorb(firstInput, foldedChat(2, 'bob', direct), 2)
    // 框架合批时先丢弃旧信封，再把含两条消息的新信封入队。
    await Promise.all([h.input(a, firstInput, 'dropped'), h.input(a, batch, 'queued')])
    await h.input(a, batch, 'taken')
    await h.engineTurn(a, 1, [batch])
    assert.equal(h.hooks.contextForTurn(a)?.settings.enableConversationIsolation, true)

    await h.observed(3, 'queued next', { userId: 'alice' })
    const first = await h.request(a, [h.user(3)])
    assert.equal(contentText(first.at(-1)!.content), '<users_profile>\n测试画像\n</users_profile>')
    assert.equal((await h.request(a)).at(-1), first.at(-1))
    assert.deepEqual(h.profiles, [['dave', 'alice'].map(id => createSpeakerKey('onebot', id))])

    // Bob 留在频道历史中，下次有真实触发时可进入该轮窗口。
    await h.engineTurn(a, 2, 3)
    await h.request(a)
    assert.deepEqual(h.profiles[1], ['bob', 'alice'].map(id => createSpeakerKey('onebot', id)))
    assert.equal(h.recalls.length, 0)
    h.switch('preset-2')
    assert.equal(h.hooks.contextForTurn(a), undefined)
    const nextInput = h.user(3)
    assert.deepEqual(await h.request(a, [nextInput]), [nextInput])
})

it('captures a bare agent’s profile window on enqueue and reuses it at turn start', async () => {
    const h = createHarness({ rules: { enableUserProfileInjection: true } })
    const a = h.agent()
    await h.observed(1, 'question', { userId: 'alice' })
    const first = foldedChat(1, 'alice', direct)
    const queued = h.input(a, first, 'queued')
    h.framework.messages.splice(0)
    await queued
    await settle()
    await h.input(a, first, 'taken')
    await h.begin(a, [first])
    await h.request(a)
    assert.deepEqual(h.profiles, [[createSpeakerKey('onebot', 'alice')]])
})

const proactive = (reason: string) => ChatMessage.notice('timer', '[wake] ' + reason, {
    meta: { wake: { by: 'timer', reason } }
})

it('matches a custom wake against the current channel rather than the group that opened the agent', async t => {
    const ctx = new Context()
    t.after(() => ctx.fiber.dispose())
    await ctx.plugin(SchemaRegistry)
    await ctx.plugin(Routing)
    registerRouteSettings(ctx)
    const identity = { platform: 'test', selfId: 'bot', guildId: 'B', channelId: 'B', userId: 'person', isDirect: false }
    const route = routeIdOf(identity)
    const observer = new FrameworkHistoryFixture('custom:test')
    observer.channel = { routeId: route, identity }
    ctx.provide('chat_observer')
    ctx.set('chat_observer', observer as never)
    await ctx.routing.save({ id: 'B', filter: { kind: 'scope', field: 'guild', values: ['B'] },
        values: { livingmemory: { enableConversationIsolation: true } } })
    const firstGroup = { platform: 'test', selfId: 'bot', guild: 'A', channel: 'A', isDirect: false }
    assert.equal(routeSettings(ctx, 'custom:test', firstGroup, route).enableConversationIsolation, true)
})

it('keeps conversation snapshots available on an unaddressed custom wake without starting a recall', async () => {
    const h = createHarness({ conversationKey: 'custom:test', rules: { enableConversationIsolation: true, enableSnapshotInjection: true } })
    h.setSnapshot('该会话的快照')
    const agent = h.agent()
    h.framework.messages.push(historyMessage(1, '来自其他群', { cid: 'channel:B', routeId: 'B' }))
    const wake = proactive('定时提醒')
    await h.input(agent, wake, 'queued')
    await h.begin(agent, [wake])
    assert.equal(h.recalls.length, 0)
    const [injection] = await h.request(agent)
    assert.equal(contentText(injection.content), '<memory>\n该会话的快照\n</memory>')
})

it('uses the actual reply route for recall when a scheduled custom wake has no route', async () => {
    const h = createHarness({ conversationKey: 'custom:test', settingsOf: (_key, _location, route) =>
        ROUTE_SCHEMA.parse({ enableConversationIsolation: route === 'B', recallIntervalMessages: route === 'B' ? 1 : 0 })
    })
    h.framework.messages.push(historyMessage(1, 'elsewhere', { routeId: 'A' }))
    const agent = h.agent()
    const notice = proactive('scheduled')
    await h.input(agent, notice, 'queued')
    await h.begin(agent, [notice])
    await h.send([2], 1, undefined, 'B')
    await h.observed(2, 'scheduled reply', { self: true, routeId: 'B' })
    await h.turn(agent)
    assert.deepEqual(h.recalls.map(call => call.history.map(m => m.contentLines)), [[['scheduled reply']]])
})

it('uses the private peer for injection and waits for reply delivery to schedule memory work', async t => {
    const ctx = new Context()
    t.after(() => ctx.fiber.dispose())
    await ctx.plugin(SchemaRegistry)
    await ctx.plugin(Routing)
    registerRouteSettings(ctx)
    const h = createHarness({ settingsOf: (...args) => routeSettings(ctx, ...args) })
    const identity = { platform: 'onebot', selfId: 'bot', isDirect: true, userId: 'owner' }
    const routeId = routeIdOf(identity)
    h.framework.channel = { routeId, identity }
    ctx.provide('chat_observer')
    ctx.set('chat_observer', h.framework as never)
    await ctx.routing.save({ id: 'global', values: { livingmemory: {
        extractionWindowMessages: 0, recallIntervalMessages: 0, enableSnapshotInjection: false,
        enableUserProfileInjection: false, extractionIncludeOverheard: true
    } } })
    await ctx.routing.save({ id: 'owner-dm', filter: { kind: 'and', operands: [
        { kind: 'direct' }, { kind: 'scope', field: 'user', values: ['owner'] }
    ] }, values: { livingmemory: {
        extractionWindowMessages: 10, recallIntervalMessages: 10, enableSnapshotInjection: true, enableUserProfileInjection: true
    } } })
    h.setSnapshot('已有快照')
    for (let id = 1; id <= 10; id++) await h.observed(id, '私聊消息', { routeId, userId: 'owner' })
    assert.equal(h.extractions.length, 0)
    const agent = h.agent()
    agent.options.location = { platform: 'onebot', selfId: 'bot', isDirect: true }
    await h.begin(agent, 10)
    const [injection] = await h.request(agent)
    assert.equal(contentText(injection.content), '<memory>\n已有快照\n</memory>\n\n<users_profile>\n测试画像\n</users_profile>')
    await h.send([11], 1, undefined, routeId)
    await h.observed(11, '回复', { self: true, routeId })
    assert.deepEqual([h.extractions.length, h.recalls.length], [0, 0])
    await h.turn(agent)
    assert.deepEqual([h.extractions.length, h.recalls.length], [1, 1])
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
    ctx.set('chat_observer', { channelOf: () => undefined } as never)
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
    const settings = h.hooks.contextForTurn(agent)?.settings
    assert.equal(settings?.enableConversationIsolation, true)
    assert.equal(settings.enableUserProfileInjection, true)
})

it('uses the first proactive wake for profiles without recalling on either notification', async () => {
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

    const idle = proactive('idle')
    await h.input(agent, idle, 'queued')
    for (const input of [quiet, timer, idle]) await h.input(agent, input, 'taken')
    await h.engineTurn(agent, 1, [quiet, timer, idle])
    await h.request(agent)
    assert.equal(h.recalls.length, 0)
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
    await h.request(agent)
    assert.equal(h.recalls.length, 0)
})

it('checks the recall interval after delivery and counts both user and bot messages', async () => {
    const inputs: string[] = []
    const h = createHarness({ recallInterval: 3, onRecallModel: input => { inputs.push(input) } })
    for (const turn of [1, 2, 3]) {
        const agent = h.agent(turn)
        await h.observed(turn * 2, 'question ' + turn)
        await h.begin(agent, turn * 2)
        assert.equal(inputs.length, turn === 1 ? 0 : 1)
        await h.send([turn * 2 + 1], turn)
        await h.observed(turn * 2 + 1, 'reply ' + turn, { self: true })
        await h.turn(agent)
    }
    assert.equal(inputs.length, 2)
    assert.match(inputs[0], /reply 1/u)
    assert.match(inputs[1], /reply 3/u)
})

it('resolves the session only at turn start and recovers from a failed lookup on the next turn', async () => {
    const h = createHarness()
    h.switch(undefined)
    const agent = h.agent(1, 'test-engine')
    await h.observed(1, 'first chat', { userId: 'alice' })
    const first = foldedChat(1, 'alice', direct)
    const lookups = h.scopeLookups
    await h.input(agent, first, 'queued')
    assert.equal(h.scopeLookups, lookups)
    h.switch('preset-2')
    await h.input(agent, first, 'taken')
    h.setCurrent(Promise.reject(new Error('scope lookup failed')))
    await h.engineTurn(agent, 1, [first])
    assert.equal(h.scopeLookups, lookups + 1)
    assert.equal(h.warnings.length, 1)
    assert.equal(h.recalls.length, 0)

    h.setCurrent(Promise.resolve())
    await h.observed(2, 'next chat', { userId: 'bob' })
    const next = foldedChat(2, 'bob', direct)
    await h.input(agent, next, 'queued')
    await h.input(agent, next, 'taken')
    await h.engineTurn(agent, 2, [next])
    await h.send([3], 2)
    await h.observed(3, 'reply', { self: true })
    await h.turn(agent)
    assert.deepEqual(h.recalls.map(call => call.position), [2])
    assert.equal(h.warnings.length, 1)
})

it('defers a wake without a preset and uses its original chat when the preset is ready', async (t) => {
    const h = createHarness({ rules: { enableUserProfileInjection: true } })
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
    await h.request(agent)
    assert.deepEqual(h.profiles, [[createSpeakerKey('onebot', 'alice')]])
    assert.equal(h.warnings.length, 0)
})

it('discards the queued turn context after a switch before engine-turn', async () => {
    const h = createHarness({ rules: { enableUserProfileInjection: true } })
    const agent = h.agent(1, 'test-engine')
    await h.observed(1, 'question in A', { userId: 'alice' })
    const input = foldedChat(1, 'alice', direct)
    await h.input(agent, input, 'queued')
    await settle()
    assert.equal(h.recalls.length, 0)
    h.switch('preset-2')
    await h.input(agent, input, 'taken')
    await h.engineTurn(agent, 1, [input])
    assert.deepEqual(await h.request(agent), [])
    assert.equal(h.recalls.length, 0)
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
    assert.equal(h.hooks.contextForTurn(a)?.settings.enableUserProfileInjection, true)
    assert.equal(h.recalls.length, 0)
    await h.request(a)
    assert.deepEqual(h.profiles.flat(), [])
})

it('still injects profiles from the triggering window when recall is disabled', async () => {
    const h = createHarness({ rules: { enableUserProfileInjection: true, recallIntervalMessages: 0, recallHistoryMessages: 1 } })
    await h.observed(1, 'question', { userId: 'alice' })
    await h.observed(2, 'later', { userId: 'bob' })
    const a = h.agent(1, 'test-engine')
    await h.engineTurn(a, 1, [foldedChat(1, 'alice', direct), foldedChat(2, 'bob')])
    h.framework.messages.splice(0)
    await h.request(a)
    assert.deepEqual(h.profiles, [[createSpeakerKey('onebot', 'alice')]])
    assert.equal(h.recalls.length, 0)
})
