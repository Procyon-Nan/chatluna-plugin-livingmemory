import type {
    LivingMemoryPresetExport,
    LivingMemoryPresetImportResult,
    LivingMemorySearchDetailedResult,
    LivingMemorySearchInput,
    MemoryEntryRecord,
    MemoryJobRecord,
    MemoryMutationInput,
    MemoryScope,
    MemorySnapshotRecord,
    MemoryUpdatePatch,
    PresetPersonaCardInfo,
    PresetSpeakerRecord,
    UserProfileRecord
} from '../../contracts/memory.ts'
import type {
    JobListQuery,
    MemoryListFilter,
    MemoryListQuery,
    PageResult,
    SnapshotListQuery,
    UserProfileListQuery
} from '../../contracts/rpc.ts'
import type { DreamTriggerResult, MemoryServiceStatus } from '../../contracts/workflows.ts'
import type { LivingMemoryRepository } from '../persistence/repository.ts'
import type { LivingMemoryMutationService } from './mutation_service.ts'
import type { LivingMemorySearchEngine } from '../workflows/recall/memory_search_engine.ts'
import type { LivingMemoryPresetPersonaService } from '../memory/preset_persona.ts'
import type { LivingMemoryUserProfileService } from '../user_profile.ts'
import type { LivingMemoryDreamCoordinator } from '../workflows/dream/coordinator.ts'
import type { LivingMemoryVectorIndexService } from '../vector_index/service.ts'
import type { LivingMemoryConfig } from '../../contracts/workflows.ts'
import { createMemoryServiceStatus } from './config_status.ts'
import {
    filterJobList,
    filterMemorySelection,
    filterMemoryList,
    filterSnapshotList,
    filterUserProfileList
} from '../../query.ts'
import { createSpeakerKey } from '../memory/speaker_identity.ts'
import { normalizeManualUserProfileContent } from '../user_profile.ts'

export interface LivingMemoryAdminDeps {
    config: LivingMemoryConfig
    repository: LivingMemoryRepository
    mutations: LivingMemoryMutationService
    searchEngine: LivingMemorySearchEngine
    presetPersona: LivingMemoryPresetPersonaService
    userProfiles: LivingMemoryUserProfileService
    dreamCoordinator: LivingMemoryDreamCoordinator
    vectorIndex: LivingMemoryVectorIndexService
    /** 预设目录：`ctx.presets` 中的预设 id。 */
    listPresetIds(): Promise<string[]>
    /** 清理单个预设的会话状态（快照、召回与提取消费位置）。 */
    cleanupConversation(conversationId: string): Promise<void>
}

/**
 * 管理界面与命令共用的读写入口。
 *
 * 这一层是为管理界面与命令准备的；工作流的运行时依赖不从这里取，避免把
 * 展示用的读模型混进执行路径。
 */
export class LivingMemoryAdminService {
    constructor(private readonly deps: LivingMemoryAdminDeps) {}

    get status(): MemoryServiceStatus {
        return createMemoryServiceStatus(
            this.deps.config,
            this.deps.vectorIndex.getStatus()
        )
    }

    /**
     * 可管理的预设：当前目录中的预设，加上库中仍有记忆数据的预设。
     * 后者可能已从目录删除，但记忆仍在，界面必须能列出并清理。
     */
    async listPresetIds(): Promise<string[]> {
        const [catalog, stored] = await Promise.all([
            this.deps.listPresetIds(),
            this.deps.repository.listDistinctPresetIds()
        ])
        return [...new Set([...catalog, ...stored])].sort((left, right) =>
            left.localeCompare(right)
        )
    }

    // ── 记忆 ──────────────────────────────────────────────────────────

    async listMemories(query: MemoryListQuery) {
        const items = await this.deps.repository.listEntriesByPreset(
            query.presetId
        )
        const page = filterMemoryList(items, query)
        return { ...page, items: await this.deps.repository.withSourceLabels(page.items) }
    }

    async listMemorySelection(filter: MemoryListFilter) {
        return filterMemorySelection(
            await this.deps.repository.listEntriesByPreset(filter.presetId),
            filter
        )
    }

    createMemory(
        scope: MemoryScope,
        input: MemoryMutationInput,
        speakerKeys?: string[]
    ): Promise<MemoryEntryRecord> {
        return this.deps.mutations.createMemory(scope, input, speakerKeys)
    }

    async updateMemory(memoryId: string, patch: MemoryUpdatePatch) {
        await this.deps.mutations.updateMemory(memoryId, patch)
    }

    deleteMemories(presetId: string, ids: string[]) {
        return this.deps.mutations.deleteMemories(presetId, ids)
    }

    archiveMemories(presetId: string, ids: string[]) {
        return this.deps.mutations.archiveActiveMemories(presetId, ids)
    }

    searchMemoriesDetailed(
        presetId: string,
        input: LivingMemorySearchInput
    ): Promise<LivingMemorySearchDetailedResult[]> {
        return this.deps.searchEngine.searchMemoriesDetailed(presetId, input)
    }

    // ── 快照与任务 ────────────────────────────────────────────────────

    async listSnapshots(
        query: SnapshotListQuery
    ): Promise<PageResult<MemorySnapshotRecord>> {
        return filterSnapshotList(
            await this.deps.repository.listSnapshotsByPreset(query.presetId),
            query
        )
    }

    async deleteSnapshot(snapshotId: string) {
        await this.deps.repository.deleteSnapshot(snapshotId)
    }

    async listJobs(
        query: JobListQuery
    ): Promise<PageResult<MemoryJobRecord>> {
        return filterJobList(
            await this.deps.repository.listJobsByPreset(query.presetId),
            query
        )
    }

    runDream(presetId: string): Promise<DreamTriggerResult> {
        this.deps.vectorIndex.assertPresetReady(presetId)
        return this.deps.dreamCoordinator.start(presetId)
    }

    // ── 用户画像与人设 ────────────────────────────────────────────────

    async listUserProfiles(
        query: UserProfileListQuery
    ): Promise<PageResult<UserProfileRecord>> {
        return filterUserProfileList(
            await this.deps.repository.listUserProfilesByPreset(
                query.presetId
            ),
            query
        )
    }

    listPresetSpeakers(presetId: string): Promise<PresetSpeakerRecord[]> {
        return this.deps.repository.listPresetSpeakers(presetId)
    }

    async updateUserProfile(profileId: string, content: string) {
        await this.deps.repository.updateUserProfileContent(
            profileId,
            normalizeManualUserProfileContent(content)
        )
    }

    async deleteUserProfile(profileId: string) {
        await this.deps.repository.deleteUserProfile(profileId)
    }

    regenerateUserProfile(presetId: string, speakerKey: string) {
        return this.deps.userProfiles.regenerate(presetId, [speakerKey], {
            force: true
        })
    }

    getPresetPersona(presetId: string): Promise<PresetPersonaCardInfo | undefined> {
        return this.deps.presetPersona.getCard(presetId)
    }

    async savePresetPersonaCard(presetId: string, card: string) {
        await this.deps.presetPersona.saveManualCard(presetId, card)
    }

    async resetPresetPersonaCard(presetId: string) {
        await this.deps.presetPersona.regenerateCard(presetId)
    }

    // ── 向量索引 ──────────────────────────────────────────────────────

    reconcileVectorIndex(presetId: string) {
        return this.deps.vectorIndex.reconcilePreset(presetId, 'manual reconcile')
    }

    rebuildVectorIndex() {
        this.deps.vectorIndex.startRebuild('manual rebuild')
    }

    async restartVectorIndex() {
        await this.deps.vectorIndex.restart()
    }

    // ── 预设数据 ──────────────────────────────────────────────────────

    /** 清空预设的记忆数据与人设卡片；会话级状态由调用方另行清理。 */
    async clearPresetData(presetId: string) {
        await this.deps.mutations.clearPresetData(presetId)
        await this.deps.presetPersona.clearCard(presetId)
    }

    exportPreset(presetId: string): Promise<LivingMemoryPresetExport> {
        return this.deps.repository.exportPresetData(presetId)
    }

    importPreset(
        targetPresetId: string,
        data: LivingMemoryPresetExport
    ): Promise<LivingMemoryPresetImportResult> {
        return this.deps.mutations.importPreset(targetPresetId, data)
    }

    // ── 命令用的按条件查找 ────────────────────────────────────────────

    async findActiveMemoryIdsByText(presetId: string, text: string) {
        const query = text.toLowerCase()
        return (await this.deps.repository.listEntriesByPreset(presetId))
            .filter(
                (memory) =>
                    memory.status === 'active' &&
                    (memory.content.toLowerCase().includes(query) ||
                        memory.summary?.toLowerCase().includes(query) === true ||
                        memory.keywords.some((keyword) =>
                            keyword.toLowerCase().includes(query)
                        ))
            )
            .map((memory) => memory.id)
    }

    async findActiveMemoryIdsByUser(
        presetId: string,
        platform: string,
        userId: string
    ) {
        const speakerKey = createSpeakerKey(platform, userId)
        return (
            await this.deps.repository.listActiveMemorySpeakerLinks(presetId, [
                speakerKey
            ])
        ).map((link) => link.memoryId)
    }

    async findUserProfileIdByUser(
        presetId: string,
        platform: string,
        userId: string
    ) {
        const speakerKey = createSpeakerKey(platform, userId)
        return (
            await this.deps.repository.listUserProfilesBySpeakerKeys(presetId, [
                speakerKey
            ])
        )[0]?.id
    }

    /** 会话级状态清理：快照、召回与提取消费位置。 */
    cleanupConversation(conversationId: string) {
        return this.deps.cleanupConversation(conversationId)
    }
}
