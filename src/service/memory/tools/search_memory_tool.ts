import { withModelMemoryIds, type MemoryIdSource } from '../model_ids.ts'
import { isCustomConversation } from '../../../routing.ts'
import { defineTool, type ToolCallContext, type ToolDefinition } from '@chatluna/tool'
import type { LivingMemorySearchProvider } from '../../../contracts/workflows.ts'
import { renderMemoriesForModel } from '../../prompts/memory_entries.ts'
import { memorySearchTool } from '../../prompts/memory_tools.ts'
import {
    toolContext,
    type ToolRouteResolver,
    describeLivingMemoryToolScopeFailure,
    resolveToolMemoryPresetId,
    resolveToolMemoryScope
} from './tool_runtime.ts'

interface SearchArgs {
    searchTexts: string[]
    searchKeywords?: string[]
}

/**
 * 记忆检索工具。检索固定只看活跃记忆；开启会话隔离时把当前会话作为
 * 检索范围，否则在整个预设内检索。
 */
export const createSearchMemoryTool = (
    searchProvider: LivingMemorySearchProvider & MemoryIdSource,
    resolveRoute?: ToolRouteResolver
): ToolDefinition<SearchArgs> =>
    defineTool({
        name: memorySearchTool.name,
        description: memorySearchTool.description,
        args: memorySearchTool.schema,
        traits: { effect: 'read' },
        async run(input: SearchArgs, call: ToolCallContext) {
            const { agent, isolated, routeId } = toolContext(call, resolveRoute)
            let presetId: string
            let conversationId: string | undefined
            if (isCustomConversation(agent?.options.conversationKey) && !routeId) {
                throw new Error('自定义会话缺少本次消息的来源路由。')
            }
            if (isolated) {
                const resolution = resolveToolMemoryScope(agent, routeId)
                if (resolution.ok === false) {
                    throw new Error(describeLivingMemoryToolScopeFailure(resolution.reason))
                }
                presetId = resolution.scope.presetId
                conversationId = resolution.scope.conversationId
            } else {
                const presetIdResolution = resolveToolMemoryPresetId(agent)
                if (presetIdResolution.ok === false) {
                    throw new Error(describeLivingMemoryToolScopeFailure(presetIdResolution.reason))
                }
                presetId = presetIdResolution.presetId
            }

            const results = await searchProvider.searchMemories(
                presetId,
                { ...input, memoryTypes: ['all'], memoryStatus: 'active' },
                conversationId
            )
            if (!results.length) return '没有找到相关记忆。'
            return renderMemoriesForModel(await withModelMemoryIds(searchProvider, presetId, results), true)
        }
    })
