import assert from 'node:assert/strict'
import { ChatMessage } from '@chatluna/message'
import {
    sessionEntryKey,
    toSessionLogMessages
} from '../src/service/transcript/message_log/session_history.ts'

/** 会话里的用户消息；`externalId` 对应平台消息号。 */
const userMessage = (
    content: string,
    sender: { id: string; name?: string },
    externalId?: string
) =>
    ChatMessage.user(content, {
        meta: { sender, ...(externalId === undefined ? {} : { externalId }) }
    })

const assistantMessage = (content: string) =>
    ChatMessage.assistant(content, { provider: 'test', model: 'test' })

it('converts the session transcript into recall window entries', () => {
    const entries = toSessionLogMessages([
        userMessage('之前的问题', { id: 'user-1', name: '用户A' }, 'm-1'),
        assistantMessage('之前的回答')
    ])

    assert.equal(entries.length, 2)
    assert.deepEqual(entries[0], {
        seq: 0,
        messageId: 'm-1',
        userId: 'user-1',
        name: '用户A',
        content: '之前的问题',
        timestamp: 0,
        role: 'user',
        origin: 'backfill'
    })
    assert.equal(entries[1].role, 'assistant')
    assert.equal(entries[1].content, '之前的回答')
})

it('drops injected prompt sections that are not conversation content', () => {
    const injected = ChatMessage.notice('chatluna:livingmemory', '系统注入的记忆播报')

    const entries = toSessionLogMessages([
        injected,
        userMessage('真正的问题', { id: 'user-1' })
    ])

    assert.deepEqual(
        entries.map((entry) => entry.content),
        ['真正的问题']
    )
})

it('skips messages without text content and roles outside the conversation', () => {
    const toolMessage = ChatMessage.tool(
        'call-1' as never,
        'living_memory_search',
        'tool output' as never
    )

    const entries = toSessionLogMessages([
        userMessage('   ', { id: 'user-1' }),
        toolMessage,
        userMessage('保留', { id: 'user-1' })
    ])

    assert.deepEqual(
        entries.map((entry) => entry.content),
        ['保留']
    )
})

it('falls back to the external id when the sender has no name', () => {
    const [entry] = toSessionLogMessages([
        userMessage('正文', { id: 'user-1' }, 'platform-9')
    ])

    assert.equal(entry.userId, 'user-1')
    assert.equal(entry.name, 'user-1')
})

it('uses the external id as the user id when the message carries no sender', () => {
    const [entry] = toSessionLogMessages([
        ChatMessage.user('正文', { meta: { externalId: 'platform-9' } })
    ])

    assert.equal(entry.userId, 'platform-9')
    assert.equal(entry.name, 'platform-9')
})

it('dedupes by message id first and by identity plus content otherwise', () => {
    assert.equal(
        sessionEntryKey({ messageId: 'm-1', userId: 'user-1', content: 'a' }),
        'id:m-1'
    )
    assert.equal(
        sessionEntryKey({ messageId: '', userId: 'user-1', content: 'a' }),
        'k:user-1:a'
    )
    assert.equal(
        sessionEntryKey({ userId: 'user-1', content: 'a' }),
        'k:user-1:a'
    )
})