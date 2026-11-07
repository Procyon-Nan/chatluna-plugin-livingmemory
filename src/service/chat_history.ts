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
}

type HistoryService = Pick<ChatObserverService, 'recentOfConversation' | 'identityOfConversation'>

/** 只给宿主缓冲对象标记消费位置与回复归属，不持有聊天正文。 */
export class LivingMemoryChatHistory {
    private readonly positions = new WeakMap<ObservedMessage, number>()
    private readonly replies = new WeakMap<ObservedMessage, ChatHistoryScope>()
    private nextPosition = 0

    constructor(private readonly observer: HistoryService) {}

    scopeOf(conversationId: string, sessionId: string, presetId: string): ChatHistoryScope {
        const identity = this.observer.identityOfConversation(conversationId)
        return {
            conversationId,
            sessionId,
            presetId,
            ...(identity === undefined ? {} : {
                platform: identity.platform,
                isDirect: identity.isDirect,
                guildId: identity.guildId,
                channelId: identity.channelId,
                userId: identity.userId
            })
        }
    }

    /** 从尾部按需扩大读取范围；缓冲长度不作为消费进度。 */
    private *newest(key: string): Generator<ObservedMessage> {
        let seen = 0
        for (let limit = 32; ; limit *= 2) {
            const rows = this.observer.recentOfConversation(key, limit)
            for (let i = rows.length - seen - 1; i >= 0; i--) yield rows[i]
            if (rows.length < limit) return
            seen = rows.length
        }
    }

    lastPosition(key: string): number {
        const added: ObservedMessage[] = []
        let last = -1
        for (const row of this.newest(key)) {
            const position = this.positions.get(row)
            if (position !== undefined) {
                last = position
                break
            }
            added.push(row)
        }
        for (let i = added.length - 1; i >= 0; i--) {
            last = this.nextPosition++
            this.positions.set(added[i], last)
        }
        return last
    }

    async head(scope: ChatHistoryScope): Promise<number> {
        return this.lastPosition(scope.conversationId)
    }

    /** observed 通知与读取结果可以是两个对象，以框架消息 ID 对应缓冲记录。 */
    locate(key: string, message: ObservedMessage, replyScope?: ChatHistoryScope): number | undefined {
        this.lastPosition(key)
        for (const row of this.newest(key)) {
            if (row.id !== message.id) continue
            if (replyScope !== undefined) this.replies.set(row, replyScope)
            return this.positions.get(row)
        }
    }

    async after(scope: ChatHistoryScope, position: number, before = Infinity): Promise<ChatHistoryEntry[]> {
        this.lastPosition(scope.conversationId)
        const entries: ChatHistoryEntry[] = []
        for (const row of this.newest(scope.conversationId)) {
            const at = this.positions.get(row)!
            if (at <= position) break
            if (at >= before || row.backfilled || (row.self && this.replies.get(row) !== scope)) continue
            const entry = this.entry(scope, row)
            if (entry !== undefined) entries.push(entry)
        }
        return entries.reverse()
    }

    recent(scope: Pick<ChatHistoryScope, 'conversationId' | 'platform'>, count: number, through: number, after = -1): ChatHistoryEntry[] {
        if (count <= 0) return []
        const platform = scope.platform ?? this.observer.identityOfConversation(scope.conversationId)?.platform
        this.lastPosition(scope.conversationId)
        const entries: ChatHistoryEntry[] = []
        for (const row of this.newest(scope.conversationId)) {
            const position = this.positions.get(row)!
            if (position <= after) break
            if (position > through) continue
            const entry = this.entry({ platform }, row)
            if (entry !== undefined) entries.push(entry)
            if (entries.length === count) break
        }
        return entries.reverse()
    }

    locateUserPosition(key: string, message: { id: string; externalId?: string }, after = -1): number | undefined {
        this.lastPosition(key)
        for (const row of this.newest(key)) {
            if (row.id !== message.id && (message.externalId === undefined || row.platformMessageId !== message.externalId)) continue
            const position = this.positions.get(row)!
            if (position > after && !row.self && !row.backfilled) return position
            return
        }
    }

    private entry(scope: Pick<ChatHistoryScope, 'platform'>, row: ObservedMessage): ChatHistoryEntry | undefined {
        if (row.self && !this.replies.has(row)) return
        const content = blocksToLogText(row.content)
        if (!content) return
        return {
            position: this.positions.get(row)!, messageId: row.id, externalId: row.platformMessageId,
            platform: scope.platform, userId: row.userId, name: row.name ?? row.nickname,
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
