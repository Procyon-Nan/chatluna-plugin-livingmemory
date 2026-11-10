import type { Context } from 'cordis'
import type {} from '@chatluna/preset'
import { isCustomConversation, type RouteSettings } from '../../routing.ts'
import type { MemoryScope, SnapshotScope } from '../../contracts/memory.ts'
import type { ChatHistoryEntry } from '../chat_history.ts'

export interface QueueExtractionOptions {
    routeId?: string
    windowMessages: number
    enableAutoDream: boolean
    includeOverheard: boolean
    formatTranscriptHeader: (entries: readonly ChatHistoryEntry[]) => Promise<string>
}

/** 消费进度按预设、来源路由（自定义会话）和会话区分；重置时按会话整体清除。 */
export const scopeKey = (
    scope: Pick<MemoryScope, 'presetId' | 'conversationId'>, routeId?: string
) => [scope.presetId, ...(routeId ? [routeId] : []), scope.conversationId].join('\n')

/** 宿主自定义会话可以跨地点复用；其它会话键保留个人和分线归属。 */
export function memorySourceId(conversationId: string, routeId?: string): string {
    if (!isCustomConversation(conversationId)) return conversationId
    if (!routeId) throw new Error('自定义会话缺少本次消息的来源路由。')
    return routeId
}

export function snapshotScopeOf(
    { presetId, conversationId }: MemoryScope,
    settings: Pick<RouteSettings, 'snapshotScope' | 'enableConversationIsolation'>
): SnapshotScope {
    const shared = settings.snapshotScope === 'preset' && !settings.enableConversationIsolation
    return { presetId, conversationId: shared ? null : conversationId }
}

/**
 * 解析面向 LLM 的助手标签：优先使用 preset 展示名（presetLabel），
 * 缺省或为空白时回退 presetId。
 */
export const resolveScopeAssistantLabel = (
    scope: Pick<MemoryScope, 'presetLabel' | 'presetId'>
): string => scope.presetLabel?.trim() || scope.presetId

export const resolvePresetAssistantLabel = (
    ctx: Context,
    presetId: string
): string => ctx.presets.get(presetId)?.name.trim() || presetId

/**
 * 取预设 system 部分的未渲染原文，作为人设卡片的删减来源。不经模板渲染器、
 * 不取任何变量值：system 部分应为固定人设，写入其中的占位符原样保留。
 */
export const resolvePresetPrompt = async (
    ctx: Context,
    presetId: string
): Promise<string> => {
    const record = ctx.presets.get(presetId)
    if (record === undefined) {
        throw new Error(`preset not found: ${presetId}`)
    }
    const blocks = ctx.presets.blocks(record) ?? []
    return blocks
        .filter(
            (block) =>
                block.zone === 'system' &&
                (block.role === undefined || block.role === 'system') &&
                typeof block.content === 'string'
        )
        .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
        .map((block) => (block.content as string).trim())
        .filter((content) => content.length > 0)
        .join('\n\n')
        .trim()
}