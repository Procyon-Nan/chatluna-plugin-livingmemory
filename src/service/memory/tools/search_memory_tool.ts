import { defineTool, type ToolCallContext, type ToolDefinition } from '@chatluna/tool'
import type { LivingMemorySearchResult } from '../../../contracts/memory.ts'
import type { LivingMemorySearchProvider } from '../../../contracts/workflows.ts'
import {
    contextMemoryFields,
    renderMemoriesForModel,
    searchMemoryFields
} from '../../prompts/memory_entries.ts'
import { memorySearchTool } from '../../prompts/memory_tools.ts'
import {
    agentOfTool,
    describeLivingMemoryToolScopeFailure,
    resolveToolMemoryPresetId,
    resolveToolMemoryScope
} from './tool_runtime.ts'

const noMemoryFoundMessage = '没有找到相关记忆。'

interface SearchArgs {
    searchTexts: string[]
    searchKeywords?: string[]
}

/**
 * 记忆检索工具。检索固定只看活跃记忆；开启会话隔离时把当前会话作为
 * 检索范围，否则在整个预设内检索。
 */
export const createSearchMemoryTool = (
    searchProvider: LivingMemorySearchProvider,
    includeMemoryIds: boolean,
    enableConversationIsolation = false
): ToolDefinition<SearchArgs> =>
    defineTool({
        name: memorySearchTool.name,
        description: memorySearchTool.description,
        args: memorySearchTool.schema,
        traits: { effect: 'read' },
        async run(input: SearchArgs, call: ToolCallContext) {
            const agent = agentOfTool(call.agent)
            let presetId: string
            let conversationId: string | undefined
            if (enableConversationIsolation) {
                const resolution = resolveToolMemoryScope(agent)
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
            // 模型看到的是渲染后的记忆文本，与 v1 的工具输出一致。
            return formatResults(results, includeMemoryIds)
        }
    })

const formatResults = (results: LivingMemorySearchResult[], includeMemoryIds: boolean) => {
    if (results.length === 0) {
        return noMemoryFoundMessage
    }
    return renderMemoriesForModel(results, {
        fields: includeMemoryIds ? searchMemoryFields : contextMemoryFields
    })
}