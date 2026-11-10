import type { ToolCallContext } from '@chatluna/tool'
import { memorySourceId } from '../helpers.ts'
import { isRecord } from '@chatluna/utils/object'
import type { MemoryScope } from '../../../contracts/memory.ts'

/**
 * 工具调用所属的会话与预设。
 *
 * call.agent 是发起本轮工具调用的 Agent。
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
                  readonly route?: string | undefined
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

/** 有对话轮次时使用唤醒来源；独立调用使用宿主在本次工具调用上传入的地点。 */
export type ToolRouteResolver = (
    agent: LivingMemoryToolAgent | undefined, routeId: string | undefined
) => { isolated: boolean; routeId?: string | undefined }

export function toolContext(call: ToolCallContext, resolve?: ToolRouteResolver) {
    const agent = agentOfTool(call.agent)
    const routeId = call.routeId ?? call.location?.route ?? agent?.options.location?.route
    const route = resolve?.(agent, routeId) ?? { isolated: false, routeId }
    return { agent, ...route }
}

export type LivingMemoryToolPresetIdResolution =
    | { ok: true; presetId: string }
    | { ok: false; reason: 'missing-preset' }

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
 * 从工具调用的 Agent 读取会话作用域；子代理调用一律拒绝。
 */
export const resolveToolMemoryScope = (
    agent: LivingMemoryToolAgent | undefined,
    routeId?: string
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
        conversationId: memorySourceId(conversationId, routeId),
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
