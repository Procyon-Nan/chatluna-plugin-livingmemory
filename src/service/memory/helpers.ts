import type { Context } from 'cordis'
import type {} from '@chatluna/preset'
import type { RouteSettings } from '../../routing.ts'
import type { MemoryScope, SnapshotScope } from '../../contracts/memory.ts'
import type { MemoryTranscriptOrigin } from '../transcript/origin_context.ts'
import type { ChatHistoryEntry } from '../chat_history.ts'

export interface QueueExtractionOptions {
    windowMessages: number
    enableAutoDream: boolean
    includeOverheard: boolean
    resolveTranscriptOrigin: (entries: readonly ChatHistoryEntry[]) => Promise<MemoryTranscriptOrigin>
}

/**
 * 作用域唯一键：presetId 与 conversationId 以换行符拼接。
 * 提取缓冲、召回锁与说话人标签缓存均以该键隔离数据。
 */
export const scopeKey = (
    scope: Pick<MemoryScope, 'presetId' | 'conversationId'>
) => `${scope.presetId}\n${scope.conversationId}`

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