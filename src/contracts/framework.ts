import type { ChatBlock } from '@chatluna/message'
import type {} from 'cordis'

/**
 * 插件依赖、但 ChatLuna v2 尚未提供的公共接口。
 *
 * 这些契约对应 `doc/framework-requirements.md` 中的 M05-C1、M05-C2、M02-C1 与
 * M06-C1。上游落地后，把这里的本地声明删掉、改为从 `@chatluna/*` 导入即可；
 * 形状保持与需求文档一致，是为了让那次替换只是一行 import 的变化。
 */

/** 一条进入统一采集的消息（M05-C1）。 */
export interface ObservedMessageEvent {
  readonly id: string
  /** 逻辑会话键，与 `recentOfConversation` 的键一致。 */
  readonly conversationKey: string
  /** 当前历史头；重置、切换、分支会改变它。 */
  readonly sessionId: string
  readonly routeId: string
  readonly platform: string
  readonly platformMessageId?: string | undefined
  readonly userId?: string | undefined
  readonly name?: string | undefined
  readonly time: number
  readonly self: boolean
  /** 由历史接口取得，而非实时接收。 */
  readonly backfilled: boolean
  readonly content: readonly ChatBlock[]
}

/** 按会话和历史读取可见历史的能力（M05-C1）。 */
export interface HistoryReader {
  /** 该会话是否有可用的历史来源；无来源时调用方从实时消息开始建池。 */
  available(conversationKey: string): boolean
  /** 读取 `sessionId` 这一历史中、`before` 之前的最多 `limit` 条，按时间正序。 */
  read(input: {
    conversationKey: string
    sessionId: string
    limit: number
    before?: number | undefined
  }): Promise<readonly ObservedMessageEvent[]>
}

/** 一轮实际交付的消息（M05-C2）。 */
export interface DeliveredReply {
  readonly conversationKey: string
  readonly sessionId: string
  /** 本轮实际生效的预设，不取交付时刻的最新配置。 */
  readonly presetId: string
  /** 被回复的入站消息 id；分段交付时各段共用同一个值。 */
  readonly replyTo?: string | undefined
  readonly messageIds: readonly string[]
  readonly content: readonly ChatBlock[]
}

/** 显式会话变化（M02-C1）。 */
export type ConversationChange =
  | { readonly kind: 'reset' | 'switch' | 'fork'; readonly previousSessionId: string; readonly currentSessionId: string }
  | { readonly kind: 'preset-applied'; readonly presetId: string; readonly turn: number }

export type ConversationChangeEvent = ConversationChange & {
  readonly conversationKey: string
  readonly sessionId: string
}

/**
 * 插件从 ChatLuna v2 取得的公共入口。实现由框架侧提供，插件只依赖该形状。
 */
export interface ChatLunaCollector {
  /** 订阅统一采集事件（M05-C1）。 */
  observe(listener: (message: ObservedMessageEvent) => void): () => void
  /** 订阅实际交付事件（M05-C2）。 */
  delivered(listener: (reply: DeliveredReply) => void): () => void
  /** 订阅会话与预设变化（M02-C1）。 */
  changed(listener: (event: ConversationChangeEvent) => void): () => void
  readonly history: HistoryReader
  /** 无活跃 Agent 时也成立的会话归属查询。 */
  attribution(conversationKey: string): { sessionId: string; presetId: string } | undefined
}

declare module 'cordis' {
  interface Context {
    chatluna_collector: ChatLunaCollector
  }
}