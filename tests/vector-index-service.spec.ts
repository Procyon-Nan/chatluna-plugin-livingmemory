import assert from 'node:assert/strict'
import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import type { Context } from 'cordis'
import type { LivingMemoryLogSink } from '../src/service/logging/logger.ts'
import { LivingMemoryLogger } from '../src/service/logging/logger.ts'
import type {
    MemoryJobKind,
    MemoryJobRecord,
    MemoryScope
} from '../src/contracts/memory.ts'
import type {
    MemoryIndexSourceRecord
} from '../src/contracts/vector_index.ts'
import {
    LivingMemoryVectorIndexService,
    type VectorIndexWorkerFactory
} from '../src/service/vector_index/service.ts'
import { LivingMemoryVectorIndexWorkerClient } from '../src/service/vector_index/worker_client.ts'
import { vectorIndexWorkerPath } from './worker-test-utils.ts'

const workerPath = vectorIndexWorkerPath

const createSource = (
    id: string,
    options: Partial<MemoryIndexSourceRecord> = {}
): MemoryIndexSourceRecord => ({
    id,
    presetId: 'preset-a',
    sourceConversationId: null,
    status: 'active',
    type: 'fact',
    content: `content ${id}`,
    keywords: [id],
    updatedAt: new Date('2026-08-08T00:00:00.000Z'),
    ...options
})

class TestVectorIndexRepository {
    readonly jobs: MemoryJobRecord[] = []
    readonly sources: MemoryIndexSourceRecord[]

    constructor(sources: MemoryIndexSourceRecord[]) {
        this.sources = sources
    }

    async listEntryIndexSourcePage(afterId: string | null, limit: number) {
        return this.page(this.sources, afterId, limit)
    }

    async listEntryIndexSourcePageByPreset(
        presetId: string,
        afterId: string | null,
        limit: number
    ) {
        return this.page(
            this.sources.filter((source) => source.presetId === presetId),
            afterId,
            limit
        )
    }

    async listEntryPresetIds() {
        return [
            ...new Set(this.sources.map((source) => source.presetId))
        ].sort()
    }

    async countEntriesByPreset(presetId: string) {
        return this.sources.filter((source) => source.presetId === presetId)
            .length
    }

    async countEntries() {
        return this.sources.length
    }

    async createJob(scope: MemoryScope, kind: MemoryJobKind, input: string) {
        const now = new Date()
        const job: MemoryJobRecord = {
            id: `job-${this.jobs.length + 1}`,
            presetId: scope.presetId,
            conversationId: scope.conversationId,
            kind,
            status: 'pending',
            input,
            detail: null,
            error: null,
            createdAt: now,
            startedAt: null,
            finishedAt: null,
            updatedAt: now
        }
        this.jobs.push(job)
        return job
    }

    async updateJob(id: string, patch: Partial<MemoryJobRecord>) {
        const job = this.jobs.find((item) => item.id === id)
        assert.ok(job)
        Object.assign(job, patch)
    }

    private page<T extends { id: string }>(
        records: T[],
        afterId: string | null,
        limit: number
    ) {
        return records
            .filter((record) => afterId === null || record.id > afterId)
            .sort((left, right) => left.id.localeCompare(right.id))
            .slice(0, limit)
    }
}

const createVector = (text: string, dimension: number) => {
    const vector = new Array<number>(dimension).fill(0)
    vector[0] = 1
    if (dimension > 1) {
        vector[1] = (text.length % 7) / 10
    }
    return vector
}

const createEmbeddings = (
    dimension: number,
    calls: string[][],
    onDocuments?: (texts: string[]) => Promise<void>
) => ({
    embed: async (
        values: string | readonly string[],
        options?: { model?: string }
    ) => {
        const texts = typeof values === 'string' ? [values] : [...values]
        calls.push(texts)
        if (typeof values !== 'string' && onDocuments !== undefined) {
            await onDocuments(texts)
        }
        return {
            embeddings: texts.map((text) => createVector(text, dimension))
        }
    }
})

const createLogger = () => {
    const info: string[] = []
    const warnings: Parameters<LivingMemoryLogSink['warn']>[] = []
    const logger: LivingMemoryLogSink = {
        info: (message) => {
            info.push(String(message))
        },
        warn: (...args) => {
            warnings.push(args)
        },
        error: (...args) => {
            warnings.push(args)
        }
    }
    return { logger, info, warnings }
}

const createService = (options: {
    repository: TestVectorIndexRepository
    modelId: string
    dimension: number
    debug?: boolean
    logger?: LivingMemoryLogSink
    calls?: string[][]
    schemaVersion?: number
    workerPath?: string
    workerFactory?: VectorIndexWorkerFactory
    onDocuments?: (texts: string[]) => Promise<void>
    onCreateEmbeddings?: (modelId: string) => void
}) => {
    const calls = options.calls ?? []
    const embeddings = createEmbeddings(
        options.dimension,
        calls,
        options.onDocuments
    )
    const ctx = {
        chatluna: {
            embed: async (
                values: string | readonly string[],
                embedOptions?: { model?: string }
            ) => {
                assert.equal(embedOptions?.model, options.modelId)
                options.onCreateEmbeddings?.(options.modelId)
                return await embeddings.embed(values, embedOptions)
            }
        }
    } as unknown as Context
    const logger = options.logger ?? createLogger().logger
    return new LivingMemoryVectorIndexService(
        ctx,
        {
            embeddingModel: options.modelId,
            debug: options.debug ?? false
        },
        options.repository,
        new LivingMemoryLogger(logger, () => options.debug ?? false),
        {
            schemaVersion: options.schemaVersion,
            workerFactory:
                options.workerFactory ??
                ((onFailure, onWarning) =>
                    new LivingMemoryVectorIndexWorkerClient(
                        options.workerPath ?? workerPath,
                        onFailure,
                        onWarning
                    ))
        }
    )
}

const withTemporaryDirectory = async (
    callback: (baseDir: string) => Promise<void>
) => {
    const directory = await mkdtemp(
        resolve(tmpdir(), 'living-memory-vector-service-test-')
    )
    const previousDataDir = process.env['CHATLUNA_DATA']
    process.env['CHATLUNA_DATA'] = resolve(directory, 'data', 'chatluna')
    try {
        await callback(directory)
    } finally {
        if (previousDataDir === undefined) {
            delete process.env['CHATLUNA_DATA']
        } else {
            process.env['CHATLUNA_DATA'] = previousDataDir
        }
        await rm(directory, { recursive: true, force: true })
    }
}

const resolveIndexDirectory = (baseDir: string) =>
    resolve(baseDir, 'data', 'chatluna', 'living-memory')

it('stays in building until the embedding provider resolves', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        let releaseEmbed: (() => void) | undefined
        const embedReady = new Promise<void>((resolvePromise) => {
            releaseEmbed = resolvePromise
        })
        let signalEmbedStarted: (() => void) | undefined
        const embedStarted = new Promise<void>((resolvePromise) => {
            signalEmbedStarted = resolvePromise
        })
        let probeCalls = 0
        const service = createService({
            repository: new TestVectorIndexRepository([
                createSource('memory-a')
            ]),
            modelId: 'openai/model-a',
            dimension: 3,
            onDocuments: async (texts) => {
                if (!texts[0].includes('dimension probe')) return
                probeCalls += 1
                signalEmbedStarted?.()
                await embedReady
            }
        })

        await service.start()
        const initialization = service.waitForInitialization()
        await embedStarted
        assert.equal(probeCalls, 1)
        assert.equal(service.getStatus().state, 'building')
        assert.throws(
            () => service.assertPresetReady('preset-a'),
            /not ready/u
        )

        releaseEmbed?.()
        await initialization
        assert.equal(probeCalls, 1)
        assert.equal(service.getStatus().state, 'ready')
        await service.stop()
    })
})

it('builds the index once and reuses its manifest after restart', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        const repository = new TestVectorIndexRepository([
            createSource('memory-a'),
            createSource('memory-b', {
                type: 'preference'
            })
        ])
        const firstCalls: string[][] = []
        const first = createService({
            repository,
            modelId: 'model-a',
            dimension: 3,
            calls: firstCalls
        })
        assert.throws(
            () => first.assertPresetReady('preset-a'),
            /vector index is not ready/u
        )
        await first.start()
        await first.waitForInitialization()
        const firstStatus = first.getStatus()
        assert.equal(firstStatus.state, 'ready')
        assert.equal(firstStatus.presets[0].indexedCount, 2)
        assert.doesNotThrow(() => first.assertPresetReady('preset-a'))
        assert.equal(repository.jobs[0].status, 'completed')
        assert.equal(repository.jobs[0].detail, '处理记忆：2 条')
        assert.equal(repository.jobs[1].status, 'completed')
        assert.equal(repository.jobs[1].detail, '近邻索引：已构建')
        assert.ok(
            firstCalls.some((texts) => texts.includes('content memory-a'))
        )
        const semanticHits = await first.searchHybrid({
            presetId: 'preset-a',
            searchTexts: ['content memory-a'],
            keywords: [],
            memoryTypes: ['fact'],
            memoryStatus: 'active',
            maxCandidates: 2,
            minSimilarity: 0
        })
        assert.deepEqual(
            semanticHits.map((hit) => hit.memoryId),
            ['memory-a']
        )
        const hybridHits = await first.searchHybrid({
            presetId: 'preset-a',
            searchTexts: ['content memory-a'],
            keywords: ['memory-b'],
            memoryTypes: null,
            memoryStatus: 'active',
            maxCandidates: 2,
            minSimilarity: 0
        })
        assert.equal(hybridHits[0].memoryId, 'memory-b')
        assert.equal(hybridHits[0].keywordMatchCount, 1)
        const page = await first.readVectorSnapshot('preset-a', ['memory-a'])
        assert.deepEqual(
            page.items.map((item) => item.memoryId),
            ['memory-a']
        )
        assert.ok(page.items[0].vector instanceof Float32Array)
        assert.equal(page.dimension, 3)
        assert.equal(page.embeddingModelId, 'model-a')
        assert.deepEqual(
            (await first.readVectorSnapshot('preset-a', ['missing-memory']))
                .missingMemoryIds,
            ['missing-memory']
        )
        await first.stop()

        const secondCalls: string[][] = []
        const second = createService({
            repository,
            modelId: 'model-a',
            dimension: 3,
            calls: secondCalls
        })
        await second.start()
        await second.waitForInitialization()
        const secondStatus = second.getStatus()
        assert.equal(secondStatus.state, 'ready')
        assert.equal(
            secondStatus.manifest?.generation,
            firstStatus.manifest?.generation
        )
        assert.equal(repository.jobs[2].status, 'completed')
        assert.equal(repository.jobs[2].detail, '处理记忆：2 条')
        assert.equal(repository.jobs[3].detail, '近邻索引：复用已有索引')
        assert.equal(secondCalls.length, 1)
        await second.stop()
    })
}, 60_000)

it('keeps exact recall ready when the independent HNSW maintenance fails', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        const repository = new TestVectorIndexRepository([
            createSource('memory-a')
        ])
        const service = createService({
            repository,
            modelId: 'model-a',
            dimension: 3,
            workerFactory: (onFailure) => {
                const worker = new LivingMemoryVectorIndexWorkerClient(
                    workerPath,
                    onFailure
                )
                worker.buildDreamAnnIndex = async () => {
                    throw new Error('injected HNSW build failure')
                }
                return worker
            }
        })
        try {
            await service.start()
            await service.waitForInitialization()
            assert.equal(service.getStatus().state, 'ready')
            assert.equal(repository.jobs.at(-1)?.status, 'failed')
            const page = await service.readVectorSnapshot('preset-a', [
                'memory-a'
            ])
            const result = await service.queryDreamNeighbors([
                {
                    sourceIndex: 0,
                    sourceMemoryId: 'memory-a',
                    presetId: 'preset-a',
                    generation: page.generation,
                    vector: page.items[0].vector,
                    limit: 10,
                    efSearch: 40
                }
            ])
            assert.equal(result.reason, 'index-absent')
            const hits = await service.searchHybrid({
                presetId: 'preset-a',
                searchTexts: ['content memory-a'],
                keywords: [],
                memoryTypes: null,
                memoryStatus: 'active',
                maxCandidates: 1,
                minSimilarity: 0
            })
            assert.equal(hits[0].memoryId, 'memory-a')
        } finally {
            await service.stop()
        }
    })
})

it('restarts the worker and reinitializes the existing index', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        const repository = new TestVectorIndexRepository([
            createSource('memory-a')
        ])
        const service = createService({
            repository,
            modelId: 'model-a',
            dimension: 3
        })
        await service.start()
        await service.waitForInitialization()

        await service.restart()
        assert.equal(service.getStatus().state, 'building')
        await service.waitForInitialization()

        assert.equal(service.getStatus().state, 'ready')
        assert.equal(repository.jobs.length, 4)
        await service.stop()
    })
})

it('clears orphaned preset state rows during startup reconcile', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        const repository = new TestVectorIndexRepository([
            createSource('memory-a')
        ])
        const first = createService({
            repository,
            modelId: 'model-a',
            dimension: 3
        })
        await first.start()
        await first.waitForInitialization()
        await first.stop()

        // 没有记忆和向量文档的预设仍有一条 dirty 状态记录。
        const indexDirectory = resolveIndexDirectory(baseDir)
        const database = new PGlite(
            resolve(indexDirectory, 'vector-index.pglite')
        )
        await database.query(
            `INSERT INTO lm_index_preset_state (
                preset_id, state, expected_count, indexed_count,
                last_error, updated_at
            ) VALUES ('ghost-preset', 'dirty', 0, 0, NULL, $1)`,
            [Date.now()]
        )
        await database.close()

        const second = createService({
            repository,
            modelId: 'model-a',
            dimension: 3
        })
        await second.start()
        await second.waitForInitialization()

        const status = second.getStatus()
        assert.equal(status.state, 'ready')
        assert.deepEqual(
            status.presets.map((preset) => preset.presetId),
            ['preset-a']
        )
        assert.doesNotThrow(() => second.assertPresetReady('preset-a'))
        const hits = await second.searchHybrid({
            presetId: 'preset-a',
            searchTexts: ['content memory-a'],
            keywords: [],
            memoryTypes: null,
            memoryStatus: 'active',
            maxCandidates: 2,
            minSimilarity: 0
        })
        assert.deepEqual(
            hits.map((hit) => hit.memoryId),
            ['memory-a']
        )
        await second.stop()
    })
})

it('starts a full rebuild without blocking the caller', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        const repository = new TestVectorIndexRepository([
            createSource('memory-a')
        ])
        const service = createService({
            repository,
            modelId: 'model-a',
            dimension: 3
        })
        await service.start()
        await service.waitForInitialization()

        service.startRebuild('manual rebuild')
        assert.equal(service.getStatus().state, 'building')
        await service.waitForMaintenance()

        assert.equal(service.getStatus().state, 'ready')
        assert.match(repository.jobs.at(-2)?.input ?? '', /manual rebuild/u)
        assert.equal(repository.jobs.at(-1)?.detail, '近邻索引：已构建')
        await service.stop()
    })
}, 120_000)

it('clears unavailable after a successful full rebuild', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        let failProbe = true
        const service = createService({
            repository: new TestVectorIndexRepository([
                createSource('memory-a')
            ]),
            modelId: 'model-a',
            dimension: 3,
            onDocuments: async (texts) => {
                if (failProbe && texts[0].includes('dimension probe')) {
                    throw new Error('injected embedding failure')
                }
            }
        })

        await service.start()
        await service.waitForInitialization()
        assert.equal(service.getStatus().state, 'unavailable')

        service.startRebuild('failed recovery attempt')
        await service.waitForMaintenance()
        assert.equal(service.getStatus().state, 'unavailable')

        failProbe = false
        service.startRebuild('recover unavailable state')
        await service.waitForMaintenance()

        assert.equal(service.getStatus().state, 'ready')
        assert.equal(service.getStatus().lastError, null)
        assert.doesNotThrow(() => service.assertPresetReady('preset-a'))
        await service.stop()
    })
})

it('clears unavailable after a successful preset reconcile', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        let failProbe = false
        const repository = new TestVectorIndexRepository([
            createSource('memory-a')
        ])
        const service = createService({
            repository,
            modelId: 'model-a',
            dimension: 3,
            onDocuments: async (texts) => {
                if (failProbe && texts[0].includes('dimension probe')) {
                    throw new Error('injected embedding failure')
                }
            }
        })

        await service.start()
        await service.waitForInitialization()
        assert.equal(service.getStatus().state, 'ready')

        failProbe = true
        await service.reconcilePreset('preset-a', 'failed recovery attempt')
        await service.waitForMaintenance()
        assert.equal(service.getStatus().state, 'unavailable')
        assert.throws(
            () => service.assertPresetReady('preset-a'),
            /state=unavailable/u
        )

        failProbe = false
        await service.reconcilePreset('preset-a', 'recover unavailable state')
        await service.waitForMaintenance()

        assert.equal(service.getStatus().state, 'ready')
        assert.equal(service.getStatus().lastError, null)
        assert.doesNotThrow(() => service.assertPresetReady('preset-a'))
        await service.stop()
    })
})

it('rolls back to the previous index when the candidate worker cannot open', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        const repository = new TestVectorIndexRepository([
            createSource('memory-a')
        ])
        const initial = createService({
            repository,
            modelId: 'model-a',
            dimension: 3
        })
        await initial.start()
        await initial.waitForInitialization()
        const initialGeneration = initial.getStatus().manifest?.generation
        await initial.stop()

        const candidateError = new Error('injected candidate open failure')
        let created = 0
        const failed = createService({
            repository,
            modelId: 'model-b',
            dimension: 3,
            workerFactory: (onFailure) => {
                created += 1
                const worker = new LivingMemoryVectorIndexWorkerClient(
                    workerPath,
                    onFailure
                )
                if (created === 1) {
                    const openCandidate = worker.openCandidate.bind(worker)
                    let failedOnce = false
                    worker.openCandidate = async (directory) => {
                        const inspection = await openCandidate(directory)
                        if (!failedOnce) {
                            failedOnce = true
                            throw candidateError
                        }
                        return inspection
                    }
                }
                return worker
            }
        })
        await failed.start()
        await failed.waitForInitialization()
        assert.equal(failed.getStatus().state, 'unavailable')
        assert.match(
            failed.getStatus().lastError ?? '',
            /injected candidate open failure/u
        )
        await failed.stop()

        const indexFiles = await readdir(resolveIndexDirectory(baseDir))
        assert.equal(
            indexFiles.some((file) => file.startsWith('vector-index.rebuild-')),
            false,
            indexFiles.join(', ')
        )
        assert.equal(indexFiles.includes('vector-index.previous.pglite'), false)

        const recovered = createService({
            repository,
            modelId: 'model-a',
            dimension: 3
        })
        await recovered.start()
        await recovered.waitForInitialization()
        assert.equal(recovered.getStatus().state, 'ready')
        assert.equal(
            recovered.getStatus().manifest?.generation,
            initialGeneration
        )
        await recovered.stop()
    })
}, 120_000)

it('rebuilds memories with the bundled pgvector version when the installed extension differs', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        const repository = new TestVectorIndexRepository([createSource('memory-a')])
        const options = { repository, modelId: 'embedding', dimension: 3 }
        const first = createService(options)
        await first.start()
        await first.waitForInitialization()
        const manifest = first.getStatus().manifest!
        await first.stop()

        const database = new PGlite(resolve(resolveIndexDirectory(baseDir), 'vector-index.pglite'))
        try {
            await database.exec(`
                UPDATE pg_extension SET extversion = '0.8.1' WHERE extname = 'vector';
                UPDATE lm_index_manifest SET vector_extension_version = '0.8.1';
            `)
        } finally {
            await database.close()
        }

        const second = createService(options)
        try {
            await second.start()
            await second.waitForInitialization()
            const status = second.getStatus()
            assert.equal(status.state, 'ready', status.lastError ?? undefined)
            assert.notEqual(status.manifest?.generation, manifest.generation)
            assert.equal(status.manifest?.vectorExtensionVersion, manifest.vectorExtensionVersion)
            const snapshot = await second.readVectorSnapshot('preset-a', ['memory-a'])
            assert.deepEqual(snapshot.items.map(item => item.memoryId), ['memory-a'])
        } finally {
            await second.stop()
        }
    })
})

it('rebuilds when the model, dimension, or schema version changes', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        const repository = new TestVectorIndexRepository([
            createSource('memory-a')
        ])
        const configurations = [
            { modelId: 'model-a', dimension: 3, schemaVersion: 1 },
            { modelId: 'model-b', dimension: 3, schemaVersion: 1 },
            { modelId: 'model-b', dimension: 4, schemaVersion: 1 },
            { modelId: 'model-b', dimension: 4, schemaVersion: 2 }
        ]
        const generations: string[] = []

        for (const configuration of configurations) {
            const service = createService({
                repository,
                ...configuration
            })
            await service.start()
            await service.waitForInitialization()
            const status = service.getStatus()
            assert.equal(status.state, 'ready')
            assert.equal(
                status.manifest?.embeddingModelId,
                configuration.modelId
            )
            assert.equal(status.manifest?.dimension, configuration.dimension)
            assert.equal(
                status.manifest?.schemaVersion,
                configuration.schemaVersion
            )
            generations.push(status.manifest?.generation ?? '')
            await service.stop()
        }

        assert.equal(new Set(generations).size, configurations.length)
    })
}, 180_000)

it('fails startup and preserves an unreadable formal database', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        const indexDirectory = resolveIndexDirectory(baseDir)
        await mkdir(indexDirectory, { recursive: true })
        await writeFile(
            resolve(indexDirectory, 'vector-index.pglite'),
            'not a PGlite data directory'
        )
        const repository = new TestVectorIndexRepository([
            createSource('memory-a')
        ])
        const service = createService({
            repository,
            modelId: 'model-a',
            dimension: 3
        })

        await assert.rejects(service.start())
        assert.equal(service.getStatus().state, 'unavailable')
        assert.equal(repository.jobs.length, 0)
        assert.equal(
            await readFile(
                resolve(indexDirectory, 'vector-index.pglite'),
                'utf8'
            ),
            'not a PGlite data directory'
        )
        await service.stop()
    })
})

it('fails startup when the worker cannot start', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        const repository = new TestVectorIndexRepository([])
        const captured = createLogger()
        const service = createService({
            repository,
            modelId: 'model-a',
            dimension: 3,
            workerPath: resolve(baseDir, 'missing-worker.mjs'),
            logger: captured.logger
        })

        await assert.rejects(service.start(), /missing-worker\.mjs/u)
        const status = service.getStatus()
        assert.equal(status.state, 'unavailable')
        assert.match(status.lastError ?? '', /worker/u)
        await service.stop()
    })
})

it('keeps index jobs running until work completes and records failures', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        const repository = new TestVectorIndexRepository([
            createSource('memory-a')
        ])
        let releaseDocuments: (() => void) | undefined
        const documentsReleased = new Promise<void>((resolvePromise) => {
            releaseDocuments = resolvePromise
        })
        let signalDocumentsStarted: (() => void) | undefined
        const documentsStarted = new Promise<void>((resolvePromise) => {
            signalDocumentsStarted = resolvePromise
        })
        const service = createService({
            repository,
            modelId: 'model-a',
            dimension: 3,
            onDocuments: async (texts) => {
                if (texts[0].includes('dimension probe')) {
                    return
                }
                assert.ok(signalDocumentsStarted)
                signalDocumentsStarted()
                await documentsReleased
            }
        })

        await service.start()
        await documentsStarted
        assert.equal(repository.jobs[0].status, 'running')
        assert.ok(releaseDocuments)
        releaseDocuments()
        await service.waitForInitialization()
        assert.equal(repository.jobs[0].status, 'completed')
        await service.stop()
    })

    await withTemporaryDirectory(async (baseDir) => {
        const repository = new TestVectorIndexRepository([
            createSource('memory-a')
        ])
        const captured = createLogger()
        const service = createService({
            repository,
            modelId: 'model-a',
            dimension: 3,
            logger: captured.logger,
            onDocuments: async (texts) => {
                if (!texts[0].includes('dimension probe')) {
                    throw new Error('injected embedding failure')
                }
            }
        })

        await service.start()
        await service.waitForInitialization()
        assert.equal(repository.jobs[0].status, 'failed')
        assert.match(repository.jobs[0].error ?? '', /embedding failure/u)
        assert.equal(repository.jobs[0].detail, '索引重建失败')
        assert.equal(service.getStatus().state, 'unavailable')
        assert.equal(captured.warnings.length, 2)
        const failureLog = String(captured.warnings[0][0])
        assert.match(failureLog, /事件：索引重建失败/u)
        assert.ok(failureLog.includes(`任务：${repository.jobs[0].id}`))
        assert.match(failureLog, /预设：\*/u)
        assert.match(String(captured.warnings[1][0]), /事件：向量索引服务异常/u)
        await service.stop()
    })
}, 120_000)

it('reuses one worker while finalizing a rebuild', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        const repository = new TestVectorIndexRepository([])
        const captured = createLogger()
        let created = 0
        const service = createService({
            repository,
            modelId: 'model-a',
            dimension: 3,
            logger: captured.logger,
            workerFactory: (onFailure) => {
                created += 1
                const worker = new LivingMemoryVectorIndexWorkerClient(
                    workerPath,
                    onFailure
                )
                return worker
            }
        })

        await service.start()
        await service.waitForInitialization()
        assert.equal(created, 1)
        assert.equal(captured.warnings.length, 0)
        await service.stop()
        assert.equal(captured.warnings.length, 0)
    })
})
