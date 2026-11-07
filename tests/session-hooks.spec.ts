import assert from 'node:assert/strict'
import type { Context } from 'cordis'
import type { Agent } from '@chatluna/agent'
import { ChatMessage, contentText } from '@chatluna/message'
import { LivingMemorySessionHooks } from '../src/service/session_hooks.ts'
import { LivingMemoryChatHistory } from '../src/service/chat_history.ts'
import type { ChatHistoryScope } from '../src/service/chat_history.ts'
import type { LivingMemoryTranscriptMessage } from '../src/contracts/memory.ts'
import { createCapturedLogger } from './workflow-test-utils.ts'
import { FrameworkHistoryFixture, historyMessage } from './chat-history-test-utils.ts'

const settle = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))
}
type Prepare = (input: { agent: Agent; stepNumber: number; messages: readonly ChatMessage[] }) => Promise<{ contribute?: readonly ChatMessage[] } | undefined>

function createHarness(config: { overheard?: boolean; extractionWindow?: number; recallInterval?: number } = {}) {
    const framework = new FrameworkHistoryFixture()
    const listeners = new Map<string, ((payload: any) => unknown)[]>()
    const recalls: { scope: ChatHistoryScope; current: LivingMemoryTranscriptMessage; history: () => Promise<LivingMemoryTranscriptMessage[]>; position: number }[] = []
    const extractions: { scope: ChatHistoryScope; boundary: number; eligible?: number; origin: () => Promise<{ header: string }> }[] = []
    const cleared: string[] = []
    const order: string[] = []
    let prepare!: Prepare
    let snapshotText = ''
    let presetId: string | undefined = 'preset-1'
    let sessionId = 'session-1'
    let drainGate: Promise<unknown> = Promise.resolve()
    let currentGate: Promise<unknown> = Promise.resolve()
    const captured = createCapturedLogger(false)
    const emit = (name: string, payload: unknown) => {
        return Promise.all((listeners.get(name) ?? []).map(listener => listener(payload)))
    }
    const ctx = {
        get: () => undefined,
        agents: { prepareStep: (callback: Prepare) => { prepare = callback; return () => {} } },
        on: (name: string, listener: (payload: unknown) => unknown) => {
            const entries = listeners.get(name) ?? []
            entries.push(listener)
            listeners.set(name, entries)
            return () => listeners.set(name, entries.filter((entry) => entry !== listener))
        },
        conversations: {
            current: async () => { await currentGate; return { sessionId, presetId } }
        },
        chat: {
            drain: async () => { await drainGate; order.push('drain'); return 1 },
            environmentOf: () => ({ guildName: '测试群' })
        }
    } as unknown as Context
    const hooks = new LivingMemorySessionHooks(ctx, {
        history: new LivingMemoryChatHistory(framework),
        recall: {
            queue: async (scope: ChatHistoryScope, current: LivingMemoryTranscriptMessage,
                history: () => Promise<LivingMemoryTranscriptMessage[]>, position: number) => {
                recalls.push({ scope, current, history, position })
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
        userProfiles: { renderForSpeakers: async () => '' } as never,
        repository: { getLatestSnapshotByScope: async () => snapshotText === '' ? undefined : {
            items: [{ finalText: snapshotText, matchedMemories: [], toolCallSummary: { searchTexts: [], searchKeywords: [], maxCandidates: 0 } }]
        } as never },
        logger: captured.logger,
        config: {
            enableSnapshotInjection: true, enableUserProfileInjection: false,
            recallIntervalMessages: config.recallInterval ?? 1, recallHistoryMessages: 20,
            extractionWindowMessages: config.extractionWindow ?? 2,
            extractionIncludeOverheard: config.overheard ?? false
        }
    })
    const dispose = hooks.register()
    const agent = (turn = 1) => ({
        options: { conversationKey: 'conv-1', presetId },
        session: { id: sessionId, lastTurn: turn }
    }) as unknown as Agent
    const user = (position: number) => ChatMessage.user('chat', { meta: { externalId: `m-${position}` } })
    return {
        framework, hooks, recalls, extractions, cleared, order, dispose, agent, user,
        engineTurn: (agent: Agent, turn: number, id: number) => emit('chatluna/engine-turn', { agent, turn, input: [user(id)] }),
        prepare: async (target: Agent, positions: number[] = [], stepNumber = 1, extra: ChatMessage[] = []) => {
            const result = await prepare({ agent: target, stepNumber, messages: [...positions.map(user), ...extra] })
            emit('chatluna/agent-output', { agent: target, turn: target.session.lastTurn })
            return result
        },
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

describe('LivingMemorySessionHooks', () => {
    it('injects the current snapshot on step one only', async () => {
        const harness = createHarness()
        await harness.observed(10, '问')
        harness.setSnapshot('用户喜欢红茶')
        const agent = harness.agent()
        const first = await harness.prepare(agent, [10])
        const second = await harness.prepare(agent, [10], 2)
        assert.match(contentText(first!.contribute![0].content), /用户喜欢红茶/)
        assert.equal(second, undefined)
    })

    it('uses the actual input batch while a later user message is already recorded', async () => {
        const harness = createHarness()
        await harness.observed(10, 'earlier')
        await harness.observed(30, 'current')
        await harness.observed(50, 'queued next')
        await harness.prepare(harness.agent(), [30])
        assert.equal(harness.recalls[0].current.contentLines.join(''), 'current')
        assert.equal(harness.recalls[0].position, 1)
        assert.deepEqual((await harness.recalls[0].history()).map((message) => message.contentLines.join('')), ['earlier'])
    })

    it('finds original user ids inside folded message envelopes and excludes notices', async () => {
        const harness = createHarness()
        await harness.observed(10, '问')
        const folded = ChatMessage.user([{
            type: 'envelope', kind: 'message', id: 'route:m-10', externalId: 'm-10',
            sender: { id: 'user-1' }, time: 1_010, content: [{ type: 'text', text: '问' }]
        }])
        await harness.prepare(harness.agent(), [], 1, [folded, ChatMessage.notice('internal', 'notice')])
        assert.equal(harness.recalls[0].position, 0)
        await harness.prepare(harness.agent(), [], 1, [ChatMessage.notice('wake', 'proactive wake'), ChatMessage.user('internal steer')])
        assert.equal(harness.recalls.length, 1)
    })

    it('counts the first post-restart user message and preserves the baseline across agent recreation', async () => {
        const harness = createHarness()
        harness.framework.messages.push(historyMessage(10, 'old'))
        await harness.observed(30, 'first new')
        const firstAgent = harness.agent()
        await harness.prepare(firstAgent, [30])
        harness.send([40], 1)
        await harness.observed(40, 'answer', { self: true })
        await harness.turn(firstAgent)
        assert.equal(harness.extractions[0].boundary, 0)
        const replacement = harness.agent(2)
        await harness.observed(50, 'second new')
        await harness.prepare(replacement, [50])
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
        await harness.prepare(oldAgent, [10])
        harness.switch('preset-2')
        await harness.observed(30, 'B')
        await harness.prepare(harness.agent(), [30])
        harness.switch('preset-1')
        await harness.observed(50, 'new A')
        const currentAgent = harness.agent(3)
        await harness.prepare(currentAgent, [50])
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
        await harness.prepare(harness.agent(), [10])
        harness.switch('preset-1', 'session-2')
        await harness.observed(80, 'new history')
        const agent = harness.agent()
        await harness.prepare(agent, [80])
        assert.deepEqual(await harness.recalls.at(-1)!.history(), [])
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
        await harness.prepare(agent, [10])
        await harness.turn(agent)
        harness.send([20], 1)
        await harness.observed(20, 'first split reply', { self: true })
        assert.equal(harness.extractions.length, 0)
        harness.send([30], 1)
        await harness.observed(30, 'second split reply', { self: true })
        Object.assign(agent.session, { lastTurn: 2 })
        await harness.observed(40, 'next question')
        await harness.prepare(agent, [40])
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
        await harness.prepare(agent, [10])
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
        const agent = harness.agent()
        await harness.engineTurn(agent, 7, 1)
        harness.send([2], 7)
        await harness.observed(2, 'direct answer', { self: true })
        await harness.turn(agent)
        assert.deepEqual(harness.extractions.map(x => x.eligible), [1])
    })

    it('does not trigger normal extraction for a turn without an actually delivered reply', async () => {
        const harness = createHarness()
        await harness.observed(10, 'question')
        const agent = harness.agent()
        await harness.prepare(agent, [10])
        await harness.turn(agent)
        assert.equal(harness.extractions.length, 0)
    })

    it('discards a pending scope lookup if the preset changes', async () => {
        const harness = createHarness()
        await harness.observed(10, 'old')
        let release!: () => void
        harness.setCurrent(new Promise<void>((resolve) => { release = resolve }))
        const preparing = harness.prepare(harness.agent(), [30])
        await settle()
        harness.switch('preset-2')
        release()
        await preparing
        assert.equal(harness.recalls.length, 0)
        await harness.observed(30, 'new')
        await harness.prepare(harness.agent(), [30])
        assert.equal(harness.recalls[0].scope.presetId, 'preset-2')
    })

    it('disables extraction at zero and drops pending delivery callbacks after disposal', async () => {
        const disabled = createHarness({ extractionWindow: 0 })
        await disabled.observed(10, 'question')
        const disabledAgent = disabled.agent()
        await disabled.prepare(disabledAgent, [10])
        await disabled.turn(disabledAgent)
        assert.equal(disabled.extractions.length, 0)

        const harness = createHarness()
        let release!: () => void
        harness.setDrain(new Promise<void>((resolve) => { release = resolve }))
        await harness.observed(10, 'question')
        const agent = harness.agent()
        await harness.prepare(agent, [10])
        await harness.turn(agent)
        harness.dispose()
        release()
        await settle()
        assert.equal(harness.extractions.length, 0)
    })
})
