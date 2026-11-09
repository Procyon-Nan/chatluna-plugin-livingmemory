import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
    DreamNeighborQuery,
    MemoryVectorIndexManifest,
    MemoryVectorIndexState
} from '../../../contracts/vector_index.ts'
import type {
    VectorIndexHybridQuery,
    VectorIndexInspection,
    VectorIndexMutation,
    VectorIndexPresetStateMark,
    VectorIndexReplaceUpsert
} from '../worker_protocol.ts'
import {
    applyVectorIndexMutation,
    clearVectorIndexPreset,
    countVectorIndexMemories,
    markVectorIndexPresetState
} from './mutations.ts'
import {
    queryVectorIndexHybrid,
    readVectorSnapshot,
    readVectorIndexInventoryPage
} from './queries.ts'
import {
    analyzeVectorIndex,
    createVectorIndexSchema,
    hasVectorIndexSchema
} from './schema.ts'
import { LivingMemoryVectorIndexOwnershipEndpoint } from './ownership_endpoint.ts'
import { buildDreamAnnIndex, queryDreamNeighbors } from './dream_ann.ts'

interface ManifestRow {
    schemaVersion: number
    embeddingModelId: string
    dimension: number
    storageEngine: MemoryVectorIndexManifest['storageEngine']
    vectorExtensionVersion: string
    generation: string
    builtAt: number
}

interface PresetStateRow {
    presetId: string
    state: MemoryVectorIndexState
    expectedCount: number
    indexedCount: number
    lastError: string | null
    updatedAt: number
}

const removeDirectory = (directory: string) => {
    rmSync(directory, { recursive: true, force: true })
}

interface VectorIndexDatabaseOptions {
    removeDirectory?: (directory: string) => void
    reportWarning?: (warning: Error) => void
    analyze?: typeof analyzeVectorIndex
}

export class LivingMemoryVectorIndexDatabase {
    private database: PGlite | null = null
    private activeDatabaseDirectory: string | null = null
    private rebuildDatabaseDirectory: string | null = null
    private mode: 'active' | 'rebuild' | null = null

    private readonly removeDatabaseDirectory: (directory: string) => void
    private readonly reportWarning: (warning: Error) => void
    private readonly analyze: typeof analyzeVectorIndex
    private readonly ownershipEndpoint =
        new LivingMemoryVectorIndexOwnershipEndpoint()

    constructor(options: VectorIndexDatabaseOptions = {}) {
        this.removeDatabaseDirectory =
            options.removeDirectory ?? removeDirectory
        this.reportWarning =
            options.reportWarning ?? ((warning) => process.emitWarning(warning))
        this.analyze = options.analyze ?? analyzeVectorIndex
    }

    async open(
        databaseDirectory: string,
        previousDatabaseDirectory: string
    ): Promise<VectorIndexInspection> {
        if (this.database !== null) {
            throw new Error('vector index database is already open')
        }
        await this.ownershipEndpoint.acquire(databaseDirectory)
        try {
            return await this.openOwned(
                databaseDirectory,
                previousDatabaseDirectory
            )
        } catch (error) {
            await this.closeConnection()
            await this.ownershipEndpoint.release()
            throw error
        }
    }

    private async openOwned(
        databaseDirectory: string,
        previousDatabaseDirectory: string
    ): Promise<VectorIndexInspection> {
        this.activeDatabaseDirectory = databaseDirectory
        if (
            !existsSync(databaseDirectory) &&
            existsSync(previousDatabaseDirectory)
        ) {
            renameSync(previousDatabaseDirectory, databaseDirectory)
        }

        this.database = await this.openConnection(databaseDirectory)
        this.mode = 'active'
        let inspection = await this.inspect()

        if (
            existsSync(previousDatabaseDirectory) &&
            inspection.manifest === null
        ) {
            inspection = await this.restorePreviousDatabase(
                databaseDirectory,
                previousDatabaseDirectory
            )
        }
        if (existsSync(previousDatabaseDirectory)) {
            this.cleanupDatabaseDirectory(
                previousDatabaseDirectory,
                'previous index cleanup after recovery'
            )
        }
        return inspection
    }

    async inspect(): Promise<VectorIndexInspection> {
        const database = this.requireDatabase()
        const extensions = await this.readVectorExtensionVersions(database)
        if (!(await hasVectorIndexSchema(database))) {
            return {
                ...extensions,
                manifest: null,
                indexedCount: 0,
                inventory: [],
                presets: []
            }
        }

        const manifest = (
            await database.query<ManifestRow>(
                `SELECT
                    schema_version AS "schemaVersion",
                    embedding_model_id AS "embeddingModelId",
                    dimension,
                    storage_engine AS "storageEngine",
                    vector_extension_version AS "vectorExtensionVersion",
                    generation,
                    built_at AS "builtAt"
                 FROM lm_index_manifest
                 WHERE singleton = 1`
            )
        ).rows[0]
        const presets = (
            await database.query<PresetStateRow>(
                `SELECT
                    preset_id AS "presetId",
                    state,
                    expected_count AS "expectedCount",
                    indexed_count AS "indexedCount",
                    last_error AS "lastError",
                    updated_at AS "updatedAt"
                 FROM lm_index_preset_state
                 ORDER BY preset_id ASC`
            )
        ).rows
        const inventory = (
            await database.query<{ presetId: string; indexedCount: string }>(
                `SELECT preset_id AS "presetId", COUNT(*)::text AS "indexedCount"
                 FROM lm_index_memory
                 GROUP BY preset_id
                 ORDER BY preset_id ASC`
            )
        ).rows.map((row) => ({
            presetId: row.presetId,
            indexedCount: Number(row.indexedCount)
        }))

        return {
            ...extensions,
            manifest: manifest === undefined ? null : manifest,
            indexedCount: await countVectorIndexMemories(database),
            inventory,
            presets: presets.map((preset) => ({
                ...preset,
                expectedCount: Number(preset.expectedCount),
                indexedCount: Number(preset.indexedCount),
                updatedAt: Number(preset.updatedAt)
            }))
        }
    }

    async openCandidate(databaseDirectory: string) {
        if (this.database !== null) {
            throw new Error('vector index database is already open')
        }
        this.ownershipEndpoint.assertOwned()
        this.activeDatabaseDirectory = databaseDirectory
        try {
            this.database = await this.openConnection(databaseDirectory)
            this.mode = 'active'
            return await this.inspect()
        } catch (error) {
            await this.closeConnection()
            this.mode = null
            throw error
        }
    }

    queryHybrid(query: VectorIndexHybridQuery) {
        return queryVectorIndexHybrid(this.requireActiveDatabase(), query)
    }

    buildDreamAnnIndex() {
        return buildDreamAnnIndex(this.requireActiveDatabase())
    }

    queryDreamNeighbors(
        queries: DreamNeighborQuery[],
        cancellation: Int32Array<SharedArrayBuffer>
    ) {
        return queryDreamNeighbors(
            this.requireActiveDatabase(),
            queries,
            cancellation
        )
    }

    readVectorSnapshot(presetId: string, memoryIds: string[]) {
        return readVectorSnapshot(
            this.requireActiveDatabase(),
            presetId,
            memoryIds
        )
    }

    applyMutation(mutation: VectorIndexMutation) {
        return applyVectorIndexMutation(this.requireDatabase(), mutation)
    }

    clearPreset(presetId: string) {
        return clearVectorIndexPreset(this.requireDatabase(), presetId)
    }

    readInventoryPage(
        presetId: string | null,
        afterMemoryId: string | null,
        limit: number
    ) {
        return readVectorIndexInventoryPage(
            this.requireDatabase(),
            presetId,
            afterMemoryId,
            limit
        )
    }

    markPresetState(status: VectorIndexPresetStateMark) {
        return markVectorIndexPresetState(this.requireDatabase(), status)
    }

    async openRebuildDatabase(
        databaseDirectory: string,
        manifest: MemoryVectorIndexManifest
    ): Promise<VectorIndexInspection> {
        if (existsSync(databaseDirectory)) {
            throw new Error(
                `vector index rebuild directory already exists: ${databaseDirectory}`
            )
        }
        const activeDirectory = this.requireActiveDatabaseDirectory()
        await this.closeConnection()
        try {
            this.database = await this.openConnection(databaseDirectory)
            await createVectorIndexSchema(this.database, manifest)
            this.rebuildDatabaseDirectory = databaseDirectory
            this.mode = 'rebuild'
            return this.inspect()
        } catch (error) {
            await this.closeConnection()
            removeDirectory(databaseDirectory)
            this.database = await this.openConnection(activeDirectory)
            this.mode = 'active'
            throw error
        }
    }

    appendRebuildBatch(presetId: string, upserts: VectorIndexReplaceUpsert[]) {
        return applyVectorIndexMutation(this.requireRebuildDatabase(), {
            presetId,
            upserts,
            deletes: []
        })
    }

    async validateAndCloseRebuildDatabase(expectedCount: number) {
        const database = this.requireRebuildDatabase()
        const indexedCount = await countVectorIndexMemories(database)
        if (indexedCount !== expectedCount) {
            throw new Error(
                `vector index rebuild count mismatch: expected=${expectedCount}, actual=${indexedCount}`
            )
        }
        await this.analyze(database)
        await this.closeConnection()
        this.mode = null
        return { indexedCount }
    }

    async closeDatabase() {
        await this.closeConnection()
        this.mode = null
    }

    async abortRebuild(): Promise<VectorIndexInspection> {
        if (this.mode === 'active') {
            return this.inspect()
        }
        const activeDirectory = this.requireActiveDatabaseDirectory()
        const rebuildDirectory = this.requireRebuildDatabaseDirectory()
        await this.closeConnection()
        removeDirectory(rebuildDirectory)
        this.rebuildDatabaseDirectory = null
        this.database = await this.openConnection(activeDirectory)
        this.mode = 'active'
        return this.inspect()
    }

    async dispose() {
        await this.closeConnection()
        await this.ownershipEndpoint.release()
        this.activeDatabaseDirectory = null
        this.rebuildDatabaseDirectory = null
        this.mode = null
    }

    private async openConnection(directory: string) {
        mkdirSync(dirname(directory), { recursive: true })
        const database = await PGlite.create(directory, {
            extensions: { vector }
        })
        try {
            await database.exec('CREATE EXTENSION IF NOT EXISTS vector')
            return database
        } catch (error) {
            await database.close()
            throw error
        }
    }

    private async restorePreviousDatabase(
        databaseDirectory: string,
        previousDatabaseDirectory: string
    ) {
        await this.closeConnection()
        this.removeDatabaseDirectory(databaseDirectory)
        renameSync(previousDatabaseDirectory, databaseDirectory)
        this.database = await this.openConnection(databaseDirectory)
        this.mode = 'active'
        return this.inspect()
    }

    private async closeConnection() {
        if (this.database !== null) {
            const database = this.database
            this.database = null
            await database.close()
        }
    }

    private cleanupDatabaseDirectory(directory: string, operation: string) {
        try {
            this.removeDatabaseDirectory(directory)
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error)
            this.reportWarning(
                new Error(
                    `vector index cleanup failed: operation=${operation} ` +
                        `directory=${directory}: ${message}`,
                    { cause: error }
                )
            )
        }
    }

    private requireDatabase() {
        if (this.database === null) {
            throw new Error('vector index database is not open')
        }
        return this.database
    }

    private requireActiveDatabase() {
        const database = this.requireDatabase()
        if (this.mode !== 'active') {
            throw new Error('vector index database is rebuilding')
        }
        return database
    }

    private requireRebuildDatabase() {
        const database = this.requireDatabase()
        if (this.mode !== 'rebuild') {
            throw new Error('vector index rebuild is not active')
        }
        return database
    }

    private requireActiveDatabaseDirectory() {
        if (this.activeDatabaseDirectory === null) {
            throw new Error('vector index active directory is not set')
        }
        return this.activeDatabaseDirectory
    }

    private requireRebuildDatabaseDirectory() {
        if (this.rebuildDatabaseDirectory === null) {
            throw new Error('vector index rebuild directory is not set')
        }
        return this.rebuildDatabaseDirectory
    }

    private async readVectorExtensionVersions(database: PGlite) {
        const { rows } = await database.query<{
            vectorExtensionVersion: string | null
            availableVectorExtensionVersion: string
        }>(`SELECT installed_version AS "vectorExtensionVersion",
                   default_version AS "availableVectorExtensionVersion"
            FROM pg_available_extensions WHERE name = 'vector'`)
        const versions = rows[0]
        if (!versions?.vectorExtensionVersion) {
            throw new Error('pgvector extension is not loaded')
        }
        return {
            vectorExtensionVersion: versions.vectorExtensionVersion,
            availableVectorExtensionVersion: versions.availableVectorExtensionVersion
        }
    }
}
