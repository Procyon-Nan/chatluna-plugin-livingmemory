import { isCustomConversation } from '../routing.ts'
import { knownName, sourcePeerOf, type SourcePeer } from './memory/conversation_sources.ts'
import type { ObservedMessage, ChatObserverService } from '@chatluna/chat-observer'
import type { LivingMemoryTranscriptMessage, MemoryScope } from '../contracts/memory.ts'
import { createSpeakerKey } from './memory/speaker_identity.ts'
import { resolveScopeAssistantLabel } from './memory/helpers.ts'
import { hasTranscriptText, observedMessageText } from './transcript/element_text.ts'
import { createLivingMemoryTranscriptMessageResult } from './transcript/transcript_message.ts'

export interface ChatHistoryScope extends MemoryScope {
    sessionId: string
}

/** 保留原始消息块，待本轮预设确定后再转写。 */
export interface ChatHistoryEntry extends Pick<ObservedMessage, 'content' | 'quote'> {
    position: number
    messageId: string
    platform: string
    userId?: string
    name?: string
    timestamp: number
    role: 'user' | 'assistant'
    source?: SourcePeer | undefined
}

type HistoryChannel = Pick<NonNullable<ReturnType<ChatObserverService['channelOf']>>, 'routeId' | 'identity'>
type HistoryService = Pick<ChatObserverService, 'recentOfConversation'> & {
    channelOf(conversationKey: string): HistoryChannel | undefined
}

const historyPageSize = 32

function messageSource(row: ObservedMessage, channel: HistoryChannel | undefined): SourcePeer | undefined {
    if (channel?.routeId !== row.routeId) return
    const peer = sourcePeerOf(channel.identity)
    if (peer?.kind === 'user' && !row.self && row.userId === peer.id) {
        peer.name = knownName(peer.id, row.name) ?? knownName(peer.id, row.nickname)
    }
    return peer
}

/** 按宿主缓冲对象记录消费位置、来源和回复归属，不持有聊天正文。 */
export class LivingMemoryChatHistory {
    private readonly metadata = new WeakMap<ObservedMessage, { position: number; source: SourcePeer | undefined; replyScope?: ChatHistoryScope }>()
    private nextPosition = 0

    constructor(private readonly observer: HistoryService) {}

    scopeOf(conversationId: string, sessionId: string, presetId: string): ChatHistoryScope {
        const scope = { conversationId, sessionId, presetId }
        if (isCustomConversation(conversationId)) return scope
        const identity = this.observer.channelOf(conversationId)?.identity
        if (!identity) return scope
        const { platform, isDirect, guildId, channelId, userId } = identity
        return { ...scope, platform, isDirect, guildId, channelId, userId }
    }

    /** 由新到旧翻页；已知位置或已取够条数时无需读取更早的历史。 */
    private *newest(key: string): Generator<ObservedMessage> {
        let seen = 0
        for (let limit = historyPageSize; ; limit *= 2) {
            const rows = this.observer.recentOfConversation(key, limit)
            for (let i = rows.length - seen - 1; i >= 0; i--) yield rows[i]
            if (rows.length < limit) return
            seen = rows.length
        }
    }

    private *positioned(key: string): Generator<ObservedMessage> {
        const rows = this.newest(key)
        const added: ObservedMessage[] = []
        let next = rows.next()
        while (!next.done && !this.metadata.has(next.value)) {
            added.push(next.value)
            next = rows.next()
        }
        const channel = this.observer.channelOf(key)
        for (let i = added.length - 1; i >= 0; i--) {
            const row = added[i]
            this.metadata.set(row, { position: this.nextPosition++, source: messageSource(row, channel) })
        }
        yield* added
        if (!next.done) yield next.value
        yield* rows
    }

    lastPosition(key: string): number {
        const last = this.positioned(key).next()
        return last.done ? -1 : this.metadata.get(last.value)!.position
    }

    async head(scope: ChatHistoryScope): Promise<number> {
        return this.lastPosition(scope.conversationId)
    }

    /** observed 通知与读取结果可以是两个对象，以框架消息 ID 对应缓冲记录。 */
    locate(key: string, message: ObservedMessage, replyScope?: ChatHistoryScope): number | undefined {
        for (const row of this.positioned(key)) {
            if (row.routeId !== message.routeId || row.id !== message.id) continue
            const meta = this.metadata.get(row)!
            if (replyScope !== undefined) meta.replyScope = replyScope
            return meta.position
        }
    }

    async after(scope: ChatHistoryScope, position: number, before = Infinity, routeId?: string): Promise<ChatHistoryEntry[]> {
        const entries: ChatHistoryEntry[] = []
        for (const row of this.positioned(scope.conversationId)) {
            const { position: at, replyScope } = this.metadata.get(row)!
            if (at <= position) break
            if (routeId !== undefined && row.routeId !== routeId) continue
            if (at >= before || row.backfilled || (row.self && replyScope !== scope)) continue
            const entry = this.entry(row)
            if (entry !== undefined) entries.push(entry)
        }
        return entries.reverse()
    }

    recent(scope: Pick<ChatHistoryScope, 'conversationId'>, count: number, through: number, after = -1, routeId?: string): ChatHistoryEntry[] {
        if (count <= 0) return []
        const entries: ChatHistoryEntry[] = []
        for (const row of this.positioned(scope.conversationId)) {
            const position = this.metadata.get(row)!.position
            if (position <= after) break
            if (position > through || (routeId !== undefined && row.routeId !== routeId)) continue
            const entry = this.entry(row)
            if (entry !== undefined) entries.push(entry)
            if (entries.length === count) break
        }
        return entries.reverse()
    }

    locateUser(key: string, message: { id: string; externalId?: string; routeId?: string }, after = -1) {
        let candidate: ObservedMessage | undefined
        let ambiguous = false
        for (const row of this.positioned(key)) {
            const position = this.metadata.get(row)!.position
            if (position <= after) break
            if (row.self || row.backfilled) continue
            if (message.routeId && row.routeId !== message.routeId) continue
            if (row.id === message.id) return { position, routeId: row.routeId }
            if (!message.externalId || row.platformMessageId !== message.externalId) continue
            if (message.routeId || !isCustomConversation(key)) return { position, routeId: row.routeId }
            // 合批只保留内部消息 ID 和平台 ID；平台 ID 在不同频道里可重复。
            if (candidate) ambiguous = true
            candidate = row
        }
        if (candidate && !ambiguous) return { position: this.metadata.get(candidate)!.position, routeId: candidate.routeId }
    }

    private entry(row: ObservedMessage): ChatHistoryEntry | undefined {
        const { position, source, replyScope } = this.metadata.get(row)!
        if (row.self && !replyScope) return
        if (!hasTranscriptText(row)) return
        // Satori 的 cid 为 platform:channelId，来自这条消息本身。
        const platform = row.cid.split(':', 1)[0]
        return {
            position, messageId: row.id,
            source, platform, userId: row.userId, name: row.name ?? row.nickname,
            timestamp: row.time, role: row.self ? 'assistant' : 'user', content: row.content, quote: row.quote
        }
    }
}

export function toHistoryTranscriptMessages(
    scope: MemoryScope,
    entries: readonly ChatHistoryEntry[]
): LivingMemoryTranscriptMessage[] {
    const assistantLabel = resolveScopeAssistantLabel(scope)
    return entries.map((entry) => {
        const assistant = entry.role === 'assistant'
        const result = createLivingMemoryTranscriptMessageResult({
            role: entry.role,
            speakerKey: !assistant && entry.userId !== undefined
                ? createSpeakerKey(entry.platform, entry.userId)
                : undefined,
            speakerLabel: entry.name?.trim() || (assistant ? assistantLabel : entry.userId || '未知用户'),
            content: observedMessageText(entry, assistantLabel),
            createdAt: entry.timestamp,
            stripSpeakerPrefix: false
        })
        if (result.message === null) throw new Error(`聊天消息转写失败：${entry.messageId} / ${result.reason}`)
        return result.message
    })
}
