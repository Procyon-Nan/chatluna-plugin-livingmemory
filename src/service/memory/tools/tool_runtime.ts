import { isRecord } from '@chatluna/utils/object'
import type { MemoryScope } from '../../../contracts/memory.ts'

/**
 * 工具调用所属的会话与预设。
 *
 * v1 从 langchain 的 `ToolRunnableConfig.configurable` 读取，v2 的工具 `run`
 * 收到的是 `ToolCallContext`：`call.agent` 是发起本轮调用的 Agent，
 * `agent.options` 携带 `presetId` 与 `conversationKey`，`agent.options.location`
 * 是会话所在的平台/群/频道。子代理以自己的 Agent 发起调用，其
 * `options.permissions.origin` 非空，据此拒绝。
 */
export interface LivingMemoryToolAgent {
    readonly options: {
        readonly presetId?: string | undefined
        readonly conversationKey?: string | undefined
        readonly location?:
            | {
                  readonly platform?: string | undefined
                  readonly user?: string | undefined
                  readonly guild?: string | undefined
                  readonly channel?: string | undefined
              }
            | undefined
        readonly permissions?: { readonly origin?: readonly string[] | undefined } | undefined
    }
}

export const agentOfTool = (agent: object | undefined): LivingMemoryToolAgent | undefined =>
    isRecord(agent) && isRecord(agent['options']) ? (agent as unknown as LivingMemoryToolAgent) : undefined

export type LivingMemoryToolPresetIdResolution =
    | { ok: true; presetId: string }
    | { ok: false; reason: 'missing-preset' }

/**
 * 解析工具调用所属的记忆预设。v2 的引擎把预设解析结果写进 `agent.options.presetId`：
 * Character 引擎同样写入预设记录自身的 id，因此不再需要 v1 的「（Character）」后缀拼接。
 */
export const resolveToolMemoryPresetId = (
    agent: LivingMemoryToolAgent | undefined
): LivingMemoryToolPresetIdResolution => {
    const presetId = agent?.options.presetId
    if (presetId === undefined || presetId.trim().length === 0) {
        return { ok: false, reason: 'missing-preset' }
    }
    return { ok: true, presetId }
}

export type LivingMemoryToolScopeResolution =
    | { ok: true; scope: MemoryScope }
    | {
          ok: false
          reason: 'missing-preset' | 'subagent-tool-call' | 'missing-conversation-id'
      }

/**
 * 从工具调用上下文重建 `MemoryScope`。会话键直接采用 v2 解析结果，
 * 平台与群/频道取自 `location`；子代理调用一律拒绝。
 */
export const resolveToolMemoryScope = (
    agent: LivingMemoryToolAgent | undefined
): LivingMemoryToolScopeResolution => {
    const presetIdResolution = resolveToolMemoryPresetId(agent)
    if (presetIdResolution.ok === false) {
        return presetIdResolution
    }
    if ((agent?.options.permissions?.origin?.length ?? 0) > 0) {
        return { ok: false, reason: 'subagent-tool-call' }
    }
    const conversationId = agent?.options.conversationKey
    if (conversationId === undefined || conversationId.length === 0) {
        return { ok: false, reason: 'missing-conversation-id' }
    }

    const location = agent?.options.location
    const scope: MemoryScope = {
        conversationId,
        presetId: presetIdResolution.presetId
    }
    if (location?.platform !== undefined) scope.platform = location.platform
    if (location?.user !== undefined) scope.userId = location.user
    if (location?.guild !== undefined) scope.guildId = location.guild
    if (location?.channel !== undefined) scope.channelId = location.channel
    return { ok: true, scope }
}

export const describeLivingMemoryToolScopeFailure = (
    reason: Exclude<LivingMemoryToolScopeResolution, { ok: true }>['reason']
) => {
    switch (reason) {
        case 'missing-preset':
            return 'Missing preset in the current tool call.'
        case 'subagent-tool-call':
            return 'Sub-agent tool calls are not supported by this tool.'
        case 'missing-conversation-id':
            return 'Missing conversation id in the current tool call.'
    }
}
