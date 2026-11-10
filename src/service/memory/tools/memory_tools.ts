import { defineTool, type ToolCallContext, type ToolDefinition } from '@chatluna/tool'
import { toAttributedMemory, toMemoryFields } from '../entry_fields.ts'
import type {
    ExtractedMemoryItem,
    LivingMemoryArchiveProvider,
    LivingMemoryCreationProvider,
    LivingMemoryMergeProvider,
    LivingMemorySourceProvider,
    LivingMemorySplitProvider,
    LivingMemoryUpdateProvider
} from '../../../contracts/workflows.ts'
import { renderMemorySourceMessagesForModel } from '../../prompts/memory_entries.ts'
import {
    memoryCreateTool,
    memoryDeleteTool,
    memoryGetMessagesTool,
    memoryMergeTool,
    memorySplitTool,
    memoryUpdateTool
} from '../../prompts/memory_tools.ts'
import { MemoryInputError } from '../errors.ts'
import { LivingMemoryFactsCommittedError } from '../../vector_index/errors.ts'
import { resolveSpeakerKeysByLabels } from '../speaker_identity.ts'
import {
    agentOfTool,
    type ToolRouteResolver,
    toolContext,
    describeLivingMemoryToolScopeFailure,
    resolveToolMemoryPresetId,
    resolveToolMemoryScope
} from './tool_runtime.ts'

export const createCreateMemoryTool = (
    creation: LivingMemoryCreationProvider,
    maxMemories: number,
    resolveRoute?: ToolRouteResolver
): ToolDefinition<{ memories: ExtractedMemoryItem[] }> => {
    const doc = memoryCreateTool(maxMemories)
    return defineTool({
        name: doc.name,
        description: doc.description,
        args: doc.schema,
        traits: { effect: 'write' },
        async run(input: { memories: ExtractedMemoryItem[] }, call: ToolCallContext) {
            const { agent, routeId } = toolContext(call, resolveRoute)
            const resolution = resolveToolMemoryScope(agent, routeId)
            if (resolution.ok === false) {
                throw new Error(describeLivingMemoryToolScopeFailure(resolution.reason))
            }

            const createdMemories: { id: string; type: string }[] = []
            const warnings: string[] = []
            const speakers = await creation.listPresetSpeakers(resolution.scope.presetId)
            for (const memory of input.memories) {
                const speakerKeys = resolveSpeakerKeysByLabels(memory.speakerLabels, speakers)
                try {
                    const record = await creation.createMemory(
                        resolution.scope,
                        toMemoryFields(memory),
                        speakerKeys
                    )
                    createdMemories.push({ id: record.id, type: record.type })
                } catch (error) {
                    if (error instanceof LivingMemoryFactsCommittedError) {
                        // 事实已落库，仅索引同步失败：如实按已保存处理并附警告。
                        // 返回失败会诱导模型重试，产生重复记忆行。
                        warnings.push(
                            '记忆已保存，但向量索引同步失败，已调度后台自动对账：' + error.message
                        )
                        continue
                    }
                    throw error
                }
            }

            return { createdMemories, warnings }
        }
    })
}

export const createUpdateMemoryTool = (
    updates: LivingMemoryUpdateProvider
): ToolDefinition<{ memoryId: string; memory: ExtractedMemoryItem }> =>
    defineTool({
        name: memoryUpdateTool.name,
        description: memoryUpdateTool.description,
        args: memoryUpdateTool.schema,
        traits: { effect: 'write' },
        async run(input: { memoryId: string; memory: ExtractedMemoryItem }, call: ToolCallContext) {
            const resolution = resolveToolMemoryPresetId(agentOfTool(call.agent))
            if (resolution.ok === false) {
                throw new Error(describeLivingMemoryToolScopeFailure(resolution.reason))
            }

            const speakers = await updates.listPresetSpeakers(resolution.presetId)
            const { memory, memoryId } = input
            const speakerKeys = resolveSpeakerKeysByLabels(memory.speakerLabels, speakers)
            const warnings: string[] = []
            try {
                const record = await updates.updateActiveMemory(
                    resolution.presetId, memoryId, toAttributedMemory(memory, speakerKeys)
                )
                if (record === null) {
                    throw new MemoryInputError(
                        `不存在 ID 为 ${memoryId} 的记忆，请重新查明记忆 ID 后再调用。`
                    )
                }
            } catch (error) {
                if (!(error instanceof LivingMemoryFactsCommittedError)) {
                    throw error
                }
                warnings.push(
                    '记忆已更新，但向量索引同步失败，已调度后台自动对账：' + error.message
                )
            }
            return { memoryId, updated: true, warnings }
        }
    })

export const createMergeMemoriesTool = (
    merges: LivingMemoryMergeProvider
): ToolDefinition<{ sourceMemoryIds: string[]; memory: ExtractedMemoryItem }> =>
    defineTool({
        name: memoryMergeTool.name,
        description: memoryMergeTool.description,
        args: memoryMergeTool.schema,
        traits: { effect: 'write' },
        async run(input: { sourceMemoryIds: string[]; memory: ExtractedMemoryItem }, call: ToolCallContext) {
            const resolution = resolveToolMemoryPresetId(agentOfTool(call.agent))
            if (resolution.ok === false) {
                throw new Error(describeLivingMemoryToolScopeFailure(resolution.reason))
            }

            const speakers = await merges.listPresetSpeakers(resolution.presetId)
            const { sourceMemoryIds, memory } = input
            const speakerKeys = resolveSpeakerKeysByLabels(memory.speakerLabels, speakers)
            const result = await merges.mergeActiveMemories(
                resolution.presetId,
                sourceMemoryIds,
                toAttributedMemory(memory, speakerKeys)
            )
            return {
                memoryId: result.memory.id,
                archivedMemoryIds: sourceMemoryIds,
                merged: true,
                warnings: result.warnings
            }
        }
    })

export const createSplitMemoryTool = (
    splits: LivingMemorySplitProvider
): ToolDefinition<{ sourceMemoryId: string; memories: ExtractedMemoryItem[] }> =>
    defineTool({
        name: memorySplitTool.name,
        description: memorySplitTool.description,
        args: memorySplitTool.schema,
        traits: { effect: 'write' },
        async run(input: { sourceMemoryId: string; memories: ExtractedMemoryItem[] }, call: ToolCallContext) {
            const resolution = resolveToolMemoryPresetId(agentOfTool(call.agent))
            if (resolution.ok === false) {
                throw new Error(describeLivingMemoryToolScopeFailure(resolution.reason))
            }
            const speakers = await splits.listPresetSpeakers(resolution.presetId)
            const result = await splits.splitActiveMemory(
                resolution.presetId,
                input.sourceMemoryId,
                input.memories.map((memory) =>
                    toAttributedMemory(memory, resolveSpeakerKeysByLabels(memory.speakerLabels, speakers))
                )
            )
            return {
                memoryIds: result.memories.map((memory) => memory.id),
                archivedMemoryId: input.sourceMemoryId,
                split: true,
                warnings: result.warnings
            }
        }
    })

export const createDeleteMemoryTool = (
    archives: LivingMemoryArchiveProvider
): ToolDefinition<{ memoryId: string }> =>
    defineTool({
        name: memoryDeleteTool.name,
        description: memoryDeleteTool.description,
        args: memoryDeleteTool.schema,
        traits: { effect: 'write' },
        async run(input: { memoryId: string }, call: ToolCallContext) {
            const resolution = resolveToolMemoryPresetId(agentOfTool(call.agent))
            if (resolution.ok === false) {
                throw new Error(describeLivingMemoryToolScopeFailure(resolution.reason))
            }

            const warnings: string[] = []
            try {
                const result = await archives.archiveActiveMemories(resolution.presetId, [input.memoryId])
                if (result.archived === 0) {
                    throw new MemoryInputError(
                        `不存在 ID 为 ${input.memoryId} 的记忆，请重新查明记忆 ID 后再调用。`
                    )
                }
            } catch (error) {
                if (!(error instanceof LivingMemoryFactsCommittedError)) {
                    throw error
                }
                warnings.push(
                    '记忆已归档，但向量索引同步失败，已调度后台自动对账：' + error.message
                )
            }
            return { memoryId: input.memoryId, deleted: true, warnings }
        }
    })

export const createGetMessagesTool = (
    sources: LivingMemorySourceProvider
): ToolDefinition<{ memoryId: string }> =>
    defineTool({
        name: memoryGetMessagesTool.name,
        description: memoryGetMessagesTool.description,
        args: memoryGetMessagesTool.schema,
        traits: { effect: 'read' },
        async run(input: { memoryId: string }, call: ToolCallContext) {
            const resolution = resolveToolMemoryPresetId(agentOfTool(call.agent))
            if (resolution.ok === false) {
                throw new Error(describeLivingMemoryToolScopeFailure(resolution.reason))
            }

            const memory = await sources.getMemorySourceMessages(resolution.presetId, input.memoryId)
            if (memory === null) {
                throw new Error(
                    `不存在 ID 为 ${input.memoryId} 的记忆，请重新查明记忆 ID 后再调用。`
                )
            }
            return renderMemorySourceMessagesForModel(memory)
        }
    })