import type { Context } from 'cordis'
import type {} from '@chatluna/preset'
import type { MemoryScope } from '../../contracts/memory.ts'
import type { MemoryTranscriptOrigin } from '../transcript/origin_context.ts'
import { toNonEmptyString } from '../shared/utils.ts'

export interface QueueExtractionOptions {
    windowMessages: number
    enableAutoDream: boolean
    includeOverheard: boolean
    resolveTranscriptOrigin: () => Promise<MemoryTranscriptOrigin>
}

export interface CharacterPresetPromptSource {
    system: {
        rawString: string
    }
}

export interface CharacterPresetProvider {
    preset: {
        getAllPreset?: () => Promise<unknown>
        getPreset: (
            presetName: string,
            loadForDisk?: boolean,
            throwError?: boolean
        ) => Promise<CharacterPresetPromptSource>
    }
}

export interface CharacterMemoryScopeSession {
    isDirect?: boolean
    userId?: string
    guildId?: string
}

const toCharacterSessionId = (value: unknown) => {
    return typeof value === 'string' && value.trim().length > 0
        ? value.trim()
        : undefined
}

/**
 * Character 集成约定的会话键规则：私聊为 private:{userId}，群聊为 group:{guildId}。
 * 与 chatluna_character 事件 payload 中的 sessionKey 同格式；推导规则唯一实现于此，
 * character 中间件与工具 runtime 共用，避免多处拷贝漂移。
 */
export const toCharacterMemoryConversationId = (
    session: CharacterMemoryScopeSession
) => {
    const id = session.isDirect
        ? toCharacterSessionId(session.userId)
        : toCharacterSessionId(session.guildId)
    if (id == null) {
        return undefined
    }

    return `${session.isDirect ? 'private' : 'group'}:${id}`
}

export interface AgentRunContextFields {
    kind?: unknown
    source?: unknown
    conversationId?: unknown
}

export const toAgentRunContextFields = (
    value: unknown
): AgentRunContextFields | null => {
    if (value == null || typeof value !== 'object') {
        return null
    }
    return value as AgentRunContextFields
}

/**
 * 子代理运行的会话 id 为合成值（subagent:${uuid}），不对应真实用户会话；
 * 记忆工作流（注入、提取、主动创建）均不处理子代理运行。
 */
export const isSubagentRunContext = (value: unknown) => {
    return toAgentRunContextFields(value)?.kind === 'subagent'
}

/**
 * 取主链路运行的会话 id：子代理运行与缺失/空白会话 id 均返回 undefined。
 */
export const resolveMainRunConversationId = (value: unknown) => {
    if (isSubagentRunContext(value)) {
        return undefined
    }
    return toNonEmptyString(toAgentRunContextFields(value)?.conversationId)
}

export const normalizeText = (value: string) => value.trim()

/**
 * 作用域唯一键：presetId 与 conversationId 以换行符拼接。
 * 提取缓冲、召回锁与说话人标签缓存均以该键隔离数据。
 */
export const scopeKey = (
    scope: Pick<MemoryScope, 'presetId' | 'conversationId'>
) => `${scope.presetId}\n${scope.conversationId}`

/**
 * 解析面向 LLM 的助手标签：优先使用 preset 展示名（presetLabel），
 * 缺省或为空白时回退 presetId。
 */
export const resolveScopeAssistantLabel = (
    scope: Pick<MemoryScope, 'presetLabel' | 'presetId'>
): string => scope.presetLabel?.trim() || scope.presetId

/**
 * 按预设 id 取展示名。v2 的 Character 引擎直接以其预设 id 运行，预设的展示名
 * 就是角色名，不再需要 v1 的「（Character）」后缀裁剪。
 */
export const resolvePresetAssistantLabel = (
    ctx: Context,
    presetId: string
): string => ctx.presets.get(presetId)?.name.trim() || presetId

/**
 * 取预设 system 部分的未渲染原文，作为人设卡片的删减来源。不经模板渲染器、
 * 不取任何变量值：system 部分应为固定人设，写入其中的占位符原样保留。
 *
 * v1 直接读 ChatLuna 预设的 system 消息原文；v2 的预设在 `ctx.presets` 里按
 * kind 组织成提示块，这里取 system 区中角色为 system 的块，按 order 拼接。
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