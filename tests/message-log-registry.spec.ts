import assert from 'node:assert/strict'
import { MessageLogRegistry } from '../src/service/transcript/message_log/message_log_registry.ts'
import type { ConversationHistorySource } from '../src/service/transcript/message_log/backfill.ts'
import type { ObservedMessageEvent } from '../src/contracts/framework.ts'

interface DeferredBackfill {
    source: ConversationHistorySource
    resolve: (messages: ObservedMessageEvent[]) => void
}

const historyMessage = (id: string, userId: string, content: string, time = 1_000): ObservedMessageEvent => ({
    id: `obs-${id}`,
    conversationKey: 'conv-1',
    sessionId: 'session-1',
    routeId: 'route-1',
    platform: 'onebot',
    platformMessageId: id,
    userId,
    name: `用户${userId}`,
    time,
    self: false,
    backfilled: true,
    content: [{ type: 'text', text: content }]
})

const createDeferredBackfill = (): DeferredBackfill => {
    let resolve!: (messages: ObservedMessageEvent[]) => void
    const promise = new Promise<ObservedMessageEvent[]>((res) => {
        resolve = res
    })
    return { source: { read: async () => promise }, resolve }
}

/** 实时条目默认取当前时刻：`clear` 之后按到达时钟推进纪元，早于纪元的时间戳会被丢弃。 */
const liveEntry = (messageId: string, content: string, timestamp = Date.now()) => ({
    messageId,
    userId: 'user-1',
    name: '用户A',
    content,
    timestamp,
    role: 'user' as const,
    origin: 'live' as const
})

describe('MessageLogRegistry', () => {
    it('keeps live appends within the specified conversation', async () => {
        const registry = new MessageLogRegistry()
        const { source, resolve } = createDeferredBackfill()
        registry.register('conv-1', source)
        registry.register('conv-2', source)
        resolve([])
        await registry.warmup('conv-1')
        await registry.warmup('conv-2')

        registry.appendLive('conv-1', liveEntry('m-1', 'hello'))

        assert.deepEqual(
            registry.lastN('conv-1', 10).map((entry) => entry.content),
            ['hello']
        )
        assert.deepEqual(registry.lastN('conv-2', 10), [])
    })

    it('is idempotent on repeated registration', async () => {
        const registry = new MessageLogRegistry()
        const first = createDeferredBackfill()
        const second = createDeferredBackfill()
        registry.register('conv-1', first.source)
        registry.register('conv-1', second.source)
        first.resolve([historyMessage('h-1', 'user-1', 'old')])
        await registry.warmup('conv-1')

        assert.deepEqual(
            registry.lastN('conv-1', 10).map((entry) => entry.messageId),
            ['h-1']
        )
    })

    it('buffers live appends during backfill and flushes backfill first', async () => {
        const registry = new MessageLogRegistry()
        const deferred = createDeferredBackfill()
        registry.register('conv-1', deferred.source)

        const cursor = registry.captureCursor('conv-1')
        registry.appendLive('conv-1', liveEntry('live-1', 'live'))
        assert.deepEqual(registry.lastN('conv-1', 10), [])

        deferred.resolve([
            historyMessage('h-1', 'user-1', 'old'),
            historyMessage('live-1', 'user-1', 'live')
        ])
        await registry.warmup('conv-1')

        assert.deepEqual(
            registry.lastN('conv-1', 10).map((entry) => entry.messageId),
            ['h-1', 'live-1']
        )
        assert.deepEqual(
            registry.afterSeq('conv-1', cursor()).map((entry) => entry.messageId),
            ['live-1']
        )
    })

    it('warmup never rejects and retries backfill after a failure', async () => {
        const registry = new MessageLogRegistry()
        let attempts = 0
        const source: ConversationHistorySource = {
            read: async () => {
                attempts += 1
                if (attempts === 1) {
                    throw new Error('platform down')
                }
                return [historyMessage('h-1', 'user-1', 'old')]
            }
        }
        registry.register('conv-1', source)
        await assert.doesNotReject(registry.warmup('conv-1'))
        assert.equal(attempts, 1)
        assert.equal(registry.isWarm('conv-1'), false)

        await registry.warmup('conv-1')
        assert.equal(attempts, 2)
        assert.equal(registry.isWarm('conv-1'), true)
    })

    it('keeps buffered live appends across a failed backfill', async () => {
        const registry = new MessageLogRegistry()
        let fail = true
        const source: ConversationHistorySource = {
            read: async () => {
                if (fail) {
                    fail = false
                    throw new Error('platform down')
                }
                return [historyMessage('h-1', 'user-1', 'old')]
            }
        }
        registry.register('conv-1', source)
        registry.appendLive('conv-1', liveEntry('live-1', 'live'))
        await registry.warmup('conv-1')
        await registry.warmup('conv-1')

        assert.deepEqual(
            registry.lastN('conv-1', 10).map((entry) => entry.messageId),
            ['h-1', 'live-1']
        )
    })

    it('treats a conversation without history as warm immediately', () => {
        const registry = new MessageLogRegistry()
        registry.register('conv-1')

        assert.equal(registry.isWarm('conv-1'), true)
        registry.appendLive('conv-1', liveEntry('m-1', 'hello'))
        assert.equal(registry.tailSeq('conv-1'), 1)
    })

    it('clears entries while keeping later appends flowing', () => {
        const registry = new MessageLogRegistry()
        registry.register('conv-1')
        const clearedAt = Date.now()
        registry.appendLive('conv-1', liveEntry('m-1', 'before', clearedAt - 1000))

        registry.clear('conv-1')
        assert.deepEqual(registry.lastN('conv-1', 10), [])

        registry.appendLive('conv-1', liveEntry('m-2', 'after', clearedAt + 1000))
        assert.deepEqual(
            registry.lastN('conv-1', 10).map((entry) => entry.messageId),
            ['m-2']
        )
        assert.equal(registry.tailSeq('conv-1'), 2)
    })

    it('drops the whole pool on release and rebuilds from the new history', async () => {
        const registry = new MessageLogRegistry()
        registry.register('conv-1')
        registry.appendLive('conv-1', liveEntry('m-1', 'old branch'))

        registry.release('conv-1')
        assert.deepEqual(registry.lastN('conv-1', 10), [])
        assert.equal(registry.tailSeq('conv-1'), null)
        assert.equal(registry.isWarm('conv-1'), false)

        registry.register('conv-1')
        registry.appendLive('conv-1', liveEntry('m-2', 'new branch'))
        assert.deepEqual(
            registry.lastN('conv-1', 10).map((entry) => entry.messageId),
            ['m-2']
        )
    })

    it('returns the recall window before the current message', async () => {
        const registry = new MessageLogRegistry()
        registry.register('conv-1')
        registry.appendLive('conv-1', liveEntry('m-1', 'a'))
        registry.appendLive('conv-1', liveEntry('m-2', 'b'))
        registry.appendLive('conv-1', liveEntry('m-3', 'c'))

        const window = await registry.loadRecallHistory('conv-1', 5, {
            messageId: 'm-3',
            userId: 'user-1',
            content: 'c',
            timestamp: 2_000
        })

        assert.deepEqual(
            window.map((entry) => entry.messageId),
            ['m-1', 'm-2']
        )
    })

    it('falls back to the tail window when the current message is not in the log', async () => {
        const registry = new MessageLogRegistry()
        registry.register('conv-1')
        registry.appendLive('conv-1', liveEntry('m-1', 'a'))
        registry.appendLive('conv-1', liveEntry('m-2', 'b'))

        const window = await registry.loadRecallHistory('conv-1', 1, {
            messageId: 'unknown',
            userId: 'user-1',
            content: 'z',
            timestamp: 3_000
        })

        assert.deepEqual(
            window.map((entry) => entry.messageId),
            ['m-2']
        )
    })
})