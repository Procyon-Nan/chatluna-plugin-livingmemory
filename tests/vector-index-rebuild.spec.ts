import assert from 'node:assert/strict'
import { mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type {
    MemoryIndexSourceRecord,
    MemoryVectorIndexManifest
} from '../src/contracts/vector_index.ts'
import { VectorIndexOperationGate } from '../src/service/vector_index/operation_gate.ts'
import { rebuildVectorIndex } from '../src/service/vector_index/rebuild.ts'
import { reconcileVectorIndexPreset } from '../src/service/vector_index/reconcile.ts'
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

class TestRebuildRepository {
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

const createManifest = (
    generation: string,
    dimension = 3
): MemoryVectorIndexManifest => ({
    schemaVersion: 5,
    embeddingModelId: 'model-a',
    dimension,
    storageEngine: 'pglite-pgvector',
    vectorExtensionVersion: '0.8.7',
    generation,
    builtAt: Date.now()
})

const createVector = (text: string, dimension: number) => {
    const vector = new Array<number>(dimension).fill(0)
    vector[0] = 1
    if (dimension > 1) {
        vector[1] = (text.length % 11) / 10
    }
    return vector
}

const createEmbeddings = (
    dimension: number,
    calls: string[][],
    failure?: (texts: string[]) => Error | null
) => ({
    embedQuery: async (text: string) => createVector(text, dimension),
    embedDocuments: async (texts: string[]) => {
        calls.push([...texts])
        const error = failure?.(texts)
        if (error !== undefined && error !== null) {
            throw error
        }
        return texts.map((text) => createVector(text, dimension))
    }
})

const withWorker = async (
    callback: (
        client: LivingMemoryVectorIndexWorkerClient,
        directory: string
    ) => Promise<void>
) => {
    const directory = await mkdtemp(
        resolve(tmpdir(), 'living-memory-vector-rebuild-test-')
    )
    const client = new LivingMemoryVectorIndexWorkerClient(workerPath)
    try {
        await client.open(
            resolve(directory, 'vector-index'),
            resolve(directory, 'vector-index.previous')
        )
        await callback(client, directory)
    } finally {
        await client.dispose()
        await rm(directory, { recursive: true, force: true })
    }
}

const buildFormalIndex = async (options: {
    client: LivingMemoryVectorIndexWorkerClient
    directory: string
    repository: TestRebuildRepository
    embeddings: ReturnType<typeof createEmbeddings>
    generation: string
}) => {
    const {
        client,
        directory,
        repository,
        embeddings,
        generation
    } = options
    const manifest = createManifest(generation)
    return await rebuildVectorIndex({
        repository,
        worker: client,
        embeddings,
        dimension: manifest.dimension,
        manifest,
        rebuildDatabaseDirectory: resolve(
            directory,
            `vector-index.rebuild-${generation}`
        ),
        shouldStop: () => false,
        onProgress: async () => {},
        finalize: async (transferCleanupOwnership) => {
            await client.validateAndCloseRebuildDatabase(
                repository.sources.length
            )
            transferCleanupOwnership()
            const activeDirectory = resolve(directory, 'vector-index')
            const previousDirectory = resolve(
                directory,
                'vector-index.previous'
            )
            await rename(activeDirectory, previousDirectory)
            await rename(
                resolve(directory, `vector-index.rebuild-${generation}`),
                activeDirectory
            )
            const inspection = await client.openCandidate(activeDirectory)
            await rm(previousDirectory, { recursive: true })
            return inspection
        }
    })
}

it('indexes each rebuilt entry with its generated vector', async () => {
    await withWorker(async (client, directory) => {
        const repository = new TestRebuildRepository([
            createSource('memory-a', { content: 'alpha' }),
            createSource('memory-b', { content: 'beta' })
        ])
        const calls: string[][] = []
        await buildFormalIndex({ client, directory, repository, embeddings: createEmbeddings(3, calls), generation: 'rebuilt' })
        assert.deepEqual(calls, [['alpha', 'beta']])
        const snapshot = await client.readVectorSnapshot('preset-a', ['memory-a', 'memory-b'])
        for (const item of snapshot.items) {
            const source = repository.sources.find(entry => entry.id === item.memoryId)!
            assert.deepEqual([...item.vector], [...new Float32Array(createVector(source.content, 3))])
        }
        assert.equal(snapshot.items.length, 2)
    })
})

it('does not abort through the old worker after finalize takes cleanup ownership', async () => {
    const finalizeError = new Error('injected finalize failure')
    let abortCalls = 0
    await assert.rejects(
        rebuildVectorIndex({
            repository: new TestRebuildRepository([]),
            worker: {
                openRebuildDatabase: async () => ({
                    vectorExtensionVersion: '0.8.7',
                    availableVectorExtensionVersion: '0.8.7',
                    manifest: null,
                    indexedCount: 0,
                    inventory: [],
                    presets: []
                }),
                appendRebuildBatch: async () => ({ indexedCount: 0 }),
                abortRebuild: async () => {
                    abortCalls += 1
                    throw new Error('abort must not run')
                }
            },
            embeddings: createEmbeddings(3, []),
            dimension: 3,
            manifest: createManifest('finalize-failure'),
            rebuildDatabaseDirectory: 'unused',
            shouldStop: () => false,
            onProgress: async () => {},
            finalize: async (transferCleanupOwnership) => {
                transferCleanupOwnership()
                throw finalizeError
            }
        }),
        /injected finalize failure/u
    )
    assert.equal(abortCalls, 0)
})

it('aborts through the worker when finalize fails before taking cleanup ownership', async () => {
    const finalizeError = new Error('injected pre-transfer failure')
    let abortCalls = 0
    await assert.rejects(
        rebuildVectorIndex({
            repository: new TestRebuildRepository([]),
            worker: {
                openRebuildDatabase: async () => ({
                    vectorExtensionVersion: '0.8.7',
                    availableVectorExtensionVersion: '0.8.7',
                    manifest: null,
                    indexedCount: 0,
                    inventory: [],
                    presets: []
                }),
                appendRebuildBatch: async () => ({ indexedCount: 0 }),
                abortRebuild: async () => {
                    abortCalls += 1
                    return {
                        vectorExtensionVersion: '0.8.7',
                        availableVectorExtensionVersion: '0.8.7',
                        manifest: null,
                        indexedCount: 0,
                        inventory: [],
                        presets: []
                    }
                }
            },
            embeddings: createEmbeddings(3, []),
            dimension: 3,
            manifest: createManifest('pre-transfer-failure'),
            rebuildDatabaseDirectory: 'unused',
            shouldStop: () => false,
            onProgress: async () => {},
            finalize: async () => {
                throw finalizeError
            }
        }),
        /injected pre-transfer failure/u
    )
    assert.equal(abortCalls, 1)
})

it('reconciles additions, metadata updates, content changes, and orphans', async () => {
    await withWorker(async (client, directory) => {
        const repository = new TestRebuildRepository([
            createSource('memory-a'),
            createSource('memory-b'),
            createSource('memory-orphan')
        ])
        await buildFormalIndex({
            client,
            directory,
            repository,
            embeddings: createEmbeddings(3, []),
            generation: 'reconcile'
        })
        const before = await client.readVectorSnapshot('preset-a', ['memory-a'])

        repository.sources.splice(
            0,
            repository.sources.length,
            createSource('memory-a', {
                status: 'archived',
                type: 'preference',
                keywords: ['updated'],
                updatedAt: new Date('2026-08-08T01:00:00.000Z')
            }),
            createSource('memory-b', {
                content: 'updated content memory-b'
            }),
            createSource('memory-new')
        )
        const calls: string[][] = []
        await reconcileVectorIndexPreset({
            presetId: 'preset-a',
            repository,
            worker: client,
            embeddings: createEmbeddings(3, calls),
            dimension: 3,
            shouldStop: () => false,
            onProgress: async () => {}
        })

        assert.deepEqual(calls, [
            ['updated content memory-b', 'content memory-new']
        ])
        const inventory = await client.readInventoryPage('preset-a', null, 10)
        assert.deepEqual(
            inventory.items.map((item) => item.memoryId),
            ['memory-a', 'memory-b', 'memory-new']
        )
        assert.equal(inventory.items[0].status, 'archived')
        assert.equal(inventory.items[0].type, 'preference')
        assert.equal(
            inventory.items[0].updatedAt,
            +repository.sources[0].updatedAt
        )
        const after = await client.readVectorSnapshot('preset-a', ['memory-a'])
        assert.deepEqual(
            [...after.items[0].vector],
            [...before.items[0].vector]
        )
        const inspection = await client.inspect()
        assert.equal(inspection.presets[0].state, 'ready')
        assert.equal(inspection.presets[0].indexedCount, 3)
    })
})

it('marks a preset dirty when reconcile embedding fails', async () => {
    await withWorker(async (client, directory) => {
        const repository = new TestRebuildRepository([createSource('memory-a')])
        await buildFormalIndex({
            client,
            directory,
            repository,
            embeddings: createEmbeddings(3, []),
            generation: 'dirty'
        })
        repository.sources[0] = createSource('memory-a', {
            content: 'changed content'
        })

        await assert.rejects(
            reconcileVectorIndexPreset({
                presetId: 'preset-a',
                repository,
                worker: client,
                embeddings: createEmbeddings(
                    3,
                    [],
                    () => new Error('injected reconcile failure')
                ),
                dimension: 3,
                shouldStop: () => false,
                onProgress: async () => {}
            }),
            /vector index reconcile failed/u
        )
        const inspection = await client.inspect()
        assert.equal(inspection.presets[0].state, 'dirty')
        assert.match(
            inspection.presets[0].lastError ?? '',
            /injected reconcile failure/u
        )
    })
})

it('releases the exclusive operation barrier after a mutation fails', async () => {
    const gate = new VectorIndexOperationGate()
    await assert.rejects(
        gate.runMutation(async () => {
            throw new Error('injected mutation failure')
        }),
        /injected mutation failure/u
    )
    const result = await gate.runExclusive(async () => 'completed')
    assert.equal(result, 'completed')
})
