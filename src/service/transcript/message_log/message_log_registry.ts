import { pullConversationBackfill, type ConversationHistorySource } from './backfill.ts'
import { ConversationMessageLog, messageKey } from './message_log.ts'
import type { ConversationLogEntryInput, ConversationLogMessage } from './types.ts'

/** 单会话日志容量与冷启动回填预热条数（内部常量，不暴露为配置）。 */
const LOG_CAPACITY = 500
const BACKFILL_WARMUP_COUNT = 200

type RecallMessageIdentity = Pick<ConversationLogEntryInput, 'messageId' | 'userId' | 'content' | 'timestamp'>

interface ConversationLogEntry {
  log: ConversationMessageLog
  /** 回填来源；空表示该会话没有历史能力，建池即视为预热完成。 */
  history: ConversationHistorySource | null
  /** 回填进行中：实时与回复消息先入缓冲，回填结束后按序冲刷。 */
  backfilling: boolean
  /** 回填已完成（含无历史能力而立即结束），此后写入直通。 */
  warm: boolean
  warmupPromise: Promise<void> | null
  historyEndSeq: number
  pendingAppends: ConversationLogEntryInput[]
}

/**
 * 读取侧身份匹配与写入侧去重键同构：双方都有 messageId 时只按 ID 判定，
 * 否则退到 (userId, timestamp, content) 三元组——防止同用户同秒重复内容
 * 的不同消息互相冒充（OneBot 时间戳为秒级，确有可能）。
 */
const matchesCurrentMessage = (candidate: ConversationLogMessage, current: RecallMessageIdentity) => {
  const currentMessageId = current.messageId
  if (
    currentMessageId != null &&
    currentMessageId.length > 0 &&
    candidate.messageId != null &&
    candidate.messageId.length > 0
  ) {
    return candidate.messageId === currentMessageId
  }
  return (
    candidate.userId === current.userId &&
    candidate.timestamp === current.timestamp &&
    candidate.content === current.content
  )
}

/** 按会话管理滚动消息日志与历史预热。 */
export class MessageLogRegistry {
  private readonly conversations = new Map<string, ConversationLogEntry>()

  register(conversationId: string, history?: ConversationHistorySource) {
    if (this.conversations.has(conversationId)) {
      return
    }

    const entry: ConversationLogEntry = {
      log: new ConversationMessageLog(LOG_CAPACITY),
      history: history ?? null,
      backfilling: false,
      warm: history == null,
      warmupPromise: null,
      historyEndSeq: 0,
      pendingAppends: []
    }
    this.conversations.set(conversationId, entry)

    if (history != null) this.startBackfill(entry)
  }

  /**
   * 等待回填结束（成功、无历史能力或失败均算结束）；失败后下次调用重新尝试。
   * 永不 reject——回填只是历史预热，失败不应打断召回或提取。
   */
  async warmup(conversationId: string): Promise<void> {
    const entry = this.conversations.get(conversationId)
    if (entry == null || entry.warm) {
      return
    }
    if (entry.warmupPromise == null && entry.history != null) {
      this.startBackfill(entry)
    }
    await entry.warmupPromise?.catch(() => {})
  }

  /**
   * 回填是否已成功完成（含无历史能力而立即结束）。失败重试期间为 false，
   * 供提取游标初始化等待回填落地，避免重试历史越过游标。
   */
  isWarm(conversationId: string): boolean {
    return this.conversations.get(conversationId)?.warm ?? false
  }

  /** 捕获下一条实时消息之前的边界，回填完成后读取最终序号。 */
  captureCursor(conversationId: string): () => number {
    const entry = this.conversations.get(conversationId)!
    if (entry.warm) {
      const seq = entry.log.tailSeq() ?? entry.historyEndSeq
      return () => seq
    }
    const preceding = new Set(entry.pendingAppends.map(messageKey))
    return () => {
      const messages = entry.log.afterSeq(entry.historyEndSeq)
      for (let index = messages.length - 1; index >= 0; index--) {
        if (preceding.has(messageKey(messages[index]))) {
          return messages[index].seq
        }
      }
      return (messages[0]?.seq ?? entry.historyEndSeq + 1) - 1
    }
  }

  appendLive(conversationId: string, item: ConversationLogEntryInput) {
    return this.appendTo(conversationId, [item])
  }

  appendReply(conversationId: string, items: ConversationLogEntryInput[]) {
    this.appendTo(conversationId, items)
  }

  lastN(conversationId: string, count: number): ConversationLogMessage[] {
    return this.conversations.get(conversationId)?.log.lastN(count) ?? []
  }

  afterSeq(conversationId: string, seq: number): ConversationLogMessage[] {
    return this.conversations.get(conversationId)?.log.afterSeq(seq) ?? []
  }

  tailSeq(conversationId: string): number | null {
    return this.conversations.get(conversationId)?.log.tailSeq() ?? null
  }

  /**
   * 召回历史读取：等待回填后取「当前触发消息之前」的最近 count 条。
   * 当前消息经身份在日志中定位——等待回填或画像读取期间追加的后续闲聊
   * 不会挤入边界，当前消息也不会与历史双份；定位失败退化为最近 count 条。
   */
  async loadRecallHistory(
    conversationId: string,
    count: number,
    current: RecallMessageIdentity | null
  ): Promise<ConversationLogMessage[]> {
    await this.warmup(conversationId)
    // 先取完整日志定位边界，再截取历史窗口。
    const entries = this.lastN(conversationId, LOG_CAPACITY)
    for (let index = entries.length - 1; current != null && index >= 0; index--) {
      if (matchesCurrentMessage(entries[index], current)) {
        return entries.slice(Math.max(0, index - count), index)
      }
    }
    return entries.slice(Math.max(0, entries.length - count))
  }

  /** 清条目并推进纪元，拦截清空之前的历史复活；会话本身继续采集。 */
  clear(conversationId: string) {
    const entry = this.conversations.get(conversationId)
    if (entry == null) {
      return
    }
    entry.historyEndSeq = entry.log.tailSeq() ?? entry.historyEndSeq
    entry.log.clear()
    entry.pendingAppends = []
  }

  /**
   * 丢弃整个会话池。历史头变化（重置、切换、分支）后旧池不再属于当前会话，
   * 而回填又按新历史头重拉，保留旧内容会混入其他分支。在途回填写入的是
   * 已脱离映射的条目对象，随 promise 结束一并丢弃。
   */
  release(conversationId: string) {
    this.conversations.delete(conversationId)
  }

  dispose() {
    this.conversations.clear()
  }

  private appendTo(conversationId: string, items: ConversationLogEntryInput[]) {
    const entry = this.conversations.get(conversationId)
    if (entry == null) return false
    if (entry.backfilling) {
      const knownKeys = new Set(entry.pendingAppends.map(messageKey))
      const added = items.filter((item) => {
        const key = messageKey(item)
        if (knownKeys.has(key)) return false
        knownKeys.add(key)
        return true
      })
      entry.pendingAppends.push(...added)
      return added.length > 0
    }
    const previousSeq = entry.log.tailSeq()
    entry.log.append(items)
    return entry.log.tailSeq() !== previousSeq
  }

  private startBackfill(entry: ConversationLogEntry) {
    const history = entry.history!
    entry.backfilling = true
    entry.warmupPromise = (async () => {
      const items = await pullConversationBackfill(history, { warmupCount: BACKFILL_WARMUP_COUNT })
      const liveKeys = new Set(entry.pendingAppends.map(messageKey))
      entry.log.append(items.filter((item) => !liveKeys.has(messageKey(item))))
      entry.historyEndSeq = entry.log.tailSeq() ?? entry.historyEndSeq
      entry.log.append(entry.pendingAppends)
      entry.pendingAppends = []
      entry.backfilling = false
      entry.warm = true
    })()
    void entry.warmupPromise.catch(() => {
      // 保留实时缓冲，后续 warmup 重试时统一按历史、实时顺序入账。
      entry.warmupPromise = null
      entry.backfilling = false
    })
  }
}