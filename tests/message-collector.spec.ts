import assert from 'node:assert/strict'
import type {
    ChatLunaCollector,
    ConversationChangeEvent,
    DeliveredReply,
    HistoryReader,
    ObservedMessageEvent
} from '../src/contracts/framework.ts'
import { MessageCollector } from '../src/service/message_collector.ts'

interface CollectorHarness {
    collector: MessageCollector
    observe: (message: Partial<ObservedMessageEvent> & { content: string }) => void
    deliver: (reply: Partial<DeliveredReply> & { content: string; messageIds: string[] }) => void
    change: (event: Partial<ConversationChangeEvent> & { kind: 'reset' | 'switch' | 'fork' }) => void
    historyReads: number
}

const createHarness = (options: { history?: ObservedMessageEvent[] } = {}): CollectorHarness => {
    const observeListeners: ((message: ObservedMessageEvent) => void)[] = []
    const deliveredListeners: ((reply: DeliveredReply) => void)[] = []
    const changedListeners: ((event: ConversationChangeEvent) => void)[] = []
    const harness: CollectorHarness = {
        collector: null as never,
        historyReads: 0,
        observe: (message) => {
            for (const listener of observeListeners) {
                listener({
                    id: `obs-${message.platformMessageId ?? 'anon'}`,
                    conversationKey: 'conv-1',
                    sessionId: 'session-1',
                    routeId: 'route-1',
                    platform: 'onebot',
                    userId: 'user-1',
                    name: '用户A',
                    time: 1_000,
                    self: false,
                    backfilled: false,
                    ...message,
                    content: [{ type: 'text', text: message.content }]
                })
            }
        },
        deliver: (reply) => {
            for (const listener of deliveredListeners) {
                listener({
                    conversationKey: 'conv-1',
                    sessionId: 'session-1',
                    presetId: 'preset-1',
                    ...reply,
                    content: [{ type: 'text', text: reply.content }]
                })
            }
        },
        change: (event) => {
            for (const listener of changedListeners) {
                listener({
                    conversationKey: 'conv-1',
                    sessionId: 'session-2',
                    previousSessionId: 'session-1',
                    currentSessionId: 'session-2',
                    ...event
                } as ConversationChangeEvent)
            }
        }
    }

    const history: HistoryReader = {
        available: () => options.history !== undefined,
        read: async () => {
            harness.historyReads += 1
            return options.history ?? []
        }
    }
    const collector: ChatLunaCollector = {
        observe: (listener) => {
            observeListeners.push(listener)
            return () => {}
        },
        delivered: (listener) => {
            deliveredListeners.push(listener)
            return () => {}
        },
        changed: (listener) => {
            changedListeners.push(listener)
            return () => {}
        },
        history,
        attribution: () => undefined
    }
    harness.collector = new MessageCollector(collector)
    harness.collector.start()
    return harness
}

describe('MessageCollector', () => {
    it('records observed messages with role and nickname', () => {
        const harness = createHarness()
        harness.observe({ platformMessageId: 'm-1', content: 'hello' })

        const [entry] = harness.collector.recent('conv-1', 10)
        assert.equal(entry.messageId, 'm-1')
        assert.equal(entry.userId, 'user-1')
        assert.equal(entry.name, '用户A')
        assert.equal(entry.content, 'hello')
        assert.equal(entry.role, 'user')
        assert.equal(entry.origin, 'live')
    })

    it('keeps bot echoes as assistant entries and skips empty content', () => {
        const harness = createHarness()
        harness.observe({ platformMessageId: 'm-1', content: '   ' })
        harness.observe({ platformMessageId: 'm-2', content: 'bot says', self: true })

        const entries = harness.collector.recent('conv-1', 10)
        assert.deepEqual(
            entries.map((entry) => entry.messageId),
            ['m-2']
        )
        assert.equal(entries[0].role, 'assistant')
    })

    it('records delivered replies under their message ids', () => {
        const harness = createHarness()
        harness.observe({ platformMessageId: 'm-1', content: 'ask' })
        harness.deliver({ messageIds: ['d-1', 'd-2'], content: 'reply' })

        const entries = harness.collector.recent('conv-1', 10)
        assert.deepEqual(
            entries.map((entry) => entry.messageId),
            ['m-1', 'd-1', 'd-2']
        )
        assert.equal(entries[1].origin, 'reply')
        assert.equal(entries[1].role, 'assistant')
        assert.equal(entries[1].content, 'reply')
    })

    it('drops a delivered reply for a conversation without a pool', () => {
        const harness = createHarness()
        harness.deliver({ messageIds: ['d-1'], content: 'reply' })

        assert.deepEqual(harness.collector.recent('conv-1', 10), [])
    })

    it('dedupes an echo that arrives before the delivered reply', () => {
        const harness = createHarness()
        harness.observe({ platformMessageId: 'm-1', content: 'ask' })
        harness.observe({ platformMessageId: 'd-1', content: 'reply', self: true })
        harness.deliver({ messageIds: ['d-1'], content: 'reply' })

        const entries = harness.collector.recent('conv-1', 10)
        assert.deepEqual(
            entries.map((entry) => entry.messageId),
            ['m-1', 'd-1']
        )
        assert.equal(entries[1].origin, 'live')
    })

    it('backfills once on first sight and marks history messages', async () => {
        const harness = createHarness({
            history: [
                {
                    id: 'obs-h-1',
                    conversationKey: 'conv-1',
                    sessionId: 'session-1',
                    routeId: 'route-1',
                    platform: 'onebot',
                    platformMessageId: 'h-1',
                    userId: 'user-2',
                    name: '用户B',
                    time: 500,
                    self: false,
                    backfilled: true,
                    content: [{ type: 'text', text: 'history' }]
                }
            ]
        })
        harness.observe({ platformMessageId: 'm-1', content: 'live' })
        await harness.collector.warmup('conv-1')

        assert.equal(harness.historyReads, 1)
        assert.deepEqual(
            harness.collector.recent('conv-1', 10).map((entry) => entry.messageId),
            ['h-1', 'm-1']
        )
        assert.equal(harness.collector.recent('conv-1', 10)[0].origin, 'backfill')
    })

    it('does not read history twice for the same session', async () => {
        const harness = createHarness({ history: [] })
        harness.observe({ platformMessageId: 'm-1', content: 'a' })
        harness.observe({ platformMessageId: 'm-2', content: 'b' })
        await harness.collector.warmup('conv-1')

        assert.equal(harness.historyReads, 1)
    })

    it('drops the pool when the conversation is reset', () => {
        const harness = createHarness()
        harness.observe({ platformMessageId: 'm-1', content: 'old' })
        harness.change({ kind: 'reset' })

        assert.deepEqual(harness.collector.recent('conv-1', 10), [])
        assert.equal(harness.collector.tailSeq('conv-1'), null)
    })

    it('rebuilds the pool when the session head changes without a change event', async () => {
        const harness = createHarness({ history: [] })
        harness.observe({ platformMessageId: 'm-1', content: 'old' })
        await harness.collector.warmup('conv-1')

        harness.observe({ sessionId: 'session-2', platformMessageId: 'm-2', content: 'new' })
        await harness.collector.warmup('conv-1')

        assert.deepEqual(
            harness.collector.recent('conv-1', 10).map((entry) => entry.messageId),
            ['m-2']
        )
        assert.equal(harness.historyReads, 2)
    })

    it('ignores preset-applied notifications', () => {
        const harness = createHarness()
        harness.observe({ platformMessageId: 'm-1', content: 'kept' })
        harness.change({ kind: 'preset-applied', presetId: 'preset-2', turn: 2 } as never)

        assert.equal(harness.collector.recent('conv-1', 10).length, 1)
    })

    it('returns the recall window before the triggering message', async () => {
        const harness = createHarness()
        const time = Date.now()
        harness.observe({ platformMessageId: 'm-1', content: 'a', time })
        harness.observe({ platformMessageId: 'm-2', content: 'b', time: time + 1 })
        harness.observe({ platformMessageId: 'm-3', content: 'c', time: time + 2 })

        const window = await harness.collector.recallWindow('conv-1', 5, {
            id: 'obs-m-3',
            conversationKey: 'conv-1',
            sessionId: 'session-1',
            routeId: 'route-1',
            platform: 'onebot',
            platformMessageId: 'm-3',
            userId: 'user-1',
            name: '用户A',
            time: time + 2,
            self: false,
            backfilled: false,
            content: [{ type: 'text', text: 'c' }]
        })

        assert.deepEqual(
            window.map((entry) => entry.messageId),
            ['m-1', 'm-2']
        )
    })

    it('stops collecting after dispose', () => {
        const listeners: ((message: ObservedMessageEvent) => void)[] = []
        const collector: ChatLunaCollector = {
            observe: (listener) => {
                listeners.push(listener)
                return () => {
                    listeners.splice(listeners.indexOf(listener), 1)
                }
            },
            delivered: () => () => {},
            changed: () => () => {},
            history: { available: () => false, read: async () => [] },
            attribution: () => undefined
        }
        const subject = new MessageCollector(collector)
        subject.start()
        subject.dispose()

        assert.equal(listeners.length, 0)
        assert.deepEqual(subject.recent('conv-1', 10), [])
    })
})