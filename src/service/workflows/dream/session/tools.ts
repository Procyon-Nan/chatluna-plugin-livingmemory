import { withIndexWarning } from '../../../vector_index/errors.ts'
import { modelMemoryIds, type MemoryIdSource } from '../../../memory/model_ids.ts'
import { toAttributedMemory } from '../../../memory/entry_fields.ts'
import type { ExtractedMemoryItem } from '../../../../contracts/workflows.ts'
import type { PresetSpeakerRecord } from '../../../../contracts/memory.ts'
import type { LivingMemoryMutationService } from '../../../app/mutation_service.ts'
import { mergeToolResult, splitToolResult } from '../../../memory/tools/results.ts'
import { MemoryInputError, missingMemory } from '../../../memory/errors.ts'
import { resolveSpeakerKeysByLabels } from '../../../memory/speaker_identity.ts'
import {
    memoryCheckedTool,
    memoryDeleteTool,
    memoryMergeTool,
    memorySplitTool,
    memoryUpdateTool
} from '../../../prompts/memory_tools.ts'
import type { LivingMemoryLoopTool } from '../../tool_call.ts'
import {
    recordDreamOperation,
    recordDreamSpeakers,
    type DreamSessionState
} from './state.ts'

interface DreamSessionToolDependencies {
    presetId: string
    state: DreamSessionState
    speakers: readonly PresetSpeakerRecord[]
    repository: MemoryIdSource & {
        getEntriesByPresetAndIds(presetId: string, ids: string[]): Promise<{ id: string; status: string }[]>
    }
    mutations: Pick<
        LivingMemoryMutationService,
        | 'updateActiveMemory'
        | 'mergeActiveMemories'
        | 'splitActiveMemory'
        | 'archiveActiveMemories'
    >
}

/**
 * 这些工具只在当前 Dream 批次内使用，不注册到对话 Agent。
 */
export const createDreamSessionTools = ({
    presetId,
    state,
    speakers,
    repository,
    mutations
}: DreamSessionToolDependencies): LivingMemoryLoopTool[] => {
    const speakerKeysOf = (memory: ExtractedMemoryItem) =>
        resolveSpeakerKeysByLabels(memory.speakerLabels, speakers)

    const resolveAvailable = async (input: string[]) => {
        const refs = await modelMemoryIds(repository, presetId, input)
        const ids = input.map(ref => {
            const id = refs.resolve(ref, state.availableMemoryIds)
            if (!state.availableMemoryIds.has(id)) {
                const scope = state.mode === 'post-extraction' ? '当前组' : '本次会话'
                throw new MemoryInputError(`请使用${scope}已提供的记忆 ID，请核对：${ref}。`)
            }
            return id
        })
        return { ids, display: refs.display }
    }

    return [
        {
            name: memorySplitTool.name,
            description: memorySplitTool.description,
            args: memorySplitTool.schema,
            async run(input: {
                sourceMemoryId: string
                memories: ExtractedMemoryItem[]
            }) {
                const { ids: [sourceId] } = await resolveAvailable([input.sourceMemoryId])
                const result = await mutations.splitActiveMemory(
                    presetId,
                    sourceId,
                    input.memories.map((memory) =>
                        toAttributedMemory(memory, speakerKeysOf(memory))
                    )
                )
                recordDreamOperation(state, [sourceId], 'split')
                for (const memory of result.memories) {
                    recordDreamSpeakers(state, memory.speakerKeys)
                    state.availableMemoryIds.add(memory.id)
                }
                return splitToolResult(repository, presetId, sourceId, result)
            }
        },
        {
            name: memoryUpdateTool.name,
            description: memoryUpdateTool.description,
            args: memoryUpdateTool.schema,
            async run(input: {
                memoryId: string
                memory: ExtractedMemoryItem
            }) {
                const { ids: [id], display } = await resolveAvailable([input.memoryId])
                const speakerKeys = speakerKeysOf(input.memory)
                const warnings: string[] = []
                const record = await withIndexWarning(
                    mutations.updateActiveMemory(presetId, id, toAttributedMemory(input.memory, speakerKeys)), warnings, '更新'
                )
                if (record === null) throw missingMemory(input.memoryId)
                recordDreamOperation(state, [id], 'updated')
                recordDreamSpeakers(state, record?.speakerKeys ?? speakerKeys)
                return { memoryId: display(id), updated: true, warnings }
            }
        },
        {
            name: memoryMergeTool.name,
            description: memoryMergeTool.description,
            args: memoryMergeTool.schema,
            async run(input: {
                sourceMemoryIds: string[]
                memory: ExtractedMemoryItem
            }) {
                const { ids } = await resolveAvailable(input.sourceMemoryIds)
                const result = await mutations.mergeActiveMemories(
                    presetId,
                    ids,
                    toAttributedMemory(input.memory, speakerKeysOf(input.memory))
                )
                recordDreamOperation(state, ids, 'merged')
                recordDreamSpeakers(state, result.memory.speakerKeys)
                state.availableMemoryIds.add(result.memory.id)
                return mergeToolResult(repository, presetId, ids, result)
            }
        },
        {
            name: memoryDeleteTool.name,
            description: memoryDeleteTool.description,
            args: memoryDeleteTool.schema,
            async run(input: { memoryId: string }) {
                const { ids: [id], display } = await resolveAvailable([input.memoryId])
                const warnings: string[] = []
                const result = await withIndexWarning(mutations.archiveActiveMemories(presetId, [id]), warnings, '归档')
                if (result?.archived === 0) throw missingMemory(input.memoryId)
                recordDreamOperation(state, [id], 'archived')
                return { memoryId: display(id), deleted: true, warnings }
            }
        },
        {
            name: memoryCheckedTool.name,
            description: memoryCheckedTool.description,
            args: memoryCheckedTool.schema,
            async run(input: { memoryIds: string[]; reason: string }) {
                const { ids, display } = await resolveAvailable(input.memoryIds)
                const memoryIds = [...new Set(ids)]
                const entries = await repository.getEntriesByPresetAndIds(
                    presetId,
                    memoryIds
                )
                const activeIds = new Set(
                    entries
                        .filter((entry) => entry.status === 'active')
                        .map((entry) => entry.id)
                )
                const missing = memoryIds.filter(
                    (id) => !activeIds.has(id)
                )
                if (missing.length > 0) {
                    throw new MemoryInputError(
                        `请核对以下记忆的活跃状态：${missing.map(display).join('、')}。`
                    )
                }
                recordDreamOperation(state, memoryIds, 'kept')
                return {
                    checkedMemoryIds: memoryIds.map(display),
                    reason: input.reason,
                    warnings: []
                }
            }
        }
    ]
}