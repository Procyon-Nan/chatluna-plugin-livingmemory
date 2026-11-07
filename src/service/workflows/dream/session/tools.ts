import { toAttributedMemory } from '../../../memory/entry_fields.ts'
import type { ExtractedMemoryItem } from '../../../../contracts/workflows.ts'
import type { PresetSpeakerRecord } from '../../../../contracts/memory.ts'
import type { LivingMemoryMutationService } from '../../../app/mutation_service.ts'
import { LivingMemoryFactsCommittedError } from '../../../vector_index/errors.ts'
import { MemoryInputError } from '../../../memory/errors.ts'
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
    assertDreamMemoriesAvailable,
    recordDreamOperation,
    recordDreamSpeakers,
    type DreamSessionState
} from './state.ts'

interface DreamSessionToolDependencies {
    presetId: string
    state: DreamSessionState
    speakers: readonly PresetSpeakerRecord[]
    getEntriesByPresetAndIds: (
        presetId: string,
        ids: string[]
    ) => Promise<{ id: string; status: string }[]>
    mutations: Pick<
        LivingMemoryMutationService,
        | 'updateActiveMemory'
        | 'mergeActiveMemories'
        | 'splitActiveMemory'
        | 'archiveActiveMemories'
    >
}

/**
 * Dream 会话工具。与 v1 一致，作用域与批次状态由闭包带入；工具不经过 v2 的
 * 工具服务，因此不依赖 Agent 层，也不出现在任何工具的可见清单里。
 */
export const createDreamSessionTools = ({
    presetId,
    state,
    speakers,
    getEntriesByPresetAndIds,
    mutations
}: DreamSessionToolDependencies): LivingMemoryLoopTool[] => {
    const speakerKeysOf = (memory: ExtractedMemoryItem) =>
        resolveSpeakerKeysByLabels(memory.speakerLabels, speakers)

    return [
        {
            name: memorySplitTool.name,
            description: memorySplitTool.description,
            args: memorySplitTool.schema,
            async run(input: {
                sourceMemoryId: string
                memories: ExtractedMemoryItem[]
            }) {
                assertDreamMemoriesAvailable(state, [input.sourceMemoryId])
                const result = await mutations.splitActiveMemory(
                    presetId,
                    input.sourceMemoryId,
                    input.memories.map((memory) =>
                        toAttributedMemory(memory, speakerKeysOf(memory))
                    )
                )
                recordDreamOperation(state, [input.sourceMemoryId], 'split')
                for (const memory of result.memories) {
                    recordDreamSpeakers(state, memory.speakerKeys)
                    state.availableMemoryIds.add(memory.id)
                }
                return {
                    memoryIds: result.memories.map((memory) => memory.id),
                    archivedMemoryId: input.sourceMemoryId,
                    split: true,
                    warnings: result.warnings
                }
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
                assertDreamMemoriesAvailable(state, [input.memoryId])
                const speakerKeys = speakerKeysOf(input.memory)
                const warnings: string[] = []
                try {
                    const record = await mutations.updateActiveMemory(
                        presetId,
                        input.memoryId,
                        toAttributedMemory(input.memory, speakerKeys)
                    )
                    if (record === null) {
                        throw new MemoryInputError(
                            `不存在 ID 为 ${input.memoryId} 的记忆，请重新查明记忆 ID 后再调用。`
                        )
                    }
                    recordDreamOperation(state, [input.memoryId], 'updated')
                    recordDreamSpeakers(state, record.speakerKeys)
                } catch (error) {
                    // 事实已落库、仅索引同步失败：按已更新处理并附警告，
                    // 返回失败会诱导模型重试同一次修改。
                    if (!(error instanceof LivingMemoryFactsCommittedError)) {
                        throw error
                    }
                    recordDreamOperation(state, [input.memoryId], 'updated')
                    recordDreamSpeakers(state, speakerKeys)
                    warnings.push(
                        '记忆已更新，但向量索引同步失败，已调度后台自动对账：' +
                            error.message
                    )
                }
                return { memoryId: input.memoryId, updated: true, warnings }
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
                assertDreamMemoriesAvailable(state, input.sourceMemoryIds)
                const result = await mutations.mergeActiveMemories(
                    presetId,
                    input.sourceMemoryIds,
                    toAttributedMemory(input.memory, speakerKeysOf(input.memory))
                )
                recordDreamOperation(state, input.sourceMemoryIds, 'merged')
                recordDreamSpeakers(state, result.memory.speakerKeys)
                state.availableMemoryIds.add(result.memory.id)
                return {
                    memoryId: result.memory.id,
                    archivedMemoryIds: input.sourceMemoryIds,
                    merged: true,
                    warnings: result.warnings
                }
            }
        },
        {
            name: memoryDeleteTool.name,
            description: memoryDeleteTool.description,
            args: memoryDeleteTool.schema,
            async run(input: { memoryId: string }) {
                assertDreamMemoriesAvailable(state, [input.memoryId])
                const warnings: string[] = []
                try {
                    const result = await mutations.archiveActiveMemories(
                        presetId,
                        [input.memoryId]
                    )
                    if (result.archived === 0) {
                        throw new MemoryInputError(
                            `不存在 ID 为 ${input.memoryId} 的记忆，请重新查明记忆 ID 后再调用。`
                        )
                    }
                    recordDreamOperation(state, [input.memoryId], 'archived')
                } catch (error) {
                    if (!(error instanceof LivingMemoryFactsCommittedError)) {
                        throw error
                    }
                    recordDreamOperation(state, [input.memoryId], 'archived')
                    warnings.push(
                        '记忆已归档，但向量索引同步失败，已调度后台自动对账：' +
                            error.message
                    )
                }
                return { memoryId: input.memoryId, deleted: true, warnings }
            }
        },
        {
            name: memoryCheckedTool.name,
            description: memoryCheckedTool.description,
            args: memoryCheckedTool.schema,
            async run(input: { memoryIds: string[]; reason: string }) {
                const memoryIds = [...new Set(input.memoryIds)]
                assertDreamMemoriesAvailable(state, memoryIds)
                const entries = await getEntriesByPresetAndIds(
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
                        `请核对以下记忆的活跃状态：${missing.join('、')}。`
                    )
                }
                recordDreamOperation(state, memoryIds, 'kept')
                return {
                    checkedMemoryIds: memoryIds,
                    reason: input.reason,
                    warnings: []
                }
            }
        }
    ]
}