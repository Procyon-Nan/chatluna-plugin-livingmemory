import type { ObservedMessage } from '@chatluna/chat-observer'
import type { RouteIdentity } from '@chatluna/satori'

export const historyScope = { conversationId: 'conv-1', sessionId: 'session-1', presetId: 'preset-1', platform: 'onebot' }

export const historyMessage = (id: number, text: string, overrides: Partial<ObservedMessage> = {}): ObservedMessage => ({
    id: ('route:m-' + id) as ObservedMessage['id'], platformMessageId: 'm-' + id, cid: 'onebot:c', routeId: 'route',
    time: 1_000 + id, self: false, backfilled: false, userId: 'user-1', name: '用户A',
    content: [{ type: 'text', text }], ...overrides
})

export class FrameworkHistoryFixture {
    constructor(readonly conversationKey = historyScope.conversationId) {}

    readonly messages: ObservedMessage[] = []
    channel: { routeId: string; identity: RouteIdentity } = {
        routeId: 'route',
        identity: { platform: 'onebot', selfId: 'bot-1', isDirect: false, guildId: 'guild-1', channelId: 'c', userId: 'user-1' }
    }
    channelOf(key: string) {
        if (key === this.conversationKey) return this.channel
    }
    channelStats() {
        const { routeId, identity } = this.channel
        return [{ cid: `${identity.platform}:${identity.channelId}`, routeId, conversationKey: this.conversationKey }]
    }
    recentOfConversation(key: string, limit: number) {
        return key === this.conversationKey ? this.messages.slice(-limit) : []
    }
}
