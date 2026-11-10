import assert from 'node:assert/strict'
import { LivingMemoryChatHistory, toHistoryTranscriptMessages } from '../src/service/chat_history.ts'
import { createSpeakerKey } from '../src/service/memory/speaker_identity.ts'
import { renderLivingMemoryTranscript } from '../src/service/transcript/transcript_renderer.ts'
import { FrameworkHistoryFixture, historyMessage, historyScope } from './chat-history-test-utils.ts'

describe('LivingMemoryChatHistory', () => {
    it('reads beyond 200 and consumes only new rows after the buffer rolls over at equal timestamps', async () => {
        const observer = new FrameworkHistoryFixture()
        const history = new LivingMemoryChatHistory(observer)
        for (let i = 0; i < 250; i++) observer.messages.push(historyMessage(i, String(i), { time: 123 }))
        assert.equal((await history.after(historyScope, -1)).length, 250)
        const cursor = await history.head(historyScope)
        observer.messages.splice(0, 2)
        observer.messages.push(historyMessage(250, 'new', { time: 123 }), historyMessage(251, 'newer', { time: 123 }))
        assert.deepEqual((await history.after(historyScope, cursor)).map(x => x.content), ['new', 'newer'])
        assert.equal(history.locateUser(historyScope.conversationId, { id: 'route:m-0' }), undefined)
    })

    it('reads through the supplied chat and excludes later arrivals', async () => {
        const observer = new FrameworkHistoryFixture()
        observer.messages.push(historyMessage(1, 'earlier'), historyMessage(2, 'trigger'), historyMessage(3, 'queued'))
        const history = new LivingMemoryChatHistory(observer)
        const position = history.locateUser(historyScope.conversationId, { id: 'input', externalId: 'm-2' })?.position
        assert.equal(position, 1)
        assert.deepEqual((await history.recent(historyScope, 2, position!)).map(x => x.content), ['earlier', 'trigger'])
        assert.deepEqual((await history.recent(historyScope, 1, position!)).map(x => x.content), ['trigger'])
    })

    it('bounds the window at a real input even when that row has no transcript text', async () => {
        const observer = new FrameworkHistoryFixture()
        observer.messages.push(historyMessage(1, 'earlier'), historyMessage(2, '', { content: [] }), historyMessage(3, 'next'))
        const history = new LivingMemoryChatHistory(observer)
        const position = history.locateUser(historyScope.conversationId, { id: 'route:m-2' })?.position
        assert.equal(position, 1)
        assert.deepEqual((await history.recent(historyScope, 2, position!)).map(row => row.content), ['earlier'])
    })

    it('preserves each channel’s message order and rejects ambiguous platform ids in merged inputs', () => {
        const observer = new FrameworkHistoryFixture()
        observer.messages.push(
            historyMessage(1, 'A1', { id: 'a:1' as never, time: 20, routeId: 'A', cid: 'group:A', platformMessageId: 'duplicate' }),
            historyMessage(2, 'A2', { id: 'a:2' as never, time: 10, routeId: 'A', cid: 'group:A' }),
            historyMessage(3, 'B1', { id: 'b:1' as never, time: 30, routeId: 'B', cid: 'group:B', platformMessageId: 'duplicate' })
        )
        const history = new LivingMemoryChatHistory(observer)
        const shared = { conversationId: 'custom:test' }
        assert.equal(history.locateUser(shared.conversationId, { id: 'folded', externalId: 'duplicate' }), undefined)
        assert.equal(history.locateUser(shared.conversationId, { id: 'a:1', externalId: 'duplicate' })?.routeId, 'A')
        assert.deepEqual(history.recent(shared, 2, Infinity, -1, 'A').map(row => row.content), ['A1', 'A2'])
    })

    it('uses the observed time and nickname and counts only chat and attributed replies', async () => {
        const observer = new FrameworkHistoryFixture()
        const chat = historyMessage(1, '正文', { time: new Date(2026, 10, 6, 12, 34).getTime(), name: '昵称' })
        const answer = historyMessage(5, '答复', { self: true, name: '助手' })
        observer.messages.push(chat, historyMessage(2, '', { content: [{ type: 'reasoning', text: 'thinking' }] }),
            historyMessage(3, '通知', { self: true }), historyMessage(4, '旧消息', { backfilled: true }), answer)
        const history = new LivingMemoryChatHistory(observer)
        history.locate(historyScope.conversationId, { ...answer }, historyScope)
        const entries = await history.after(historyScope, -1)
        assert.deepEqual(entries.map(x => x.content), ['正文', '答复'])
        const transcript = toHistoryTranscriptMessages(historyScope, entries)
        assert.equal(renderLivingMemoryTranscript(transcript.slice(0, 1)), '[2026-11-06 12:34] 昵称：正文')
        assert.equal(transcript[0].speakerKey, createSpeakerKey('onebot', 'user-1'))
        assert.equal(transcript[1].role, 'assistant')
        assert.equal((await history.after({ ...historyScope }, -1)).some(x => x.role === 'assistant'), false)
    })
})
