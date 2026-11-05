import type { ChatMessage } from '@chatluna/message'
import { blocksToLogText } from '../element_text.ts'
import type { ConversationLogMessage } from './types.ts'

/**
 * 会话历史 → 召回窗口条目。
 *
 * 会话里既有观察层回填的平台历史，也有实时消息与模型回复，因此它是召回窗口
 * 的完整来源；消息池只覆盖实时部分。`form` 非空的消息是系统注入（提示分节、
 * 记忆播报、预设切换），不是对话内容，不进窗口。
 */
export const toSessionLogMessages = (
    messages: readonly ChatMessage[]
): ConversationLogMessage[] => {
    const entries: ConversationLogMessage[] = []
    for (const message of messages) {
        if (message.form !== undefined) continue
        if (message.role !== 'user' && message.role !== 'assistant') continue
        const content = blocksToLogText(message.content)
        if (content.length === 0) continue
        const sender = message.meta?.sender
        const userId = sender?.id ?? message.meta?.externalId ?? ''
        entries.push({
            seq: 0,
            messageId: message.meta?.externalId,
            userId,
            name: sender?.name?.trim() || userId,
            content,
            timestamp: 0,
            role: message.role,
            origin: 'backfill'
        })
    }
    return entries
}

/** 会话历史条目的去重键：有平台消息号用消息号，否则退到身份与正文。 */
export const sessionEntryKey = (entry: {
    messageId?: string
    userId: string
    content: string
}) =>
    entry.messageId != null && entry.messageId.length > 0
        ? `id:${entry.messageId}`
        : `k:${entry.userId}:${entry.content}`