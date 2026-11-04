import { blocksToLogText } from '../element_text.ts'
import type { ConversationLogEntryInput } from './types.ts'
import type { HistoryReader, ObservedMessageEvent } from '../../../contracts/framework.ts'

export interface ConversationBackfillOptions {
  warmupCount: number
}

/**
 * 历史来源。v1 直接拿平台的 `getMessageList`，v2 通过统一的可见历史接口读取；
 * 抽象成这一层，是为了让注册表只关心「有没有历史、能拿多少条」。
 */
export interface ConversationHistorySource {
  read(options: { limit: number }): Promise<readonly ObservedMessageEvent[]>
}

/**
 * 用框架的历史接口为会话构造回填来源。`sessionId` 固定为建池时的历史头：
 * 回填只补这一份历史，历史头变化由采集层直接丢弃整池后重建。
 */
export function historySourceOf(
  history: HistoryReader,
  input: { conversationKey: string; sessionId: string; before?: number | undefined }
): ConversationHistorySource {
  return {
    read: (options) =>
      history.read({
        conversationKey: input.conversationKey,
        sessionId: input.sessionId,
        limit: options.limit,
        ...(input.before === undefined ? {} : { before: input.before })
      })
  }
}

/**
 * 拉取会话历史并转成日志条目。缺少时间或作者的消息直接丢弃，不补造时间与
 * 身份；读取失败直接抛出，由注册表保持未预热、下次 warmup 重试——
 * 成功重拉经去重幂等。
 */
export async function pullConversationBackfill(
  source: ConversationHistorySource,
  options: ConversationBackfillOptions
): Promise<ConversationLogEntryInput[]> {
  const messages = await source.read({ limit: options.warmupCount })
  const entries: ConversationLogEntryInput[] = []
  for (const message of messages) {
    const userId = message.userId?.trim()
    if (userId === undefined || userId.length === 0 || !Number.isFinite(message.time)) {
      continue
    }
    const content = blocksToLogText(message.content)
    if (content.length === 0) {
      continue
    }
    entries.push({
      ...(message.platformMessageId === undefined ? {} : { messageId: message.platformMessageId }),
      userId,
      name: message.name?.trim() || userId,
      content,
      timestamp: message.time,
      role: message.self ? 'assistant' : 'user',
      origin: 'backfill'
    })
  }
  return entries.sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0))
}