import type { ChatLunaCollector, DeliveredReply, ObservedMessageEvent } from '../contracts/framework.ts'
import type { Disposable } from 'cordis'
import { MessageLogRegistry } from './transcript/message_log/message_log_registry.ts'
import { historySourceOf } from './transcript/message_log/backfill.ts'
import { blocksToLogText } from './transcript/element_text.ts'

/**
 * 跨引擎的统一采集层。
 *
 * 所有引擎共用这一处入池：框架把规范化后的消息、实际交付与会话变化推过来，
 * 这里维护每会话的滚动日志、回填、去重与序号。引擎差异不在这里体现——
 * 触发、消费时机与注入位置由工作流侧各自接入。
 */
export class MessageCollector {
  private readonly registry = new MessageLogRegistry()
  /** 建池时的历史头：历史头变化意味着旧池不再属于当前会话。 */
  private readonly sessionOf = new Map<string, string>()
  private readonly disposables: (() => void)[] = []

  constructor(private readonly collector: ChatLunaCollector) {}

  /** 开始订阅；返回的 disposer 同时停止采集并释放内存池。 */
  start(): Disposable {
    this.disposables.push(this.collector.observe((message) => this.onObserved(message)))
    this.disposables.push(this.collector.delivered((reply) => this.onDelivered(reply)))
    this.disposables.push(
      this.collector.changed((event) => {
        if (event.kind === 'preset-applied') return
        this.reset(event.conversationKey)
      })
    )
    return () => this.dispose()
  }

  /** 读取侧：最近 `count` 条，供召回与提取使用。 */
  recent(conversationKey: string, count: number) {
    return this.registry.lastN(conversationKey, count)
  }

  afterSeq(conversationKey: string, seq: number) {
    return this.registry.afterSeq(conversationKey, seq)
  }

  tailSeq(conversationKey: string) {
    return this.registry.tailSeq(conversationKey)
  }

  /** 等待历史预热结束；失败不抛出，下次调用重试。 */
  warmup(conversationKey: string) {
    return this.registry.warmup(conversationKey)
  }

  isWarm(conversationKey: string) {
    return this.registry.isWarm(conversationKey)
  }

  /** 捕获下一条实时消息之前的边界，回填完成后读取最终序号。 */
  captureCursor(conversationKey: string) {
    return this.registry.captureCursor(conversationKey)
  }

  /** 召回窗口：当前触发消息之前的 `count` 条。 */
  recallWindow(conversationKey: string, count: number, current: ObservedMessageEvent | undefined) {
    return this.registry.loadRecallHistory(
      conversationKey,
      count,
      current === undefined
        ? null
        : {
            messageId: current.platformMessageId,
            userId: current.userId ?? '',
            content: blocksToLogText(current.content),
            timestamp: current.time
          }
    )
  }

  dispose() {
    for (const stop of this.disposables.splice(0)) stop()
    this.registry.dispose()
    this.sessionOf.clear()
  }

  /**
   * 采集一条消息。自身回声不在这里丢弃：回复以交付事件为准，两者按
   * messageId 去重，先到的版本决定入池顺序。
   */
  private onObserved(message: ObservedMessageEvent): void {
    this.ensurePool(message)
    const content = blocksToLogText(message.content)
    if (content.length === 0) return
    this.registry.appendLive(message.conversationKey, {
      ...(message.platformMessageId === undefined ? {} : { messageId: message.platformMessageId }),
      userId: message.userId ?? message.platform,
      name: message.name?.trim() || message.userId || message.platform,
      content,
      timestamp: message.time,
      role: message.self ? 'assistant' : 'user',
      origin: message.backfilled ? 'backfill' : 'live'
    })
  }

  /**
   * 实际交付：以成功发出的消息为准。分段交付的各段携带同一份正文，按各自
   * 的 messageId 落条；平台自身回声先到时，去重键让后到的交付条目不再重复。
   */
  private onDelivered(reply: DeliveredReply): void {
    const content = blocksToLogText(reply.content)
    if (content.length === 0) return
    this.registry.appendReply(
      reply.conversationKey,
      reply.messageIds.map((messageId) => ({
        messageId,
        userId: reply.presetId,
        name: reply.presetId,
        content,
        role: 'assistant' as const,
        origin: 'reply' as const
      }))
    )
  }

  /** 首次见到会话时建池；框架声明有历史能力时同步启动回填。 */
  private ensurePool(message: ObservedMessageEvent): void {
    const sessionId = this.sessionOf.get(message.conversationKey)
    if (sessionId === message.sessionId) return
    this.sessionOf.set(message.conversationKey, message.sessionId)
    this.registry.release(message.conversationKey)
    const history = this.collector.history
    this.registry.register(
      message.conversationKey,
      history.available(message.conversationKey)
        ? historySourceOf(history, {
            conversationKey: message.conversationKey,
            sessionId: message.sessionId
          })
        : undefined
    )
  }

  /** 历史头已更换：旧池中的消息属于另一份历史，整池丢弃，下一条消息按新历史头重建。 */
  private reset(conversationKey: string): void {
    this.sessionOf.delete(conversationKey)
    this.registry.release(conversationKey)
  }
}