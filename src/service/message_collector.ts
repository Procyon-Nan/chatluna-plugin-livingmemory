import type { Disposable } from 'cordis'
import type { ChatObserverService } from '@chatluna/chat-observer'
import type { Agent } from '@chatluna/agent'
import { contentText } from '@chatluna/message'
import { MessageLogRegistry } from './transcript/message_log/message_log_registry.ts'
import { sessionEntryKey } from './transcript/message_log/session_history.ts'
import { blocksToLogText } from './transcript/element_text.ts'
import type {
  ConversationLogEntryInput,
  ConversationLogMessage
} from './transcript/message_log/types.ts'
import type { MemoryScope } from '../contracts/memory.ts'

/** 每次拉取的通道缓冲上限；与观察层的 `bufferLimit` 无关，取满即止。 */
const OBSERVED_FETCH_LIMIT = 200
/** 单次入池去重表上限：只有本进程见过的消息号需要记住。 */
const SEEN_LIMIT = 2000

/**
 * 跨引擎的统一采集层。
 *
 * 消息来源是 `chat_observer` 的通道缓冲：它在 `message` 与 `middleware` 上被动
 * 收集，覆盖触发回复和旁听两种消息。观察层不提供「消息已入池」事件，因此入池
 * 是拉取式的——召回与提取的触发点（`prepareStep`）每次拉一次缓冲，与原生
 * memory 的提取路径同源。
 *
 * 历史回填不在这里做：观察层自己把平台历史送进 agent 会话，插件的池子只维护
 * 实时视界，召回窗口不足时由调用方向会话历史补。
 */
export class MessageCollector {
  private readonly registry = new MessageLogRegistry()
  /** 建池时的历史头：历史头变化意味着旧池不再属于当前会话。 */
  private readonly sessionOf = new Map<string, string>()
  /** 已入池的消息号：跨拉取去重，避免同一批缓冲被重复追加。 */
  private readonly seen = new Set<string>()

  constructor(private readonly observer: Pick<ChatObserverService, 'recentOfConversation' | 'identityOfConversation'>) {}

  /** 采集不需要订阅；保留该方法是为了让服务侧的生命周期一致。 */
  start(): Disposable {
    return () => this.dispose()
  }

  /**
   * 把指定会话的实时消息同步进池。由触发点调用，次数取决于消费方。
   * 首次见到会话时按历史头建池；历史头变化则整池丢弃后重建。
   */
  sync(conversationKey: string, sessionId: string): void {
    const previous = this.sessionOf.get(conversationKey)
    if (previous !== sessionId) {
      this.sessionOf.set(conversationKey, sessionId)
      this.registry.release(conversationKey)
    }
    if (!this.registry.has(conversationKey)) {
      this.registry.register(conversationKey)
    }
    for (const message of this.observer.recentOfConversation(conversationKey, OBSERVED_FETCH_LIMIT)) {
      // 机器人自己的回声不入池：回复由 `recordReplies` 在轮次结束时按会话
      // 记录一次，回声是同一段内容的第二份，且渲染后的文本与模型输出不等。
      if (message.self) continue
      const key = `observed:${String(message.id)}`
      if (this.seen.has(key)) continue
      this.seen.add(key)
      const content = blocksToLogText(message.content)
      if (content.length === 0) continue
      this.registry.appendLive(
        conversationKey,
        this.entryOf({
          messageId: message.platformMessageId,
          userId: message.userId ?? message.routeId,
          name: message.name?.trim() || message.userId || message.routeId,
          content,
          timestamp: message.time,
          role: 'user'
        })
      )
    }
    this.trimSeen()
  }

  /** 记录本轮回复：取本轮最后一条 assistant 消息作为回复正文。 */
  recordReplies(agent: Agent): void {
    const conversationKey = agent.options.conversationKey
    if (conversationKey === undefined) return
    const reply = [...agent.session.messages()].reverse().find((message) => message.role === 'assistant')
    if (reply === undefined) return
    const key = `reply:${String(reply.id)}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    const content = contentText(reply.content)
    if (content.length === 0) return
    this.ensurePool(conversationKey, String(agent.session.id))
    const selfId = agent.options.location?.selfId ?? 'assistant'
    this.registry.appendReply(conversationKey, [
      {
        messageId: String(reply.id),
        userId: selfId,
        name: selfId,
        content,
        role: 'assistant',
        origin: 'reply'
      }
    ])
    this.trimSeen()
  }

  /** 按会话键与历史头解析记忆作用域；观察层身份缺失时只保留预设。 */
  scopeOf(conversationKey: string, presetId: string): MemoryScope {
    const identity = this.observer.identityOfConversation(conversationKey)
    return {
      conversationId: conversationKey,
      presetId,
      ...(identity === undefined
        ? {}
        : {
            platform: identity.platform,
            isDirect: identity.isDirect,
            ...(identity.guildId === undefined ? {} : { guildId: identity.guildId }),
            ...(identity.channelId === undefined ? {} : { channelId: identity.channelId }),
            ...(identity.userId === undefined ? {} : { userId: identity.userId })
          })
    }
  }

  recent(conversationKey: string, count: number) {
    return this.registry.lastN(conversationKey, count)
  }

  afterSeq(conversationKey: string, seq: number) {
    return this.registry.afterSeq(conversationKey, seq)
  }

  tailSeq(conversationKey: string) {
    return this.registry.tailSeq(conversationKey)
  }

  /** 池子在观测层无历史来源，建池即预热完成。 */
  async warmup(_conversationKey: string): Promise<void> {}

  isWarm(_conversationKey: string): boolean {
    return true
  }

  /**
   * 召回窗口：当前触发消息之前的 `count` 条。
   *
   * 池子只覆盖实时消息；`sessionHistory` 给出会话历史作为来源。先取池内条目，
   * 不够 `count` 时把会话历史中池里没有的部分按时间顺序补在前面。两边的同一
   * 条消息按消息号（或身份与正文）判重。
   */
  recallWindow(
    conversationKey: string,
    count: number,
    current: ConversationLogEntryInput | undefined,
    sessionHistory: readonly ConversationLogMessage[] = []
  ) {
    return this.loadWindow(conversationKey, count, current, sessionHistory)
  }

  private async loadWindow(
    conversationKey: string,
    count: number,
    current: ConversationLogEntryInput | undefined,
    sessionHistory: readonly ConversationLogMessage[]
  ): Promise<ConversationLogMessage[]> {
    const pooled = await this.registry.loadRecallHistory(
      conversationKey,
      count,
      current === undefined
        ? null
        : {
            messageId: current.messageId,
            userId: current.userId,
            content: current.content,
            timestamp: current.timestamp ?? 0
          }
    )
    const missing = count - pooled.length
    if (missing <= 0 || sessionHistory.length === 0) return pooled

    // 当前触发消息不在窗口内：它既已在池里，也可能随回填出现在会话历史中。
    const known = new Set(pooled.map(sessionEntryKey))
    if (current !== undefined) known.add(sessionEntryKey(current))
    const older = sessionHistory
      .filter((entry) => !known.has(sessionEntryKey(entry)))
      .slice(-missing)
    return [...older, ...pooled]
  }

  /** 历史头已更换：旧池中的消息属于另一份历史，整池丢弃。 */
  reset(conversationKey: string): void {
    this.sessionOf.delete(conversationKey)
    this.registry.release(conversationKey)
  }

  dispose() {
    this.registry.dispose()
    this.sessionOf.clear()
    this.seen.clear()
  }

  private ensurePool(conversationKey: string, sessionId: string): void {
    if (this.sessionOf.get(conversationKey) === sessionId && this.registry.has(conversationKey)) return
    this.sessionOf.set(conversationKey, sessionId)
    this.registry.release(conversationKey)
    this.registry.register(conversationKey)
  }

  private entryOf(input: {
    messageId: string | undefined
    userId: string
    name: string
    content: string
    timestamp: number
    role: 'user' | 'assistant'
  }): ConversationLogEntryInput {
    return {
      ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
      userId: input.userId,
      name: input.name,
      content: input.content,
      timestamp: input.timestamp,
      role: input.role,
      origin: 'live'
    }
  }

  private trimSeen() {
    if (this.seen.size <= SEEN_LIMIT) return
    const excess = this.seen.size - SEEN_LIMIT
    let removed = 0
    for (const key of this.seen) {
      this.seen.delete(key)
      if (++removed >= excess) break
    }
  }
}