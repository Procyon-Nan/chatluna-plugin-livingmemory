import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import { LivingMemoryRepository } from '../src/service/persistence/repository.ts'
import type { LivingMemoryEntryTableRecord } from '../src/service/persistence/types.ts'
import { createTestContext } from './persistence-test-utils.ts'

interface LegacyEntryInput {
    id: string
    presetId: string
    type: 'other'
    status: 'active'
    content: string
    keywords: string[]
    summary: null
    sentiment: null
    importance: null
    sourceConversationId: string
    sourceOrigins?: unknown
    createdAt: Date
    updatedAt: Date
}

const createEntry = (id: string, sourceOrigins: unknown): LegacyEntryInput => ({
    id,
    presetId: 'test-preset',
    type: 'other',
    status: 'active',
    content: id,
    keywords: [],
    summary: null,
    sentiment: null,
    importance: null,
    sourceConversationId: 'test-conversation',
    sourceOrigins,
    createdAt: new Date(),
    updatedAt: new Date()
})

const startDatabase = async (ctx: Context) => {
    await ctx.plugin(Database)
    await ctx.plugin(SQLiteDriver, { path: ':memory:' })
}

// SQLite 驱动用 `new URL(path, ctx.baseUrl)` 解析文件路径，baseUrl 必须是 file: URL。
const startDatabaseAt = async (ctx: Context, path: string, baseDir: string) => {
    ctx.baseUrl = pathToFileURL(baseDir).href
    await ctx.plugin(Database)
    await ctx.plugin(SQLiteDriver, { path })
}

const insertLegacyEntry = async (ctx: Context, entry: LegacyEntryInput) => {
    await ctx.database.create(
        'living_memory_entry',
        entry as unknown as Partial<LivingMemoryEntryTableRecord>
    )
}

const defineLegacyEntryTable = (ctx: Context) => {
    ctx.model.extend(
        'living_memory_entry',
        {
            id: 'string(64)',
            presetId: 'string(255)',
            type: 'string(32)',
            status: 'string(16)',
            content: 'text',
            keywords: 'json',
            summary: 'text',
            sentiment: 'text',
            importance: 'double',
            sourceConversationId: 'string(255)',
            isConsolidated: { type: 'boolean', initial: false },
            embedding: 'json',
            embeddingModelId: 'string(255)',
            createdAt: 'timestamp',
            updatedAt: 'timestamp'
        },
        {
            autoInc: false,
            primary: 'id',
            indexes: [['presetId', 'isConsolidated']]
        }
    )
}

it('migrates legacy sourceOrigins objects once and preserves arrays', async () => {
    const ctx = createTestContext()
    await startDatabase(ctx)
    const repository = new LivingMemoryRepository(ctx)
    repository.defineTables()
    await ctx.database.prepared()

    try {
        await insertLegacyEntry(ctx, createEntry('legacy', {}))
        await insertLegacyEntry(
            ctx,
            createEntry('current', [
                {
                    messages: [
                        {
                            role: 'user',
                            content: 'hello',
                            transcriptLines: ['Alice说：hello']
                        }
                    ]
                }
            ])
        )

        assert.equal(await repository.migrateMemorySourceOriginsArray(), 1)

        const entries = await ctx.database.get('living_memory_entry', {})
        const entryById = new Map(entries.map((entry) => [entry.id, entry]))
        assert.deepEqual(entryById.get('legacy')?.sourceOrigins, [])
        assert.deepEqual(entryById.get('current')?.sourceOrigins, [
            {
                messages: [
                    {
                        role: 'user',
                        content: 'hello',
                        transcriptLines: ['Alice说：hello']
                    }
                ]
            }
        ])
        assert.equal(await repository.migrateMemorySourceOriginsArray(), 0)
        assert.equal(
            (
                await ctx.database.get('living_memory_migration', {
                    id: 'source-origins-array-v1'
                })
            ).length,
            1
        )
    } finally {
        await ctx.fiber.dispose()
    }
})

it('repairs the legacy SQLite json default after applying current tables', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'livingmemory-migration-'))
    const databasePath = join(baseDir, 'legacy.db')
    try {
        const legacyCtx = createTestContext(baseDir)
        await startDatabaseAt(legacyCtx, databasePath, baseDir)
        defineLegacyEntryTable(legacyCtx)
        await legacyCtx.database.prepared()

        try {
            const { sourceOrigins: _sourceOrigins, ...legacyEntry } =
                createEntry('legacy-schema', undefined)
            await insertLegacyEntry(legacyCtx, legacyEntry)
            const [storedLegacyEntry] = await legacyCtx.database.get(
                'living_memory_entry',
                {
                    id: 'legacy-schema'
                }
            )
            assert.equal(storedLegacyEntry.sourceOrigins, undefined)
        } finally {
            await legacyCtx.fiber.dispose()
        }

        const currentCtx = createTestContext(baseDir)
        await startDatabaseAt(currentCtx, databasePath, baseDir)
        const repository = new LivingMemoryRepository(currentCtx)
        repository.defineTables()
        await currentCtx.database.prepared()

        try {
            assert.equal(await repository.migrateMemorySourceOriginsArray(), 0)
            const { driver } = currentCtx.database.select('living_memory_entry')
            assert.equal(
                (await driver.getIndexes('living_memory_entry')).some(
                    (index) => 'isConsolidated' in index.keys
                ),
                false
            )
            assert.deepEqual(
                (await repository.getEntryById('legacy-schema'))?.sourceOrigins,
                []
            )

            const { sourceOrigins: _sourceOrigins, ...currentEntry } =
                createEntry('current-schema', undefined)
            await insertLegacyEntry(currentCtx, currentEntry)
            assert.deepEqual(
                (await repository.getEntryById('current-schema'))
                    ?.sourceOrigins,
                []
            )
        } finally {
            await currentCtx.fiber.dispose()
        }
    } finally {
        await rm(baseDir, { recursive: true, force: true })
    }
})
