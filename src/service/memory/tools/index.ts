import type { Context } from 'cordis'
import type { ToolDefinition } from '@chatluna/tool'
import type { LivingMemoryMemoryProviders } from '../../app/memory_providers.ts'
import {
    createCreateMemoryTool,
    createDeleteMemoryTool,
    createGetMessagesTool,
    createMergeMemoriesTool,
    createSplitMemoryTool,
    createUpdateMemoryTool
} from './memory_tools.ts'
import type { ToolRouteResolver } from './tool_runtime.ts'
import { createSearchMemoryTool } from './search_memory_tool.ts'
import { memoryCreateTool, memoryDeleteTool, memoryGetMessagesTool, memoryMergeTool, memorySearchTool, memorySplitTool, memoryUpdateTool } from '../../prompts/memory_tools.ts'

/** 配置里可选的记忆工具清单；名称与工具定义同源。 */
export const livingMemoryToolNames = [
    memorySearchTool.name,
    memoryGetMessagesTool.name,
    memoryCreateTool(1).name,
    memoryUpdateTool.name,
    memoryMergeTool.name,
    memorySplitTool.name,
    memoryDeleteTool.name
] as const

export type LivingMemoryToolName = (typeof livingMemoryToolNames)[number]

export interface LivingMemoryToolRegistration {
    enabled: readonly string[]
    createToolMaxMemories: number
    resolveRoute: ToolRouteResolver
}

/**
 * 注册记忆工具。只注册配置里启用的工具，未启用时不影响其它能力。
 * 工具通过 `call.agent` 取得预设与会话，不依赖请求级的中间件状态。
 */
export const registerLivingMemoryTools = (
    ctx: Context,
    providers: LivingMemoryMemoryProviders,
    options: LivingMemoryToolRegistration
) => {
    const enabled = new Set(options.enabled)
    const tools: ToolDefinition<any>[] = [
        createSearchMemoryTool(providers, true, options.resolveRoute),
        createGetMessagesTool(providers),
        createCreateMemoryTool(providers, options.createToolMaxMemories, options.resolveRoute),
        createUpdateMemoryTool(providers),
        createMergeMemoriesTool(providers),
        createSplitMemoryTool(providers),
        createDeleteMemoryTool(providers)
    ]
    return tools
        .filter((tool) => enabled.has(tool.name))
        .map((tool) => ctx.tools.define(tool))
}