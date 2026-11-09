import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Context } from 'cordis'
import type {} from '@chatluna/ai-runtime/ops'
import type {} from '@chatluna/core'
import type { MemoryJobRecord } from '../../contracts/memory.ts'
import type { MemoryVectorIndexManifest } from '../../contracts/vector_index.ts'
import { isModelConfigured } from '../shared/utils.ts'
import {
    type EmbeddingsLike,
    probeVectorIndexDimension,
    type VectorIndexEmbeddingContext
} from './embedding.ts'
import { LivingMemoryVectorIndexError } from './errors.ts'
import {
    LivingMemoryVectorIndexJobRunner,
    type VectorIndexJobRepository
} from './job_runner.ts'
import type { VectorIndexOperationGate } from './operation_gate.ts'
import {
    reconcileVectorIndexPreset,
    type VectorIndexReconcileProgress,
    type VectorIndexReconcileRepository
} from './reconcile.ts'
import {
    rebuildVectorIndex,
    type VectorIndexRebuildRepository
} from './rebuild.ts'
import type { LivingMemoryVectorIndexWorkerClient } from './worker_client.ts'
import type { VectorIndexInspection } from './worker_protocol.ts'
import type { LivingMemoryLogger } from '../logging/logger.ts'

const VECTOR_STORAGE_ENGINE = 'pglite-pgvector' as const
const GLOBAL_INDEX_JOB_PRESET = '*'

export interface LivingMemoryVectorIndexRepository
    extends
        VectorIndexRebuildRepository,
        VectorIndexReconcileRepository,
        VectorIndexJobRepository {
    countEntries(): Promise<number>
}

interface VectorIndexMaintenanceOptions {
    ctx: Context
    config: { embeddingModel: string; debug: boolean }
    repository: LivingMemoryVectorIndexRepository
    worker: () => LivingMemoryVectorIndexWorkerClient
    operationGate: VectorIndexOperationGate
    schemaVersion: number
    indexDirectory: string
    previousDatabaseDirectory: string
    finalizeRebuild: (
        input: {
            rebuildDatabaseDirectory: string
            expectedCount: number
            manifest: MemoryVectorIndexManifest
        },
        transferCleanupOwnership: () => void
    ) => Promise<VectorIndexInspection>
    shouldStop: () => boolean
    onBuilding: (jobId: string) => void
    onCurrentJobChanged: (jobId: string | null) => void
    onInspection: (inspection: VectorIndexInspection) => void
    onEmbeddingContext: (context: VectorIndexEmbeddingContext) => void
    logger: LivingMemoryLogger
}

export class LivingMemoryVectorIndexMaintenance {
    private readonly jobRunner: LivingMemoryVectorIndexJobRunner

    constructor(private readonly options: VectorIndexMaintenanceOptions) {
        this.jobRunner = new LivingMemoryVectorIndexJobRunner(
            options.repository,
            options.onCurrentJobChanged,
            options.logger
        )
    }

    async initialize(inspection: VectorIndexInspection) {
        const { embeddings, dimension } = await this.createEmbeddingContext()
        const rebuildReason = this.resolveRebuildReason(inspection, dimension)
        if (rebuildReason !== null) {
            await this.runRebuildJob(embeddings, dimension, rebuildReason)
        } else {
            await this.runReconcileJob(embeddings, dimension)
        }
        await this.maintainDreamAnnIndex()
    }

    async rebuild(reason: string) {
        const { embeddings, dimension } = await this.createEmbeddingContext()
        await this.runRebuildJob(embeddings, dimension, reason)
        await this.maintainDreamAnnIndex()
    }

    private async maintainDreamAnnIndex() {
        if (this.options.shouldStop()) return
        try {
            await this.jobRunner.run(
                GLOBAL_INDEX_JOB_PRESET,
                'dream-ann: startup or rebuild',
                async () => {
                    const { built } =
                        await this.options.operationGate.runExclusive(() =>
                            this.options.worker().buildDreamAnnIndex()
                        )
                    return `近邻索引：${built ? '已构建' : '复用已有索引'}`
                }
            )
        } catch (error) {
            this.options.logger.summary(
                'Dream 近邻索引维护失败',
                '操作：维护 Dream 近邻索引',
                'warn',
                error
            )
        }
    }

    createPresetReconcileJob(presetId: string, reason: string) {
        return this.jobRunner.create(presetId, `reconcile: ${reason}`)
    }

    async runPresetReconcileJob(job: MemoryJobRecord, reason: string) {
        const input = `reconcile: ${reason}`
        await this.jobRunner.runCreated(job, input, async () => {
            const { embeddings, dimension } =
                await this.createEmbeddingContext()
            const indexedCount = await this.options.operationGate.runExclusive(
                () =>
                    reconcileVectorIndexPreset({
                        presetId: job.presetId,
                        repository: this.options.repository,
                        worker: this.options.worker(),
                        embeddings,
                            dimension,
                        shouldStop: this.options.shouldStop,
                        onProgress: (progress) =>
                            this.reportReconcileProgress(job, progress)
                    })
            )
            const inspection = await this.options.worker().inspect()
            this.options.onInspection(inspection)
            return `处理记忆：${indexedCount} 条`
        })
    }

    private async createEmbeddings(): Promise<EmbeddingsLike> {
        const { ctx, config } = this.options
        if (!isModelConfigured(config.embeddingModel)) {
            throw new LivingMemoryVectorIndexError(
                'embedding-unavailable',
                'unavailable',
                'vector index embedding model is not configured'
            )
        }
        const model = config.embeddingModel
        return {
            embedDocuments: async (texts: string[]) => {
                if (texts.length === 0) return []
                const result = await ctx.chatluna.embed(texts, { model })
                return result.embeddings.map((vector) => [...vector])
            },
            embedQuery: async (text: string) => {
                const result = await ctx.chatluna.embed(text, { model })
                const vector = result.embeddings[0]
                if (vector === undefined) {
                    throw new LivingMemoryVectorIndexError(
                        'embedding-unavailable',
                        'unavailable',
                        `vector index embedding unavailable: model=${model}`
                    )
                }
                return [...vector]
            }
        }
    }

    private async createEmbeddingContext() {
        const embeddings = await this.createEmbeddings()
        const dimension = await probeVectorIndexDimension(embeddings)
        const context: VectorIndexEmbeddingContext = {
            embeddings,
            dimension
        }
        this.options.onEmbeddingContext(context)
        return context
    }

    private resolveRebuildReason(
        inspection: VectorIndexInspection,
        dimension: number
    ) {
        const { config, schemaVersion } = this.options
        if (inspection.manifest === null) {
            return 'index manifest is missing'
        }
        if (inspection.manifest.storageEngine !== VECTOR_STORAGE_ENGINE) {
            return (
                'vector index storage engine changed: expected=' +
                VECTOR_STORAGE_ENGINE +
                ', actual=' +
                inspection.manifest.storageEngine
            )
        }
        if (inspection.vectorExtensionVersion !== inspection.availableVectorExtensionVersion) {
            return `pgvector version changed: installed=${inspection.vectorExtensionVersion}, available=${inspection.availableVectorExtensionVersion}`
        }
        if (
            inspection.vectorExtensionVersion !==
            inspection.manifest.vectorExtensionVersion
        ) {
            return (
                `manifest pgvector version changed: ` +
                `manifest=${inspection.manifest.vectorExtensionVersion}, ` +
                `runtime=${inspection.vectorExtensionVersion}`
            )
        }

        const manifest = inspection.manifest
        if (manifest.schemaVersion !== schemaVersion) {
            return (
                `schema version changed: expected=${schemaVersion}, ` +
                `actual=${manifest.schemaVersion}`
            )
        }
        if (manifest.embeddingModelId !== config.embeddingModel) {
            return (
                `embedding model changed: expected=${config.embeddingModel}, ` +
                `actual=${manifest.embeddingModelId}`
            )
        }
        if (manifest.dimension !== dimension) {
            return (
                `embedding dimension changed: expected=${dimension}, ` +
                `actual=${manifest.dimension}`
            )
        }
        return null
    }

    private async runRebuildJob(
        embeddings: EmbeddingsLike,
        dimension: number,
        reason: string
    ) {
        const {
            config,
            repository,
            indexDirectory,
            schemaVersion,
            operationGate
        } = this.options
        await this.jobRunner.run(
            GLOBAL_INDEX_JOB_PRESET,
            `rebuild: ${reason}`,
            async (job) => {
                this.options.onBuilding(job.id)
                const manifest: MemoryVectorIndexManifest = {
                    schemaVersion,
                    embeddingModelId: config.embeddingModel,
                    dimension,
                    storageEngine: VECTOR_STORAGE_ENGINE,
                    vectorExtensionVersion: (
                        await this.options.worker().inspect()
                    ).availableVectorExtensionVersion,
                    generation: randomUUID(),
                    builtAt: Date.now()
                }
                const rebuildDatabaseDirectory = resolve(
                    indexDirectory,
                    `vector-index.rebuild-${job.id}.pglite`
                )
                const inspection = await rebuildVectorIndex({
                    repository,
                    worker: this.options.worker(),
                    embeddings,
                    dimension,
                    manifest,
                    rebuildDatabaseDirectory,
                    shouldStop: this.options.shouldStop,
                    onProgress: async (progress) => {
                        const detail = `已处理 ${progress.completed}/${progress.total} 条记忆（预设：${job.presetId}）`
                        await repository.updateJob(job.id, {
                            detail: `索引重建：${detail}`,
                            updatedAt: new Date()
                        })
                        this.options.logger.diagnosticSummary(() => ({
                            event: '索引重建进度',
                            detail: `${detail}; 本批耗时：${(progress.batchDuration / 1000).toFixed(3)} 秒; 总耗时：${(progress.totalDuration / 1000).toFixed(3)} 秒`
                        }))
                    },
                    finalize: (transferCleanupOwnership) =>
                        operationGate.runExclusive(async () => {
                            await this.reconcileAllPresets(
                                embeddings,
                                dimension,
                                job
                            )
                            const expectedCount =
                                await repository.countEntries()
                            return this.options.finalizeRebuild(
                                {
                                    rebuildDatabaseDirectory,
                                    expectedCount,
                                    manifest
                                },
                                transferCleanupOwnership
                            )
                        })
                })
                this.options.onInspection(inspection)
                return `处理记忆：${inspection.indexedCount} 条`
            }
        )
    }

    private async runReconcileJob(
        embeddings: EmbeddingsLike,
        dimension: number
    ) {
        await this.jobRunner.run(
            GLOBAL_INDEX_JOB_PRESET,
            'reconcile: startup',
            async (job) => {
                this.options.onBuilding(job.id)
                await this.options.operationGate.runExclusive(() =>
                    this.reconcileAllPresets(embeddings, dimension, job)
                )
                const inspection = await this.options.worker().inspect()
                this.options.onInspection(inspection)
                return `处理记忆：${inspection.indexedCount} 条`
            }
        )
    }

    private async reconcileAllPresets(
        embeddings: EmbeddingsLike,
        dimension: number,
        job: MemoryJobRecord
    ) {
        const { repository } = this.options
        const inspection = await this.options.worker().inspect()
        const sourcePresetIds = await repository.listEntryPresetIds()
        const presetIds = new Set(sourcePresetIds)
        for (const inventory of inspection.inventory) {
            presetIds.add(inventory.presetId)
        }
        // 状态行里的预设也要对账：只剩状态行的孤儿由 total=0 的 clearPreset 删除，
        // 否则残留的非终态行会把全局状态永远拖在 building/dirty。
        for (const preset of inspection.presets) {
            presetIds.add(preset.presetId)
        }

        for (const presetId of [...presetIds].sort()) {
            await reconcileVectorIndexPreset({
                presetId,
                repository,
                worker: this.options.worker(),
                embeddings,
                dimension,
                shouldStop: this.options.shouldStop,
                onProgress: (progress) =>
                    this.reportReconcileProgress(job, progress)
            })
        }
    }

    private async reportReconcileProgress(
        job: MemoryJobRecord,
        progress: VectorIndexReconcileProgress
    ) {
        await this.options.repository.updateJob(job.id, {
            detail: `索引对账：已处理 ${progress.completed}/${progress.total} 条记忆（预设：${progress.presetId}）`,
            updatedAt: new Date()
        })
    }
}
