import { withIndexWarning } from '../../vector_index/errors.ts'
import { modelMemoryIds, withModelMemoryIds, type MemoryIdSource } from '../model_ids.ts'
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
import { missingMemory } from '../errors.ts'
import { mergeToolResult, splitToolResult } from './results.ts'
import { resolveSpeakerKeysByLabels } from '../speaker_identity.ts'
import {
    agentOfTool,
    type ToolRouteResolver,
    toolContext,
    describeLivingMemoryToolScopeFailure,
    resolveToolMemoryPresetId,
    resolveToolMemoryScope
} from './tool_runtime.ts'

function toolPresetId(call: ToolCallContext) {
    const result = resolveToolMemoryPresetId(agentOfTool(call.agent))
    if (!result.ok) throw new Error(describeLivingMemoryToolScopeFailure(result.reason))
    return result.presetId
}

export const createCreateMemoryTool = (
    creation: LivingMemoryCreationProvider & MemoryIdSource,
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
                const record = await withIndexWarning(
                    creation.createMemory(resolution.scope, toMemoryFields(memory), speakerKeys), warnings, '保存'
                )
                if (record) createdMemories.push({ id: record.id, type: record.type })
            }

            return { createdMemories: await withModelMemoryIds(creation, resolution.scope.presetId, createdMemories, warnings), warnings }
        }
    })
}

export const createUpdateMemoryTool = (
    updates: LivingMemoryUpdateProvider & MemoryIdSource
): ToolDefinition<{ memoryId: string; memory: ExtractedMemoryItem }> =>
    defineTool({
        name: memoryUpdateTool.name,
        description: memoryUpdateTool.description,
        args: memoryUpdateTool.schema,
        traits: { effect: 'write' },
        async run(input: { memoryId: string; memory: ExtractedMemoryItem }, call: ToolCallContext) {
            const presetId = toolPresetId(call)

            const { memory } = input
            const refs = await modelMemoryIds(updates, presetId, [input.memoryId])
            const memoryId = refs.resolve(input.memoryId)
            const speakers = await updates.listPresetSpeakers(presetId)
            const speakerKeys = resolveSpeakerKeysByLabels(memory.speakerLabels, speakers)
            const warnings: string[] = []
            const record = await withIndexWarning(
                updates.updateActiveMemory(presetId, memoryId, toAttributedMemory(memory, speakerKeys)), warnings, '更新'
            )
            if (record === null) throw missingMemory(input.memoryId)
            return { memoryId: refs.display(memoryId), updated: true, warnings }
        }
    })

export const createMergeMemoriesTool = (
    merges: LivingMemoryMergeProvider & MemoryIdSource
): ToolDefinition<{ sourceMemoryIds: string[]; memory: ExtractedMemoryItem }> =>
    defineTool({
        name: memoryMergeTool.name,
        description: memoryMergeTool.description,
        args: memoryMergeTool.schema,
        traits: { effect: 'write' },
        async run(input: { sourceMemoryIds: string[]; memory: ExtractedMemoryItem }, call: ToolCallContext) {
            const presetId = toolPresetId(call)

            const refs = await modelMemoryIds(merges, presetId, input.sourceMemoryIds)
            const sourceMemoryIds = input.sourceMemoryIds.map(id => refs.resolve(id))
            const speakers = await merges.listPresetSpeakers(presetId)
            const { memory } = input
            const speakerKeys = resolveSpeakerKeysByLabels(memory.speakerLabels, speakers)
            const result = await merges.mergeActiveMemories(
                presetId,
                sourceMemoryIds,
                toAttributedMemory(memory, speakerKeys)
            )
            return mergeToolResult(merges, presetId, sourceMemoryIds, result)
        }
    })

export const createSplitMemoryTool = (
    splits: LivingMemorySplitProvider & MemoryIdSource
): ToolDefinition<{ sourceMemoryId: string; memories: ExtractedMemoryItem[] }> =>
    defineTool({
        name: memorySplitTool.name,
        description: memorySplitTool.description,
        args: memorySplitTool.schema,
        traits: { effect: 'write' },
        async run(input: { sourceMemoryId: string; memories: ExtractedMemoryItem[] }, call: ToolCallContext) {
            const presetId = toolPresetId(call)
            const refs = await modelMemoryIds(splits, presetId, [input.sourceMemoryId])
            const sourceId = refs.resolve(input.sourceMemoryId)
            const speakers = await splits.listPresetSpeakers(presetId)
            const result = await splits.splitActiveMemory(
                presetId,
                sourceId,
                input.memories.map((memory) =>
                    toAttributedMemory(memory, resolveSpeakerKeysByLabels(memory.speakerLabels, speakers))
                )
            )
            return splitToolResult(splits, presetId, sourceId, result)
        }
    })

export const createDeleteMemoryTool = (
    archives: LivingMemoryArchiveProvider & MemoryIdSource
): ToolDefinition<{ memoryId: string }> =>
    defineTool({
        name: memoryDeleteTool.name,
        description: memoryDeleteTool.description,
        args: memoryDeleteTool.schema,
        traits: { effect: 'write' },
        async run(input: { memoryId: string }, call: ToolCallContext) {
            const presetId = toolPresetId(call)

            const refs = await modelMemoryIds(archives, presetId, [input.memoryId])
            const memoryId = refs.resolve(input.memoryId)
            const warnings: string[] = []
            const result = await withIndexWarning(archives.archiveActiveMemories(presetId, [memoryId]), warnings, '归档')
            if (result?.archived === 0) throw missingMemory(input.memoryId)
            return { memoryId: refs.display(memoryId), deleted: true, warnings }
        }
    })

export const createGetMessagesTool = (
    sources: LivingMemorySourceProvider & MemoryIdSource
): ToolDefinition<{ memoryId: string }> =>
    defineTool({
        name: memoryGetMessagesTool.name,
        description: memoryGetMessagesTool.description,
        args: memoryGetMessagesTool.schema,
        traits: { effect: 'read' },
        async run(input: { memoryId: string }, call: ToolCallContext) {
            const presetId = toolPresetId(call)

            const refs = await modelMemoryIds(sources, presetId, [input.memoryId])
            const memory = await sources.getMemorySourceMessages(presetId, refs.resolve(input.memoryId))
            if (memory === null) throw missingMemory(input.memoryId)
            return renderMemorySourceMessagesForModel({ ...memory, id: refs.display(memory.id) })
        }
    })