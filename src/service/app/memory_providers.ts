import type { MemoryBackend } from '@chatluna/memory'
import type { LivingMemoryRepository } from '../persistence/repository.ts'
import { loadMemorySourceMessages } from '../app/query_projections.ts'
import type {
    AttributedMemoryItem,
    LivingMemoryArchiveProvider,
    LivingMemoryCreationProvider,
    LivingMemoryMergeProvider,
    LivingMemorySearchProvider,
    LivingMemorySourceProvider,
    LivingMemorySplitProvider,
    LivingMemoryUpdateProvider
} from '../../contracts/workflows.ts'
import type {
    LivingMemorySearchInput,
    LivingMemorySearchResult,
    MemoryEntryRecord,
    MemoryMutationInput,
    MemoryScope,
    MemoryUpdatePatch
} from '../../contracts/memory.ts'
import type { MemoryIndexMutationSink } from '../../contracts/vector_index.ts'
import {
    createSyntheticSpeakerLabel,
    resolveScopeSpeakerKeys
} from '../memory/speaker_identity.ts'
import { LivingMemoryFactsCommittedError } from '../vector_index/errors.ts'
import type { LivingMemoryLogger } from '../logging/logger.ts'

/** 记忆字段同步进向量索引时使用的文档形状。 */
const toIndexUpsert = (record: MemoryEntryRecord) => ({
    document: {
        id: record.id,
        presetId: record.presetId,
        sourceConversationId: record.sourceConversationId,
        status: record.status,
        type: record.type,
        content: record.content,
        keywords: [...record.keywords],
        updatedAt: record.updatedAt
    },
    vectorAction: 'replace' as const
})

const toArchivedIndexUpsert = (record: MemoryEntryRecord) => ({
    ...toIndexUpsert(record),
    vectorAction: 'preserve' as const
})

export interface LivingMemoryProviderOptions {
    repository: LivingMemoryRepository
    backend: Pick<MemoryBackend, 'search'>
    vectorIndex: MemoryIndexMutationSink
    logger: LivingMemoryLogger
}

/**
 * 工具与工作流使用的记忆读写入口。
 *
 * v1 的 `LivingMemoryMutationService` 承担同一职责：在预设级串行队列内写主数据，
 * 再同步向量索引，并把「主数据已提交、索引失败」转换成警告而不是失败。
 * 这里保留该语义，队列与索引能力的接入随工作流阶段补齐。
 */
export class LivingMemoryMemoryProviders
    implements
        LivingMemorySearchProvider,
        LivingMemorySourceProvider,
        LivingMemoryCreationProvider,
        LivingMemoryUpdateProvider,
        LivingMemoryMergeProvider,
        LivingMemorySplitProvider,
        LivingMemoryArchiveProvider
{
    constructor(private readonly options: LivingMemoryProviderOptions) {}

    /**
     * 工具检索走当前后端的检索实现。v1 的混合检索与重排属召回工作流，
     * 随 S5 接入后替换为 `searchMemories` 的完整实现，这里保持同一条调用路径。
     */
    async searchMemories(
        presetId: string,
        input: LivingMemorySearchInput,
        conversationId?: string
    ): Promise<LivingMemorySearchResult[]> {
        const hits = await this.options.backend.search(
            { presetId, ...(conversationId === undefined ? {} : { conversationId }) },
            {
                texts: input.searchTexts,
                ...(input.searchKeywords === undefined ? {} : { keywords: input.searchKeywords }),
                types: input.memoryTypes,
                ...(input.memoryStatus === undefined ? {} : { status: input.memoryStatus })
            }
        )
        return hits.map((hit) => ({
            id: hit.entry.id,
            type: hit.entry.type,
            content: hit.entry.content,
            keywords: [...hit.entry.keywords],
            summary: hit.entry.summary ?? null,
            sentiment: hit.entry.sentiment ?? null,
            importance: hit.entry.importance ?? null,
            sourceLabel: null,
            createdAt: hit.entry.createdAt,
            updatedAt: hit.entry.updatedAt
        }))
    }

    getMemorySourceMessages(presetId: string, memoryId: string) {
        return loadMemorySourceMessages(this.options.repository, presetId, memoryId)
    }

    async listPresetSpeakers(presetId: string) {
        return this.options.repository.listPresetSpeakers(presetId)
    }

    async createMemory(
        scope: MemoryScope,
        input: MemoryMutationInput,
        speakerKeys: string[]
    ): Promise<MemoryEntryRecord> {
        this.options.vectorIndex.assertPresetReady(scope.presetId)
        const effectiveSpeakerKeys = speakerKeys.length > 0 ? speakerKeys : resolveScopeSpeakerKeys(scope)
        await this.registerSpeakerKeys(scope.presetId, effectiveSpeakerKeys)
        const record = await this.options.repository.createMemory(scope, input, effectiveSpeakerKeys)
        await this.syncToIndex({
            presetId: record.presetId,
            upserts: [toIndexUpsert(record)],
            deletes: []
        })
        return record
    }

    async updateActiveMemory(
        presetId: string,
        memoryId: string,
        patch: Omit<MemoryUpdatePatch, 'status'>
    ): Promise<MemoryEntryRecord | null> {
        const current = await this.options.repository.getEntryById(memoryId)
        if (current === undefined || current.presetId !== presetId || current.status !== 'active') {
            return null
        }
        if (patch.speakerKeys !== undefined) {
            await this.registerSpeakerKeys(presetId, patch.speakerKeys)
        }
        const result = await this.options.repository.updateMemory(memoryId, patch)
        if (result === null) {
            return null
        }
        await this.syncToIndex({
            presetId: result.record.presetId,
            upserts: [{ ...toIndexUpsert(result.record), vectorAction: result.contentChanged ? 'replace' : 'preserve' }],
            deletes: []
        })
        return result.record
    }

    async mergeActiveMemories(
        presetId: string,
        sourceMemoryIds: string[],
        memory: import('../../contracts/workflows.ts').AttributedMemoryItem
    ) {
        await this.registerSpeakerKeys(presetId, memory.speakerKeys)
        const result = await this.options.repository.mergeMemories(presetId, sourceMemoryIds, memory)
        const warnings = await this.syncCommitted(presetId, [result.memory], result.archivedSources, '合并')
        return { memory: result.memory, warnings }
    }

    async splitActiveMemory(
        presetId: string,
        sourceMemoryId: string,
        memories: AttributedMemoryItem[]
    ) {
        await this.registerSpeakerKeys(
            presetId,
            memories.flatMap((memory) => memory.speakerKeys)
        )
        const result = await this.options.repository.splitMemory(presetId, sourceMemoryId, memories)
        const warnings = await this.syncCommitted(presetId, result.memories, [result.archivedSource], '拆分')
        return { memories: result.memories, warnings }
    }

    async archiveActiveMemories(presetId: string, ids: string[]) {
        const uniqueIds = [...new Set(ids)]
        if (uniqueIds.length === 0) {
            return { archived: 0 }
        }
        const records = await this.options.repository.archiveActiveEntries(presetId, uniqueIds)
        if (records.length === 0) {
            return { archived: 0 }
        }
        await this.syncToIndex({
            presetId,
            upserts: records.map(toArchivedIndexUpsert),
            deletes: []
        })
        return { archived: records.length }
    }

    /** 显式键不带昵称，落库前以合成标签补齐缺失的说话人注册行。 */
    private async registerSpeakerKeys(presetId: string, speakerKeys: readonly string[]) {
        if (speakerKeys.length === 0) return
        await this.options.repository.registerMissingPresetSpeakers(
            presetId,
            speakerKeys.map((speakerKey) => ({
                speakerKey,
                speakerLabel: createSyntheticSpeakerLabel(speakerKey)
            }))
        )
    }

    /**
     * 主数据已提交后的索引同步：失败转成警告返回，不向调用方抛错，
     * 否则模型会重试并产生重复记忆。
     */
    private async syncCommitted(
        presetId: string,
        created: MemoryEntryRecord[],
        archived: MemoryEntryRecord[],
        operation: '合并' | '拆分' | '提取'
    ): Promise<string[]> {
        try {
            await this.syncToIndex({
                presetId,
                upserts: [...created.map(toIndexUpsert), ...archived.map(toArchivedIndexUpsert)],
                deletes: []
            })
            return []
        } catch (error) {
            const failure =
                error instanceof LivingMemoryFactsCommittedError
                    ? error
                    : new LivingMemoryFactsCommittedError(String(error), { cause: error })
            return [`记忆已${operation}，但向量索引同步失败，已调度后台自动对账：${failure.message}`]
        }
    }

    private syncToIndex(batch: Parameters<MemoryIndexMutationSink['applyMutation']>[0]) {
        return this.options.vectorIndex.applyMutation(batch)
    }
}