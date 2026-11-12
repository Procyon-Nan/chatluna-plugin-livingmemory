import assert from 'node:assert/strict'
import { LivingMemoryChatHistory, toHistoryTranscriptMessages } from '../src/service/chat_history.ts'
import { createSpeakerKey, resolveSpeakerKeysByLabels } from '../src/service/memory/speaker_identity.ts'
import { LivingMemoryMessageFormatter } from '../src/service/transcript/message_formatter.ts'
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
        assert.deepEqual((await history.after(historyScope, cursor)).map(x => x.messageId), ['route:m-250', 'route:m-251'])
        assert.equal(history.locateUser(historyScope.conversationId, { id: 'route:m-0' }), undefined)
    })

    it('reads through the supplied chat and excludes later arrivals', async () => {
        const observer = new FrameworkHistoryFixture()
        observer.messages.push(historyMessage(1, 'earlier'), historyMessage(2, 'trigger'), historyMessage(3, 'queued'))
        const history = new LivingMemoryChatHistory(observer)
        const position = history.locateUser(historyScope.conversationId, { id: 'input', externalId: 'm-2' })?.position
        assert.equal(position, 1)
        assert.deepEqual((await history.recent(historyScope, 2, position!)).map(x => x.messageId), ['route:m-1', 'route:m-2'])
        assert.deepEqual((await history.recent(historyScope, 1, position!)).map(x => x.messageId), ['route:m-2'])
    })

    it('bounds the window at a real input even when that row has no transcript text', async () => {
        const observer = new FrameworkHistoryFixture()
        observer.messages.push(historyMessage(1, 'earlier'), historyMessage(2, '', { content: [] }), historyMessage(3, 'next'))
        const history = new LivingMemoryChatHistory(observer)
        const position = history.locateUser(historyScope.conversationId, { id: 'route:m-2' })?.position
        assert.equal(position, 1)
        assert.deepEqual((await history.recent(historyScope, 2, position!)).map(row => row.messageId), ['route:m-1'])
    })

    it('renders bot mentions with the active preset name in recall, extraction and stored source text', async () => {
        const scope = { ...historyScope, presetLabel: '所长' }
        const observer = new FrameworkHistoryFixture()
        observer.messages.push(historyMessage(1, '@self 想我什么呀？看@123@self@someone，还有@self在吗？别改 @selfish 和 me@self.example 和 https://example.org?q=@self。'))
        const history = new LivingMemoryChatHistory(observer)
        const recall = toHistoryTranscriptMessages(scope, history.recent(scope, 1, Infinity))
        const extracted = toHistoryTranscriptMessages(scope, await history.after(scope, -1))
        const payload = new LivingMemoryMessageFormatter().toExtractionPayload(extracted)
        const expected = '@所长 想我什么呀？看@123@所长@someone，还有@所长在吗？别改 @selfish 和 me@self.example 和 https://example.org?q=@self。'
        assert.deepEqual(recall[0]!.contentLines, [expected])
        assert.equal(payload.input, renderLivingMemoryTranscript(recall))
        assert.deepEqual(payload.sourceOriginMessages[0]!.contentLines, [expected])
    })

    it('keeps a reply and its quote as one attributed message, including quote-only replies', async () => {
        const observer = new FrameworkHistoryFixture()
        const quote = { user: 'other-user', name: '@self', content: [{ type: 'text' as const, text: '引用原文 @self' }] }
        observer.messages.push(historyMessage(1, '我收到了', { quote }), historyMessage(2, '', { content: [], quote }))
        const history = new LivingMemoryChatHistory(observer)
        const entries = await history.after(historyScope, -1)
        assert.deepEqual(entries.map(row => row.messageId), ['route:m-1', 'route:m-2'])
        assert.deepEqual(history.recent(historyScope, 2, Infinity), entries)
        const payload = new LivingMemoryMessageFormatter().toExtractionPayload(toHistoryTranscriptMessages(historyScope, entries))
        assert.deepEqual(payload.speakers.map(speaker => speaker.speakerLabel), ['用户A'])
        for (const source of payload.sourceOriginMessages) {
            assert.equal(source.speakerLabel, '用户A')
            assert.match(source.content, /引用 @self：引用原文 @preset-1/u)
            assert.deepEqual(source.content.match(/引用原文/gu), ['引用原文'])
        }
        assert.match(payload.sourceOriginMessages[0]!.content, /我收到了/u)
    })

    it('renders the available media description and keeps a plain placeholder when there is none', () => {
        const observer = new FrameworkHistoryFixture()
        const image = { type: 'file' as const, mediaType: 'image/png', data: { type: 'url' as const, url: 'https://example.org/image' } }
        observer.messages.push(historyMessage(1, '', { content: [{ ...image, filename: '@self', alt: '牌子写着 @self' }] }),
            historyMessage(2, '', { content: [image] }))
        const history = new LivingMemoryChatHistory(observer)
        const [described, undescribed] = toHistoryTranscriptMessages(historyScope, history.recent(historyScope, 2, Infinity))
        assert.deepEqual(described!.contentLines, ['[图片:@self：牌子写着 @self]'])
        assert.deepEqual(undescribed!.contentLines, ['[图片]'])
    })

    it('reads the shared buffer in order without mixing routes, speakers or duplicate platform ids', async () => {
        const observer = new FrameworkHistoryFixture('custom:test')
        observer.channel = {
            routeId: 'B', identity: { platform: 'discord', selfId: 'bot-2', isDirect: false, guildId: 'B', channelId: 'B', userId: 'user-1' }
        }
        observer.messages.push(
            historyMessage(1, 'A1', { id: 'a:1' as never, time: 20, routeId: 'A', cid: 'onebot:A', platformMessageId: 'duplicate' }),
            historyMessage(2, 'A2', { id: 'a:2' as never, time: 10, routeId: 'A', cid: 'onebot:A' }),
            historyMessage(3, 'B1', { id: 'b:1' as never, time: 30, routeId: 'B', cid: 'discord:B', platformMessageId: 'duplicate' })
        )
        const history = new LivingMemoryChatHistory(observer)
        const shared = { ...historyScope, conversationId: observer.conversationKey }
        assert.equal(history.locateUser(shared.conversationId, { id: 'folded', externalId: 'duplicate' }), undefined)
        assert.equal(history.locateUser(shared.conversationId, { id: 'a:1', externalId: 'duplicate' })?.routeId, 'A')
        assert.deepEqual(history.recent(shared, 2, Infinity, -1, 'A').map(row => row.messageId), ['a:1', 'a:2'])
        const entries = await history.after(shared, -1)
        assert.deepEqual(entries.map(row => row.source?.id), [undefined, undefined, 'B'])
        assert.deepEqual(toHistoryTranscriptMessages(shared, entries).map(row => row.speakerKey), [
            createSpeakerKey('onebot', 'user-1'), createSpeakerKey('onebot', 'user-1'), createSpeakerKey('discord', 'user-1')
        ])
    })

    for (const direct of [false, true]) {
        it(`resolves an extracted speaker label to the platform user in a ${direct ? 'private' : 'group'} conversation`, async () => {
            const observer = new FrameworkHistoryFixture()
            const cid = direct ? 'onebot:private:42' : 'onebot:group-1'
            observer.channel.identity = {
                platform: 'onebot', selfId: 'bot', isDirect: direct, userId: '42',
                channelId: direct ? 'private:42' : 'group-1', guildId: direct ? undefined : 'group-1'
            }
            observer.messages.push(historyMessage(1, '想去看星星', { cid, userId: '42', name: '小林' }))
            const history = new LivingMemoryChatHistory(observer)
            const entries = await history.after(historyScope, -1)
            const messages = toHistoryTranscriptMessages(historyScope, entries)
            const payload = new LivingMemoryMessageFormatter().toExtractionPayload(messages)
            assert.deepEqual(resolveSpeakerKeysByLabels(['小林'], payload.speakers), [createSpeakerKey('onebot', '42')])
            assert.equal(entries[0].source?.id, direct ? '42' : 'group-1')
        })
    }

    it('uses the observed time and nickname and counts only chat and attributed replies', async () => {
        const observer = new FrameworkHistoryFixture()
        const chat = historyMessage(1, '正文', { time: new Date(2026, 10, 6, 12, 34).getTime(), name: '昵称' })
        const answer = historyMessage(5, '答复', { self: true, name: '助手' })
        observer.messages.push(chat, historyMessage(2, '', { content: [{ type: 'reasoning', text: 'thinking' }] }),
            historyMessage(3, '通知', { self: true }), historyMessage(4, '旧消息', { backfilled: true }), answer)
        const history = new LivingMemoryChatHistory(observer)
        history.locate(historyScope.conversationId, { ...answer }, historyScope)
        const entries = await history.after(historyScope, -1)
        assert.deepEqual(entries.map(x => x.messageId), ['route:m-1', 'route:m-5'])
        const transcript = toHistoryTranscriptMessages(historyScope, entries)
        assert.equal(renderLivingMemoryTranscript(transcript.slice(0, 1)), '[2026-11-06 12:34] 昵称：正文')
        assert.equal(transcript[0].speakerKey, createSpeakerKey('onebot', 'user-1'))
        assert.equal(transcript[1].role, 'assistant')
        assert.equal((await history.after({ ...historyScope }, -1)).some(x => x.role === 'assistant'), false)
    })
})
