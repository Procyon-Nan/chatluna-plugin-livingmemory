import type { LivingMemoryRepository } from '../persistence/repository.ts'
import type { LivingMemoryMutationService } from './mutation_service.ts'
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

export interface LivingMemoryProviderOptions {
    repository: LivingMemoryRepository
    /** 写路径统一经预设级串行队列与索引同步，见 `LivingMemoryMutationService`。 */
    mutations: LivingMemoryMutationService
    searchEngine: Pick<LivingMemorySearchProvider, 'searchMemories'>
}

/**
 * 模型工具使用的记忆读写入口。
 *
 * 写操作全部委托 `LivingMemoryMutationService`：预设级串行队列、落库后同步
 * 向量索引、索引失败转警告的语义只在那一处实现。这里只补工具需要的检索
 * 与来源消息读取。
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

    searchMemories(
        presetId: string,
        input: LivingMemorySearchInput,
        conversationId?: string
    ): Promise<LivingMemorySearchResult[]> {
        return this.options.searchEngine.searchMemories(presetId, input, conversationId)
    }

    getMemorySourceMessages(presetId: string, memoryId: string) {
        return loadMemorySourceMessages(this.options.repository, presetId, memoryId)
    }

    async listPresetSpeakers(presetId: string) {
        return this.options.repository.listPresetSpeakers(presetId)
    }

    createMemory(
        scope: MemoryScope,
        input: MemoryMutationInput,
        speakerKeys: string[]
    ): Promise<MemoryEntryRecord> {
        return this.options.mutations.createMemory(scope, input, speakerKeys)
    }

    updateActiveMemory(
        presetId: string,
        memoryId: string,
        patch: Omit<MemoryUpdatePatch, 'status'>
    ): Promise<MemoryEntryRecord | null> {
        return this.options.mutations.updateActiveMemory(presetId, memoryId, patch)
    }

    mergeActiveMemories(
        presetId: string,
        sourceMemoryIds: string[],
        memory: AttributedMemoryItem
    ) {
        return this.options.mutations.mergeActiveMemories(
            presetId,
            sourceMemoryIds,
            memory
        )
    }

    splitActiveMemory(
        presetId: string,
        sourceMemoryId: string,
        memories: AttributedMemoryItem[]
    ) {
        return this.options.mutations.splitActiveMemory(
            presetId,
            sourceMemoryId,
            memories
        )
    }

    archiveActiveMemories(presetId: string, memoryIds: string[]) {
        return this.options.mutations.archiveActiveMemories(presetId, memoryIds)
    }
}