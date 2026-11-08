import { performance } from 'node:perf_hooks'
import type {
    MemoryIndexSourceRecord,
    MemoryVectorIndexManifest
} from '../../contracts/vector_index.ts'
import { formatErrorDetails } from '../shared/utils.ts'
import { createVectorIndexDocument } from './documents.ts'
import { type EmbeddingsLike, embedMemoryIndexSources } from './embedding.ts'
import { LivingMemoryVectorIndexError } from './errors.ts'
import type { LivingMemoryVectorIndexWorkerClient } from './worker_client.ts'
import type {
    VectorIndexInspection,
    VectorIndexReplaceUpsert
} from './worker_protocol.ts'

const REBUILD_PAGE_SIZE = 50

export interface VectorIndexRebuildRepository {
    listEntryIndexSourcePage(
        afterId: string | null,
        limit: number
    ): Promise<MemoryIndexSourceRecord[]>
    listEntryPresetIds(): Promise<string[]>
    countEntriesByPreset(presetId: string): Promise<number>
}

export type VectorIndexRebuildWorker = Pick<
    LivingMemoryVectorIndexWorkerClient,
    'abortRebuild' | 'appendRebuildBatch' | 'openRebuildDatabase'
>

export interface VectorIndexRebuildProgress {
    completed: number
    total: number
    batchDuration: number
    totalDuration: number
}

const groupUpsertsByPreset = (upserts: VectorIndexReplaceUpsert[]) => {
    const grouped = new Map<string, VectorIndexReplaceUpsert[]>()
    for (const upsert of upserts) {
        const presetId = upsert.document.presetId
        let group = grouped.get(presetId)
        if (group === undefined) {
            group = []
            grouped.set(presetId, group)
        }
        group.push(upsert)
    }
    return grouped
}

export const rebuildVectorIndex = async (options: {
    repository: VectorIndexRebuildRepository
    worker: VectorIndexRebuildWorker
    embeddings: EmbeddingsLike
    dimension: number
    manifest: MemoryVectorIndexManifest
    rebuildDatabaseDirectory: string
    finalize: (
        transferCleanupOwnership: () => void
    ) => Promise<VectorIndexInspection>
    onProgress: (progress: VectorIndexRebuildProgress) => Promise<void>
    shouldStop: () => boolean
}) => {
    const {
        repository,
        worker,
        embeddings,
        dimension,
        manifest,
        rebuildDatabaseDirectory,
        finalize,
        onProgress,
        shouldStop
    } = options
    let rebuildCreated = false
    let cleanupOwnedByFinalize = false
    try {
        const created = await worker.openRebuildDatabase(
            rebuildDatabaseDirectory,
            manifest
        )
        rebuildCreated = true
        if (
            created.vectorExtensionVersion !== manifest.vectorExtensionVersion
        ) {
            throw new Error(
                `pgvector version mismatch: ` +
                    `expected=${manifest.vectorExtensionVersion}, ` +
                    `actual=${created.vectorExtensionVersion}`
            )
        }
        const presetIds = await repository.listEntryPresetIds()
        let total = 0
        for (const presetId of presetIds) {
            total += await repository.countEntriesByPreset(presetId)
        }

        const startedAt = performance.now()
        let completed = 0
        let cursor: string | null = null
        while (true) {
            if (shouldStop()) {
                throw new Error('vector index service is stopping')
            }
            const batchStartedAt = performance.now()
            const sources = await repository.listEntryIndexSourcePage(
                cursor,
                REBUILD_PAGE_SIZE
            )
            if (sources.length === 0) {
                break
            }

            const replacements = await embedMemoryIndexSources(
                embeddings,
                dimension,
                sources
            )
            const upserts: VectorIndexReplaceUpsert[] = replacements.map(
                (replacement) => ({
                    vectorAction: 'replace',
                    document: createVectorIndexDocument(replacement.source),
                    vector: replacement.vector
                })
            )

            for (const [presetId, group] of groupUpsertsByPreset(upserts)) {
                await worker.appendRebuildBatch(presetId, group)
            }

            completed += sources.length
            const finishedAt = performance.now()
            await onProgress({
                completed,
                total,
                batchDuration: finishedAt - batchStartedAt,
                totalDuration: finishedAt - startedAt
            })
            cursor = sources[sources.length - 1].id
        }

        return await finalize(() => {
            cleanupOwnedByFinalize = true
        })
    } catch (error) {
        let cleanupError: unknown = null
        if (rebuildCreated && !cleanupOwnedByFinalize) {
            try {
                await worker.abortRebuild()
            } catch (abortError) {
                cleanupError = abortError
            }
        }
        let message = formatErrorDetails(error)
        if (cleanupError !== null) {
            message += `; rebuild cleanup failed: ${formatErrorDetails(cleanupError)}`
        }
        throw new LivingMemoryVectorIndexError(
            'rebuild-failed',
            'unavailable',
            `vector index rebuild failed: ${message}`,
            { cause: error }
        )
    }
}
