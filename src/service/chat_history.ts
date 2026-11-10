import { isCustomConversation } from '../routing.ts'
import type { SourcePeer } from './memory/conversation_sources.ts'
import type { ObservedMessage, ChatObserverService } from '@chatluna/chat-observer'
import type { LivingMemoryTranscriptMessage, MemoryScope } from '../contracts/memory.ts'
import { createSpeakerKey } from './memory/speaker_identity.ts'
import { resolveScopeAssistantLabel } from './memory/helpers.ts'
import { blocksToLogText } from './transcript/element_text.ts'
import { createLivingMemoryTranscriptMessageResult } from './transcript/transcript_message.ts'

export interface ChatHistoryScope extends MemoryScope {
    sessionId: string
}

/** 框架聊天记录的文本投影；position 是历史位置，不代表聊天条数。 */
export interface ChatHistoryEntry {
    position: number
    messageId: string
    externalId?: string
    platform?: string
    userId?: string
    name?: string
    content: string
    timestamp: number
    role: 'user' | 'assistant'
    backfilled: boolean
    source?: SourcePeer | undefined
}

type HistoryService = Pick<ChatObserverService, 'recentOfConversation' | 'identityOfConversation' | 'recent'> & {
    channelStats(): readonly Pick<ReturnType<ChatObserverService['statsOf']>, 'conversationKey' | 'cid' | 'routeId'>[]
    channelOf(cid: string): Pick<NonNullable<ReturnType<ChatObserverService['channelOf']>>, 'routeId' | 'identity'> | undefined
}

type ReadHistory = (limit: number) => readonly ObservedMessage[]
const historyPageSize = 32

/** 只给宿主缓冲对象标记消费位置与回复归属，不持有聊天正文。 */
export class LivingMemoryChatHistory {
    private readonly positions = new WeakMap<ObservedMessage, number>()
    private readonly replies = new WeakMap<ObservedMessage, ChatHistoryScope>()
    private nextPosition = 0

    constructor(private readonly observer: HistoryService) {}

    scopeOf(conversationId: string, sessionId: string, presetId: string): ChatHistoryScope {
        const scope = { conversationId, sessionId, presetId }
        if (isCustomConversation(conversationId)) return scope
        const identity = this.observer.identityOfConversation(conversationId)
        if (!identity) return scope
        const { platform, isDirect, guildId, channelId, userId } = identity
        return { ...scope, platform, isDirect, guildId, channelId, userId }
    }

    /** 每次只拉取查询所需的后缀。跨频道时按消费位置合并同样大小的窗口。 */
    private *newest(readers: ReadHistory[]): Generator<ObservedMessage> {
        if (readers.length === 0) return
        let seen = 0
        for (let limit = historyPageSize; ; limit *= 2) {
            const rows = readers.length === 1 ? readers[0](limit) : readers.flatMap(read => read(limit))
                .sort((a, b) => this.positions.get(a)! - this.positions.get(b)!).slice(-limit)
            for (let i = rows.length - seen - 1; i >= 0; i--) yield rows[i]
            if (rows.length < limit) return
            seen = rows.length
        }
    }

    private *positioned(key: string, routeId?: string): Generator<ObservedMessage> {
        // recentOfConversation 只返回第一个匹配的频道。自定义会话须从各个官方频道读取。
        const sources = isCustomConversation(key)
            ? this.observer.channelStats().filter(channel => channel.conversationKey === key).map(channel => ({
                route: channel.routeId, read: (limit: number) => this.observer.recent(channel.cid, { limit })
            }))
            : [{ route: undefined, read: (limit: number) => this.observer.recentOfConversation(key, limit) }]

        const added: { row: ObservedMessage; time: number }[] = []
        const selected: ReadHistory[] = []
        for (const { read, route } of sources) {
            // 建立位置和读取正文共用同一页，翻到更早的消息时才扩大窗口。
            const tail = read(historyPageSize)
            const readPage: ReadHistory = limit => limit === historyPageSize ? tail : read(limit)
            if (!routeId || !route || route === routeId) selected.push(readPage)
            let time = Infinity
            for (const row of this.newest([readPage])) {
                if (this.positions.has(row)) break
                // 平台时间可以相同或倒退；同一频道内保持框架缓冲的原始顺序。
                time = Math.min(time, row.time)
                added.push({ row, time })
            }
        }
        added.reverse()
        if (sources.length > 1) added.sort((a, b) => a.time - b.time)
        for (const { row } of added) this.positions.set(row, this.nextPosition++)

        yield* this.newest(selected)
    }

    lastPosition(key: string): number {
        const last = this.positioned(key).next()
        return last.done ? -1 : this.positions.get(last.value)!
    }

    async head(scope: ChatHistoryScope): Promise<number> {
        return this.lastPosition(scope.conversationId)
    }

    /** observed 通知与读取结果可以是两个对象，以框架消息 ID 对应缓冲记录。 */
    locate(key: string, message: ObservedMessage, replyScope?: ChatHistoryScope): number | undefined {
        for (const row of this.positioned(key, message.routeId)) {
            if (row.id !== message.id) continue
            if (replyScope !== undefined) this.replies.set(row, replyScope)
            return this.positions.get(row)
        }
    }

    async after(scope: ChatHistoryScope, position: number, before = Infinity, routeId?: string): Promise<ChatHistoryEntry[]> {
        const entries: ChatHistoryEntry[] = []
        for (const row of this.positioned(scope.conversationId, routeId)) {
            const at = this.positions.get(row)!
            if (at <= position) break
            if (routeId !== undefined && row.routeId !== routeId) continue
            if (at >= before || row.backfilled || (row.self && this.replies.get(row) !== scope)) continue
            const entry = this.entry(row)
            if (entry !== undefined) entries.push(entry)
        }
        return entries.reverse()
    }

    recent(scope: Pick<ChatHistoryScope, 'conversationId'>, count: number, through: number, after = -1, routeId?: string): ChatHistoryEntry[] {
        if (count <= 0) return []
        const entries: ChatHistoryEntry[] = []
        for (const row of this.positioned(scope.conversationId, routeId)) {
            const position = this.positions.get(row)!
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
        for (const row of this.positioned(key, message.routeId)) {
            const position = this.positions.get(row)!
            if (position <= after) break
            if (row.self || row.backfilled) continue
            if (row.id === message.id) return { position, routeId: row.routeId }
            if (!message.externalId || row.platformMessageId !== message.externalId) continue
            if (message.routeId && row.routeId !== message.routeId) continue
            if (message.routeId || !isCustomConversation(key)) return { position, routeId: row.routeId }
            // 合批只保留内部消息 ID 和平台 ID；平台 ID 在不同频道里可重复。
            if (candidate) ambiguous = true
            candidate = row
        }
        if (candidate && !ambiguous) return { position: this.positions.get(candidate)!, routeId: candidate.routeId }
    }

    private entry(row: ObservedMessage): ChatHistoryEntry | undefined {
        if (row.self && !this.replies.has(row)) return
        const content = blocksToLogText(row.content)
        if (!content) return
        const channel = this.observer.channelOf(row.cid)
        const identity = channel?.routeId === row.routeId ? channel.identity : undefined
        let source: SourcePeer | undefined
        if (identity) {
            const kind = identity.isDirect ? 'user' : 'guild'
            const id = identity.isDirect ? identity.userId : identity.guildId
            if (id) {
                const isPeerSpeaking = kind === 'user' && !row.self && row.userId === id
                const name = isPeerSpeaking ? [row.name, row.nickname].find(value => value && value !== id) : undefined
                source = { kind, id, key: `${identity.platform}:${identity.selfId}:${kind}:${id}`, name }
            }
        }
        return {
            position: this.positions.get(row)!, messageId: row.id, externalId: row.platformMessageId,
            source, platform: identity?.platform, userId: row.userId, name: row.name ?? row.nickname,
            timestamp: row.time, role: row.self ? 'assistant' : 'user', content, backfilled: row.backfilled
        }
    }
}

export function toHistoryTranscriptMessages(
    scope: MemoryScope,
    entries: readonly ChatHistoryEntry[]
): LivingMemoryTranscriptMessage[] {
    return entries.map((entry) => {
        const assistant = entry.role === 'assistant'
        const label = assistant ? resolveScopeAssistantLabel(scope) : '未知用户'
        const result = createLivingMemoryTranscriptMessageResult({
            role: entry.role,
            speakerKey: !assistant && entry.platform !== undefined && entry.userId !== undefined
                ? createSpeakerKey(entry.platform, entry.userId)
                : undefined,
            speakerLabel: entry.name?.trim() || (assistant ? label : entry.userId || label),
            content: entry.content,
            createdAt: entry.timestamp,
            stripSpeakerPrefix: false
        })
        if (result.message === null) throw new Error(`聊天消息转写失败：${entry.messageId} / ${result.reason}`)
        return result.message
    })
}
