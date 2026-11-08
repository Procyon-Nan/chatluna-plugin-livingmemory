import type { ObservedMessage } from '@chatluna/chat-observer'

export const historyScope = { conversationId: 'conv-1', sessionId: 'session-1', presetId: 'preset-1', platform: 'onebot' }

export const historyMessage = (id: number, text: string, overrides: Partial<ObservedMessage> = {}): ObservedMessage => ({
    id: ('route:m-' + id) as ObservedMessage['id'], platformMessageId: 'm-' + id, cid: 'onebot:c', routeId: 'route',
    time: 1_000 + id, self: false, backfilled: false, userId: 'user-1', name: '用户A',
    content: [{ type: 'text', text }], ...overrides
})

export class FrameworkHistoryFixture {
    readonly channelOf = (_cid: string) => ({ routeId: 'route', identity: this.identityOfConversation() })
    readonly messages: ObservedMessage[] = []
    readonly recentOfConversation = (_key: string, limit: number) => this.messages.slice(-limit)
    readonly identityOfConversation = () => ({
        platform: 'onebot', selfId: 'bot-1', isDirect: false,
        guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1'
    })
}
