import assert from 'node:assert/strict'
import type { Agent } from '@chatluna/agent'
import type { ChatObserverService } from '@chatluna/chat-observer'
import { ChatMessage } from '@chatluna/message'
import { MessageCollector } from '../src/service/message_collector.ts'
import type { ConversationLogMessage } from '../src/service/transcript/message_log/types.ts'

interface ObservedFixture {
    id: string
    routeId?: string
    platformMessageId?: string
    userId?: string
    name?: string
    time?: number
    self?: boolean
    text: string
}

interface CollectorHarness {
    collector: MessageCollector
    /** 往观察层的通道缓冲里放一条消息（下一次拉取可见）。 */
    observe: (message: ObservedFixture) => void
    /** 构造一轮结束时的 agent：会话末条是回复。 */
    agentOf: (input: { reply?: string; sessionId?: string }) => Agent
    identity?: {
        platform: string
        selfId: string
        isDirect: boolean
        guildId?: string
        channelId?: string
        userId: string
    }
}

const createHarness = (): CollectorHarness => {
    const buffers = new Map<string, ReturnType<typeof toObserved>[]>()
    const harness: CollectorHarness = {
        collector: null as never,
        observe: (message) => {
            const list = buffers.get('conv-1') ?? []
            list.push(toObserved(message))
            buffers.set('conv-1', list)
        },
        agentOf: ({ reply, sessionId }) => {
            const messages = reply === undefined ? [] : [ChatMessage.assistant(reply, { provider: 'test', model: 'test' })]
            return {
                options: {
                    config: { provider: 'test', model: 'test' },
                    conversationKey: 'conv-1',
                    presetId: 'preset-1',
                    location: { selfId: 'bot-1' }
                },
                session: { id: sessionId ?? 'session-1', messages: () => messages }
            } as unknown as Agent
        }
    }
    const observer = {
        recentOfConversation: (conversationKey: string, limit: number) =>
            (buffers.get(conversationKey) ?? []).slice(-limit),
        identityOfConversation: () => harness.identity
    } as unknown as Pick<ChatObserverService, 'recentOfConversation' | 'identityOfConversation'>
    harness.collector = new MessageCollector(observer)
    harness.collector.start()
    return harness
}

const toObserved = (message: ObservedFixture) => ({
    id: `obs:${message.id}`,
    cid: 'cid-1',
    routeId: message.routeId ?? 'route-1',
    platformMessageId: message.platformMessageId ?? message.id,
    time: message.time ?? 1_000,
    userId: message.userId ?? 'user-1',
    name: message.name ?? '用户A',
    self: message.self === true,
    backfilled: false,
    content: [{ type: 'text' as const, text: message.text }]
})

describe('MessageCollector', () => {
    it('pulls observed messages into the pool as user entries', () => {
        const harness = createHarness()
        harness.observe({ id: 'm-1', text: 'hello' })
        harness.collector.sync('conv-1', 'session-1')

        const [entry] = harness.collector.recent('conv-1', 10)
        assert.equal(entry.messageId, 'm-1')
        assert.equal(entry.userId, 'user-1')
        assert.equal(entry.name, '用户A')
        assert.equal(entry.content, 'hello')
        assert.equal(entry.role, 'user')
        assert.equal(entry.origin, 'live')
    })

    it('skips bot echoes and empty content', () => {
        const harness = createHarness()
        harness.observe({ id: 'm-1', text: '   ' })
        harness.observe({ id: 'm-2', text: 'bot says', self: true })
        harness.observe({ id: 'm-3', text: 'kept' })
        harness.collector.sync('conv-1', 'session-1')

        assert.deepEqual(
            harness.collector.recent('conv-1', 10).map((entry) => entry.messageId),
            ['m-3']
        )
    })

    it('keeps each buffered message once across repeated pulls', () => {
        const harness = createHarness()
        harness.observe({ id: 'm-1', text: 'a' })
        harness.collector.sync('conv-1', 'session-1')
        harness.collector.sync('conv-1', 'session-1')
        harness.observe({ id: 'm-2', text: 'b' })
        harness.collector.sync('conv-1', 'session-1')

        assert.deepEqual(
            harness.collector.recent('conv-1', 10).map((entry) => entry.messageId),
            ['m-1', 'm-2']
        )
    })

    it('records the turn reply exactly once', () => {
        const harness = createHarness()
        harness.observe({ id: 'm-1', text: 'ask' })
        harness.collector.sync('conv-1', 'session-1')
        const agent = harness.agentOf({ reply: 'reply' })
        harness.collector.recordReplies(agent)
        harness.collector.recordReplies(agent)

        const entries = harness.collector.recent('conv-1', 10)
        assert.deepEqual(
            entries.map((entry) => entry.content),
            ['ask', 'reply']
        )
        assert.equal(entries[1].role, 'assistant')
        assert.equal(entries[1].origin, 'reply')
        assert.equal(entries[1].userId, 'bot-1')
    })

    it('creates the pool on the first reply of a conversation', () => {
        const harness = createHarness()
        harness.collector.recordReplies(harness.agentOf({ reply: 'reply' }))

        const [entry] = harness.collector.recent('conv-1', 10)
        assert.equal(entry.content, 'reply')
    })

    it('ignores a turn with no assistant message', () => {
        const harness = createHarness()
        harness.collector.recordReplies(harness.agentOf({}))

        assert.deepEqual(harness.collector.recent('conv-1', 10), [])
    })

    it('drops the pool when the session head changes', () => {
        const harness = createHarness()
        harness.observe({ id: 'm-1', text: 'old' })
        harness.collector.sync('conv-1', 'session-1')

        harness.collector.sync('conv-1', 'session-2')

        assert.deepEqual(harness.collector.recent('conv-1', 10), [])
    })

    it('resets the pool explicitly', () => {
        const harness = createHarness()
        harness.observe({ id: 'm-1', text: 'old' })
        harness.collector.sync('conv-1', 'session-1')
        harness.collector.reset('conv-1')

        assert.deepEqual(harness.collector.recent('conv-1', 10), [])
        assert.equal(harness.collector.tailSeq('conv-1'), null)
    })

    it('builds the scope from the observed route identity', () => {
        const harness = createHarness()
        harness.identity = {
            platform: 'onebot',
            selfId: 'bot-1',
            isDirect: false,
            guildId: 'guild-1',
            channelId: 'channel-1',
            userId: 'user-1'
        }

        assert.deepEqual(harness.collector.scopeOf('conv-1', 'preset-1'), {
            conversationId: 'conv-1',
            presetId: 'preset-1',
            platform: 'onebot',
            isDirect: false,
            guildId: 'guild-1',
            channelId: 'channel-1',
            userId: 'user-1'
        })
    })

    it('keeps only the preset when the route identity is unknown', () => {
        const harness = createHarness()

        assert.deepEqual(harness.collector.scopeOf('conv-1', 'preset-1'), {
            conversationId: 'conv-1',
            presetId: 'preset-1'
        })
    })

    it('returns the recall window before the triggering message', async () => {
        const harness = createHarness()
        harness.observe({ id: 'm-1', text: 'a', time: 1_000 })
        harness.observe({ id: 'm-2', text: 'b', time: 1_001 })
        harness.observe({ id: 'm-3', text: 'c', time: 1_002 })
        harness.collector.sync('conv-1', 'session-1')

        const window = await harness.collector.recallWindow('conv-1', 5, {
            messageId: 'm-3',
            userId: 'user-1',
            name: '用户A',
            content: 'c',
            timestamp: 1_002,
            role: 'user',
            origin: 'live'
        })

        assert.deepEqual(
            window.map((entry) => entry.messageId),
            ['m-1', 'm-2']
        )
    })

    it('fills a short pool from the session history', async () => {
        const harness = createHarness()
        harness.observe({ id: 'm-2', text: 'b', time: 1_001 })
        harness.observe({ id: 'm-3', text: 'c', time: 1_002 })
        harness.collector.sync('conv-1', 'session-1')

        const window = await harness.collector.recallWindow(
            'conv-1',
            3,
            {
                messageId: 'm-3',
                userId: 'user-1',
                name: '用户A',
                content: 'c',
                timestamp: 1_002,
                role: 'user',
                origin: 'live'
            },
            [
                historyEntry('h-1', '回填一', 'user-1'),
                historyEntry('m-2', 'b', 'user-1'),
                historyEntry('m-3', 'c', 'user-1')
            ]
        )

        // 池里的 m-2 不重复；m-3 是当前触发消息，不进窗口。
        assert.deepEqual(
            window.map((entry) => entry.content),
            ['回填一', 'b']
        )
    })

    it('keeps the pool window when the session history adds nothing', async () => {
        const harness = createHarness()
        harness.observe({ id: 'm-1', text: 'a', time: 1_000 })
        harness.observe({ id: 'm-2', text: 'b', time: 1_001 })
        harness.collector.sync('conv-1', 'session-1')

        const window = await harness.collector.recallWindow(
            'conv-1',
            2,
            {
                messageId: 'm-2',
                userId: 'user-1',
                name: '用户A',
                content: 'b',
                timestamp: 1_001,
                role: 'user',
                origin: 'live'
            },
            [historyEntry('m-1', 'a', 'user-1'), historyEntry('m-2', 'b', 'user-1')]
        )

        assert.deepEqual(
            window.map((entry) => entry.messageId),
            ['m-1']
        )
    })

    it('clears everything after dispose', () => {
        const harness = createHarness()
        harness.observe({ id: 'm-1', text: 'a' })
        harness.collector.sync('conv-1', 'session-1')
        harness.collector.dispose()

        assert.deepEqual(harness.collector.recent('conv-1', 10), [])
    })
})

const historyEntry = (
    messageId: string,
    content: string,
    userId: string
): ConversationLogMessage => ({
    seq: 0,
    messageId,
    userId,
    name: userId,
    content,
    timestamp: 0,
    role: 'user',
    origin: 'backfill'
})