import assert from 'node:assert/strict'
import { ConversationMessageLog } from '../src/service/transcript/message_log/message_log.ts'
import type { ConversationLogEntryInput } from '../src/service/transcript/message_log/types.ts'

const entry = (overrides: Partial<ConversationLogEntryInput> = {}) => {
    return {
        userId: 'user-1',
        name: '用户A',
        content: 'hello',
        role: 'user',
        origin: 'live',
        ...overrides
    } satisfies ConversationLogEntryInput
}

describe('ConversationMessageLog', () => {
    it('assigns monotonic seq and reads lastN/afterSeq/tailSeq', () => {
        const log = new ConversationMessageLog(10)
        log.append([entry({ content: 'a' }), entry({ content: 'b' })])
        log.append([entry({ content: 'c' })])

        assert.equal(log.tailSeq(), 3)
        assert.deepEqual(
            log.lastN(2).map((item) => item.content),
            ['b', 'c']
        )
        assert.deepEqual(
            log.afterSeq(1).map((item) => item.content),
            ['b', 'c']
        )
        assert.deepEqual(log.lastN(0), [])
    })

    it('dedupes by messageId across channels', () => {
        const log = new ConversationMessageLog(10)
        log.append([
            entry({ messageId: 'm-1', content: 'a', origin: 'live' }),
            entry({ messageId: 'm-1', content: 'a', origin: 'backfill' })
        ])

        assert.equal(log.lastN(10).length, 1)
        assert.equal(log.lastN(10)[0].origin, 'live')
    })

    it('dedupes by fallback key when messageId is missing', () => {
        const log = new ConversationMessageLog(10)
        log.append([entry({ content: 'a', timestamp: 1000 }), entry({ content: 'a', timestamp: 1000 })])

        assert.equal(log.lastN(10).length, 1)
    })

    it('keeps distinct messages sharing a fallback triple apart by messageId', () => {
        const log = new ConversationMessageLog(10)
        log.append([
            entry({ messageId: 'm-1', content: 'a', timestamp: 1000 }),
            entry({ messageId: 'm-2', content: 'a', timestamp: 1000 })
        ])

        assert.equal(log.lastN(10).length, 2)
    })

    it('evicts oldest beyond capacity while seq stays monotonic', () => {
        const log = new ConversationMessageLog(3)
        log.append([
            entry({ messageId: 'm-1', content: 'a' }),
            entry({ messageId: 'm-2', content: 'b' }),
            entry({ messageId: 'm-3', content: 'c' })
        ])
        log.append([entry({ messageId: 'm-4', content: 'd' })])

        assert.deepEqual(
            log.lastN(10).map((item) => item.content),
            ['b', 'c', 'd']
        )
        assert.equal(log.tailSeq(), 4)
    })

    it('re-admits an evicted message id as a fresh entry', () => {
        const log = new ConversationMessageLog(2)
        log.append([entry({ messageId: 'm-1', content: 'a' })])
        log.append([entry({ messageId: 'm-2', content: 'b' }), entry({ messageId: 'm-3', content: 'c' })])
        log.append([entry({ messageId: 'm-1', content: 'a' })])

        assert.deepEqual(
            log.lastN(10).map((item) => item.messageId),
            ['m-3', 'm-1']
        )
    })

    it('clear rejects pre-epoch timestamps and resets reads', () => {
        const log = new ConversationMessageLog(10)
        log.append([entry({ content: 'a', timestamp: 1000 })])
        log.clear(1500)

        assert.equal(log.tailSeq(), null)
        log.append([
            entry({ content: 'old', timestamp: 999 }),
            entry({ content: 'edge', timestamp: 1500 }),
            entry({ content: 'new', timestamp: 2000 })
        ])

        assert.deepEqual(
            log.lastN(10).map((item) => item.content),
            ['new']
        )
    })
})