import assert from 'node:assert/strict'
import { LivingMemoryMemoryProviders } from '../src/service/app/memory_providers.ts'
import { createDeleteMemoryTool, createGetMessagesTool, createUpdateMemoryTool } from '../src/service/memory/tools/memory_tools.ts'
import { createSearchMemoryTool } from '../src/service/memory/tools/search_memory_tool.ts'
import { runTool } from './tool-test-utils.ts'
import type {
    LivingMemoryPresetExport,
    MemoryEntryRecord,
    MemoryJobRecord
} from '../src/contracts/memory.ts'
import type {
    MemoryIndexMutationBatch,
    MemoryIndexMutationSink
} from '../src/contracts/vector_index.ts'
import {
    LivingMemoryMutationService,
    MEMORY_DELETE_BATCH_SIZE
} from '../src/service/app/mutation_service.ts'
import type { LivingMemoryLogger } from '../src/service/logging/logger.ts'
import {
    createSyntheticSpeakerLabel,
    createSpeakerKey
} from '../src/service/memory/speaker_identity.ts'
import {
    LivingMemoryFactsCommittedError,
    LivingMemoryVectorIndexError
} from '../src/service/vector_index/errors.ts'
import { withLivingMemoryRepository } from './persistence-test-utils.ts'
import type { LivingMemoryRepository } from '../src/service/persistence/repository.ts'
import { createDreamSessionTools } from '../src/service/workflows/dream/session/tools.ts'
import {
    createDreamSessionState,
    getDreamCoverage,
    advanceDreamBatch,
    pendingDreamMemoryIds,
    recordSkippedDreamBatch
} from '../src/service/workflows/dream/session/state.ts'

const presetId = 'preset-indexed-mutations'
const scope = { presetId, conversationId: 'conversation-1' }

const createSession = async (
    repository: LivingMemoryRepository,
    mutations: LivingMemoryMutationService,
    batches: MemoryEntryRecord[][]
) => {
    const state = createDreamSessionState(
        batches.flatMap((entries) => entries.map((entry) => entry.id))
    )
    state.batches = batches.map((entries, index) => ({
        id: `batch-${index}`,
        entries
    }))
    const tools = createDreamSessionTools({
        presetId,
        state,
        speakers: await repository.listPresetSpeakers(presetId),
        repository,
        mutations
    })

    const invoke = (
        name: string,
        input: Record<string, unknown>
    ): Promise<any> => {
        const tool = tools.find((tool) => tool.name === `living_memory_${name}`)
        assert.ok(tool)
        return tool.run(tool.args(input))
    }
    return { state, tools, invoke }
}

const sessionMemory = {
    type: 'fact',
    content: '整理后的记忆',
    summary: '整理后的摘要',
    keywords: ['整理'],
    sentiment: 'neutral',
    importance: 0.5,
    speakerLabels: []
}

const createLoggerStub = () => {
    const warns: string[] = []
    const logger = {
        summary: (event: string) => {
            warns.push(event)
        }
    } as unknown as LivingMemoryLogger
    return { warns, logger }
}

const flushBackgroundTasks = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
}

class MemoryIndexSinkStub implements MemoryIndexMutationSink {
    readonly mutations: MemoryIndexMutationBatch[] = []
    readonly clearedPresets: string[] = []
    readonly reconciledPresets: string[] = []
    applyError: Error | null = null
    presetReady = true
    reconcileError: Error | null = null

    async waitForMaintenance() {}

    assertPresetReady(targetPresetId: string) {
        if (!this.presetReady) {
            throw new LivingMemoryVectorIndexError(
                'not-ready',
                'building',
                `vector index is not ready: preset=${targetPresetId}`
            )
        }
    }

    async applyMutation(batch: MemoryIndexMutationBatch) {
        if (this.applyError !== null) {
            throw this.applyError
        }
        this.mutations.push(batch)
    }

    async clearPreset(targetPresetId: string) {
        this.clearedPresets.push(targetPresetId)
    }

    async reconcilePreset(targetPresetId: string, reason: string) {
        if (this.reconcileError !== null) {
            throw this.reconcileError
        }
        this.reconciledPresets.push(`${targetPresetId}:${reason}`)
        const now = new Date()
        const job: MemoryJobRecord = {
            id: 'index-job',
            presetId: targetPresetId,
            conversationId: 'vector-index',
            kind: 'index',
            status: 'pending',
            input: `reconcile: ${reason}`,
            detail: null,
            error: null,
            createdAt: now,
            startedAt: null,
            finishedAt: null,
            updatedAt: now
        }
        return job
    }
}

it('resolves model references across calls without confusing presets, archived rows or historical primary keys', async () => {
    await withLivingMemoryRepository(async (ctx, repository) => {
        const original = await repository.createMemory(scope, { type: 'fact', content: '原始记忆' })
        const tail = original.id.slice(-12)
        const hash = 'a'.repeat(52) + tail
        const insert = (id: string, preset: string, status: 'active' | 'archived') =>
            ctx.database.create('living_memory_entry', { ...original, id, presetId: preset, status })
        await insert('b'.repeat(52) + tail, 'another-preset', 'active')
        const mutations = new LivingMemoryMutationService(repository, new MemoryIndexSinkStub(), createLoggerStub().logger)
        const provider = new LivingMemoryMemoryProviders({
            repository, mutations,
            searchEngine: { searchMemories: () => repository.getEntriesWithSources(presetId, [original.id]) }
        })
        const search = async () => runTool<string>(createSearchMemoryTool(provider), { searchTexts: ['记忆'] }, scope)
        const messages = (memoryId: string) => runTool<string>(createGetMessagesTool(provider), { memoryId }, scope)
        const remove = (memoryId: string) => runTool(createDeleteMemoryTool(provider), { memoryId }, scope)

        const found = (await search()).split('\n')[0]
        assert.equal(found, 'id=' + tail)
        assert.equal((await messages(found.slice(3))).split('\n')[0], found)
        assert.equal(await messages(original.id), await messages(tail))
        const otherHash = 'c'.repeat(64)
        await insert(otherHash, presetId, 'active')
        await runTool(createUpdateMemoryTool(provider), { memoryId: otherHash.slice(-12), memory: sessionMemory }, scope)
        assert.equal((await repository.getEntryById(otherHash))?.content, sessionMemory.content)

        await insert(hash, presetId, 'archived')
        assert.equal((await search()).split('\n')[0], 'id=' + original.id)
        await assert.rejects(remove(tail), /对应多条记忆/)
        const { state, invoke } = await createSession(repository, mutations, [[original]])
        advanceDreamBatch(state)
        await assert.rejects(invoke('checked_memory', { memoryIds: [tail], reason: '确认' }), (error: Error) =>
            error.message.includes(original.id) && !error.message.includes(hash))
        await insert(tail, presetId, 'active')
        await remove(tail)
        assert.equal((await repository.getEntryById(tail))?.status, 'archived')
        assert.equal((await repository.getEntryById(original.id))?.status, 'active')
        await assert.rejects(messages('000000000001'), /不存在/)
    })
})

for (const indexFailure of [false, true]) {
    it(`splits Dream memories with provenance (index failure: ${indexFailure})`, async () => {
        await withLivingMemoryRepository(async (ctx, repository) => {
            const sink = new MemoryIndexSinkStub()
            if (indexFailure)
                sink.applyError = new Error('injected index failure')
            const mutations = new LivingMemoryMutationService(
                repository,
                sink,
                createLoggerStub().logger
            )
            await repository.registerMissingPresetSpeakers(presetId, [
                { speakerKey: 'alice', speakerLabel: 'Alice' },
                { speakerKey: 'bob', speakerLabel: 'Bob' }
            ])
            const [source] = await repository.appendMemories(
                scope,
                [
                    {
                        role: 'user',
                        content: 'Alice喜欢茶，Bob喜欢咖啡。',
                        transcriptLines: ['Alice喜欢茶，Bob喜欢咖啡。']
                    }
                ],
                [
                    {
                        ...sessionMemory,
                        type: 'fact',
                        speakerKeys: ['alice', 'bob']
                    }
                ]
            )
            const { state, tools, invoke } = await createSession(
                repository,
                mutations,
                [[source]]
            )
            assert.deepEqual(
                tools.map((tool) => tool.name).sort(),
                [
                    'living_memory_update_memory',
                    'living_memory_merge_memories',
                    'living_memory_split_memory',
                    'living_memory_delete_memory',
                    'living_memory_checked_memory'
                ].sort()
            )
            advanceDreamBatch(state)
            const result = await invoke('split_memory', {
                sourceMemoryId: source.id.slice(-12),
                memories: [
                    {
                        ...sessionMemory,
                        content: 'Alice喜欢茶。',
                        keywords: ['茶'],
                        speakerLabels: ['Alice']
                    },
                    {
                        ...sessionMemory,
                        content: 'Bob喜欢咖啡。',
                        keywords: ['咖啡'],
                        speakerLabels: ['Bob']
                    }
                ]
            })
            assert.equal(result.memoryIds.length, 2)
            assert.equal(result.archivedMemoryId, source.id.slice(-12))
            assert.equal(result.warnings.length, indexFailure ? 1 : 0)
            const children = (await repository.listEntriesByPreset(presetId)).filter(entry => entry.id !== source.id)
            assert.deepEqual(children.map(child => child.id.slice(-12)).sort(), [...result.memoryIds].sort())
            for (const child of children) {
                assert.equal(child.status, 'active')
                assert.deepEqual(child.sourceOrigins, source.sourceOrigins)
                assert.equal(child.sourceConversationId, scope.conversationId)
                assert.equal(state.availableMemoryIds.has(child.id), true)
                assert.equal(state.targetMemoryIds.has(child.id), false)
            }
            assert.deepEqual(
                children.map((entry) => entry.speakerKeys[0]).sort(),
                ['alice', 'bob']
            )
            const links = await ctx.database.get(
                'living_memory_entry_speaker',
                { presetId }
            )
            assert.equal(links.length, 2)
            assert.ok(
                links.every((link) => children.some(child => child.id === link.memoryId))
            )
            assert.equal(
                (await repository.getEntryById(source.id))?.status,
                'archived'
            )
            assert.equal(getDreamCoverage(state).processedCount, 1)
            assert.deepEqual(pendingDreamMemoryIds(state), [])
            assert.equal(state.stats.split, 1)
            assert.equal(state.stats.archived, 1)
            if (indexFailure) {
                assert.equal(sink.reconciledPresets.length, 1)
            } else {
                assert.deepEqual(
                    sink.mutations[0].upserts.map((item) => item.vectorAction),
                    ['replace', 'replace', 'preserve']
                )
            }
            await invoke('update_memory', {
                memoryId: result.memoryIds[0],
                memory: sessionMemory
            })
            assert.equal(getDreamCoverage(state).processedCount, 1)
        })
    })
}

it('rolls back split entries, source archival and speaker links together', async () => {
    await withLivingMemoryRepository(async (ctx, repository) => {
        const source = await repository.createMemory(
            scope,
            { type: 'fact', content: '两个主题' },
            ['alice']
        )
        const beforeLinks = await ctx.database.get(
            'living_memory_entry_speaker',
            { presetId }
        )
        const transact = ctx.database.transact.bind(ctx.database)
        // 只让下一次事务在提交回调后抛错，验证事务回滚；测试结束恢复原实现。
        const originalTransact = ctx.database.transact
        let injected = true
        ctx.database.transact = (async (callback: never) => {
            if (injected) {
                injected = false
                return await transact(async (database) => {
                    await callback(database)
                    throw new Error('injected transaction failure')
                })
            }
            return await originalTransact(callback)
        }) as typeof ctx.database.transact
        try {
            await assert.rejects(
                repository.splitMemory(presetId, source.id, [
                    {
                        ...sessionMemory,
                        type: 'fact',
                        speakerKeys: ['alice']
                    },
                    { ...sessionMemory, type: 'fact', speakerKeys: [] }
                ]),
                /injected transaction failure/
            )
        } finally {
            ctx.database.transact = originalTransact
        }
        assert.deepEqual(await repository.listEntriesByPreset(presetId), [
            source
        ])
        assert.deepEqual(
            await ctx.database.get('living_memory_entry_speaker', { presetId }),
            beforeLinks
        )
    })
})

it('tracks Dream coverage across batches and reuses merged memories', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )
        const entries: MemoryEntryRecord[] = []
        for (let index = 0; index < 6; index++) {
            entries.push(
                await repository.createMemory(scope, {
                    type: 'fact',
                    content: `memory-${index}`
                })
            )
        }
        const [a, b, c, d, e, outside] = entries
        const { state, tools, invoke } = await createSession(repository, mutations, [
            [a, b, c],
            [d, e]
        ])
        assert.equal(tools.length, 5)
        assert.equal(
            tools.some((tool) => tool.name === 'living_memory_create_memory'),
            false
        )
        advanceDreamBatch(state)
        await assert.rejects(invoke('delete_memory', { memoryId: outside.id.slice(-12) }), /已提供的记忆 ID/)
        assert.equal(state.availableMemoryIds.has(outside.id), false)
        assert.equal(getDreamCoverage(state).processedCount, 0)
        const merged = await invoke('merge_memories', {
            sourceMemoryIds: [a.id, b.id],
            memory: sessionMemory
        })
        assert.deepEqual(pendingDreamMemoryIds(state), [c.id])
        recordSkippedDreamBatch(state, 'round-limit')
        assert.deepEqual(
            advanceDreamBatch(state)?.entries.map((entry) => entry.id),
            [d.id, e.id]
        )
        await invoke('checked_memory', {
            memoryIds: [c.id, d.id],
            reason: '复查后无需修改'
        })
        await invoke('update_memory', {
            memoryId: merged.memoryId,
            memory: sessionMemory
        })
        await invoke('delete_memory', { memoryId: e.id })
        assert.equal(advanceDreamBatch(state), undefined)
        assert.deepEqual(getDreamCoverage(state), {
            targetCount: 5,
            processedCount: 5,
            unprocessedMemoryIds: []
        })
        assert.deepEqual(state.skippedBatches[0].memoryIds, [c.id])
        assert.equal(state.stats.merged, 1)
        assert.equal(state.stats.archived, 3)
    })
})

it('retains successful Dream coverage when only index synchronization fails', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        sink.applyError = new Error('injected index failure')
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )
        const entries: MemoryEntryRecord[] = []
        for (let index = 0; index < 5; index++) {
            entries.push(
                await repository.createMemory(scope, {
                    type: 'fact',
                    content: `memory-${index}`
                })
            )
        }
        const [updated, a, b, checked, archived] = entries
        const { state, invoke } = await createSession(repository, mutations, [
            entries
        ])
        advanceDreamBatch(state)
        const outputs = [
            await invoke('update_memory', {
                memoryId: updated.id,
                memory: sessionMemory
            }),
            await invoke('merge_memories', {
                sourceMemoryIds: [a.id, b.id],
                memory: sessionMemory
            }),
            await invoke('checked_memory', {
                memoryIds: [checked.id],
                reason: '内容完整'
            }),
            await invoke('delete_memory', { memoryId: archived.id })
        ]
        assert.deepEqual(
            outputs.map((output) => output.warnings.length),
            [1, 1, 0, 1]
        )
        assert.equal(getDreamCoverage(state).processedCount, 5)
        const stored = await repository.listEntriesByPreset(presetId)
        assert.equal(stored.length, 6)
        assert.equal(
            stored.filter((entry) => entry.status === 'archived').length,
            3
        )
        const merged = stored.find(entry => entry.id.slice(-12) === outputs[1].memoryId)!
        assert.ok(state.availableMemoryIds.has(merged.id))
        await flushBackgroundTasks()
        assert.equal(sink.reconciledPresets.length, 3)
    })
})

it('rejects unavailable or stale Dream targets before recording successful coverage', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )
        const active = await repository.createMemory(scope, {
            type: 'fact',
            content: 'active'
        })
        const stale = await repository.createMemory(scope, {
            type: 'fact',
            content: 'stale'
        })
        const { state, invoke } = await createSession(repository, mutations, [
            [active, stale]
        ])
        advanceDreamBatch(state)
        await repository.archiveActiveEntries(presetId, [stale.id])
        await assert.rejects(
            invoke('checked_memory', {
                memoryIds: [active.id, stale.id],
                reason: '内容完整'
            })
        )
        await assert.rejects(
            invoke('merge_memories', {
                sourceMemoryIds: [active.id, stale.id],
                memory: sessionMemory
            })
        )
        await assert.rejects(
            invoke('update_memory', {
                memoryId: stale.id,
                memory: sessionMemory
            })
        )
        await assert.rejects(invoke('delete_memory', { memoryId: stale.id }))
        await assert.rejects(
            invoke('split_memory', {
                sourceMemoryId: 'not-provided',
                memories: [sessionMemory, sessionMemory]
            })
        )
        await assert.rejects(
            invoke('checked_memory', {
                memoryIds: [active.id, 'not-provided'],
                reason: '内容完整'
            })
        )
        assert.equal((await repository.listEntriesByPreset(presetId)).length, 2)
        assert.equal(getDreamCoverage(state).processedCount, 0)
        assert.equal(
            (await repository.getEntryById(active.id))?.status,
            'active'
        )
        assert.deepEqual(sink.mutations, [])
        await invoke('checked_memory', {
            memoryIds: [active.id, active.id],
            reason: '内容完整'
        })
        await invoke('update_memory', {
            memoryId: active.id,
            memory: sessionMemory
        })
        assert.equal(getDreamCoverage(state).processedCount, 1)
        assert.equal(state.stats.kept, 1)
        assert.equal(state.stats.updated, 1)
    })
})

it('writes create, update, and delete facts through to the vector index', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )
        const memory = await mutations.createMemory(scope, {
            type: 'fact',
            content: 'original content',
            summary: 'original summary'
        })

        await mutations.updateMemory(memory.id, {
            summary: 'updated summary'
        })
        await mutations.updateMemory(memory.id, {
            content: 'updated content', status: 'archived'
        })
        await mutations.deleteMemories(memory.presetId, [memory.id])

        assert.equal(sink.mutations.length, 4)
        assert.equal(sink.mutations[0].upserts[0].vectorAction, 'replace')
        assert.equal(sink.mutations[1].upserts[0].vectorAction, 'preserve')
        assert.equal(sink.mutations[2].upserts[0].vectorAction, 'replace')
        assert.deepEqual(sink.mutations[3].deletes, [
            { id: memory.id, presetId }
        ])
        assert.equal(await repository.getEntryById(memory.id), undefined)
    })
})

it('reports committed facts when vector synchronization fails', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        sink.applyError = new Error('injected index failure')
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )

        let failure: unknown
        try {
            await mutations.createMemory(scope, {
                type: 'fact',
                content: 'committed content'
            })
        } catch (error) {
            failure = error
        }

        assert.ok(failure instanceof LivingMemoryFactsCommittedError)
        assert.equal(failure.factsCommitted, true)
        assert.match(failure.message, /injected index failure/u)
        assert.equal((await repository.listEntriesByPreset(presetId)).length, 1)
    })
})

it('preserves vectors for metadata updates and clears the preset index', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )
        const memory = await mutations.createMemory(scope, {
            type: 'fact',
            content: 'memory to update'
        })

        await mutations.updateMemory(memory.id, { importance: 0.9 })
        await mutations.clearPresetData(presetId)

        assert.equal(sink.mutations[1].upserts[0].vectorAction, 'preserve')
        assert.deepEqual(sink.clearedPresets, [presetId])
        assert.deepEqual(await repository.listEntriesByPreset(presetId), [])
    })
})

it('synchronizes a Dream merge as one vector index mutation', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )
        const target = await repository.createMemory(scope, {
            type: 'fact',
            content: 'target'
        })
        const source = await repository.createMemory(scope, {
            type: 'fact',
            content: 'source'
        })

        const result = await mutations.mergeActiveMemories(
            presetId,
            [target.id, source.id],
            {
                speakerKeys: [],
                type: 'fact',
                content: 'merged content',
                keywords: ['merged'],
                summary: 'merged summary',
                sentiment: 'neutral',
                importance: 0.8
            }
        )

        assert.equal(sink.mutations.length, 1)
        assert.deepEqual(
            sink.mutations[0].upserts.map((upsert) => ({
                id: upsert.document.id,
                action: upsert.vectorAction,
                status: upsert.document.status
            })),
            [
                { id: result.memory.id, action: 'replace', status: 'active' },
                { id: target.id, action: 'preserve', status: 'archived' },
                { id: source.id, action: 'preserve', status: 'archived' }
            ]
        )
    })
})

it('queues preset reconciliation after import without applying mutations', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )
        const data: LivingMemoryPresetExport = {
            version: 2,
            exportedAt: '2026-08-08T00:00:00.000Z',
            sourcePresetId: 'source-preset',
            entries: [],
            userProfiles: [],
            presetSpeakers: []
        }

        const result = await mutations.importPreset(presetId, data)

        assert.deepEqual(sink.reconciledPresets, [`${presetId}:preset import`])
        assert.deepEqual(sink.mutations, [])
        assert.equal(result.indexJobId, 'index-job')
    })
})

it('rejects memory creation before committing facts when the index is not ready', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        sink.presetReady = false
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )

        await assert.rejects(
            mutations.createMemory(scope, {
                type: 'fact',
                content: 'should not be committed'
            }),
            (error: unknown) => {
                assert.ok(error instanceof LivingMemoryVectorIndexError)
                assert.match(error.message, /not ready/u)
                return true
            }
        )

        assert.equal((await repository.listEntriesByPreset(presetId)).length, 0)
        assert.deepEqual(sink.mutations, [])
        assert.deepEqual(sink.reconciledPresets, [])
    })
})

it('schedules one background reconciliation after a failed index sync', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        sink.applyError = new Error('injected index failure')
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )

        await assert.rejects(
            mutations.createMemory(scope, {
                type: 'fact',
                content: 'committed content'
            }),
            LivingMemoryFactsCommittedError
        )
        await flushBackgroundTasks()

        assert.deepEqual(sink.reconciledPresets, [
            `${presetId}:mutation index sync failure`
        ])
    })
})

it('keeps the committed-facts failure when the scheduled reconciliation rejects', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        sink.applyError = new Error('injected index failure')
        sink.reconcileError = new Error('injected reconcile failure')
        const { warns, logger } = createLoggerStub()
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            logger
        )

        await assert.rejects(
            mutations.createMemory(scope, {
                type: 'fact',
                content: 'committed content'
            }),
            LivingMemoryFactsCommittedError
        )
        await flushBackgroundTasks()

        assert.deepEqual(warns, ['索引对账调度失败'])
        assert.equal((await repository.listEntriesByPreset(presetId)).length, 1)
    })
})

it('deletes memories in one batch and synchronizes the vector index', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )
        const created = []
        for (let index = 0; index < 3; index++) {
            created.push(
                await repository.createMemory(scope, {
                    type: 'fact',
                    content: `bulk-${index}`,
                    status: 'archived'
                })
            )
        }

        const result = await mutations.deleteMemories(
            presetId,
            created.map((memory) => memory.id)
        )

        assert.deepEqual(result, { deleted: 3 })
        assert.equal(sink.mutations.length, 1)
        // getEntriesByPresetAndIds 的返回顺序不保证与传入一致，按 id 排序后比较。
        assert.deepEqual(
            [...sink.mutations[0].deletes]
                .map((entry) => entry.id)
                .sort((left, right) => left.localeCompare(right)),
            created
                .map((memory) => memory.id)
                .sort((left, right) => left.localeCompare(right))
        )
        assert.deepEqual(await repository.listEntriesByPreset(presetId), [])
    })
})

it('skips duplicate, missing, and cross-preset ids in bulk deletion', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )
        const own = await repository.createMemory(scope, {
            type: 'fact',
            content: 'own preset',
            status: 'archived'
        })
        const foreign = await repository.createMemory(
            { presetId: 'preset-other', conversationId: 'conversation-1' },
            { type: 'fact', content: 'foreign preset', status: 'archived' }
        )

        const result = await mutations.deleteMemories(presetId, [
            own.id,
            own.id,
            'missing-id',
            foreign.id
        ])

        assert.deepEqual(result, { deleted: 1 })
        assert.deepEqual(sink.mutations[0].deletes, [{ id: own.id, presetId }])
        assert.deepEqual(await repository.listEntriesByPreset(presetId), [])
        assert.equal(
            (await repository.listEntriesByPreset('preset-other')).length,
            1
        )
    })
})

it('returns zero deletions without side effects for an empty id list', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )

        const result = await mutations.deleteMemories(presetId, [])

        assert.deepEqual(result, { deleted: 0 })
        assert.deepEqual(sink.mutations, [])
    })
})

it('splits bulk deletions into fixed-size batches', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )
        const total = MEMORY_DELETE_BATCH_SIZE + 3
        const extracted = Array.from({ length: total }, (_, index) => ({
            type: 'fact' as const,
            content: `batched-${index}`,
            status: 'archived' as const,
            keywords: [],
            summary: '',
            sentiment: '',
            importance: 0.5,
            speakerKeys: []
        }))
        const created = await Promise.all(
            extracted.map((memory) =>
                repository.createMemory(scope, memory, memory.speakerKeys)
            )
        )

        const result = await mutations.deleteMemories(
            presetId,
            created.map((memory) => memory.id)
        )

        assert.deepEqual(result, { deleted: total })
        assert.equal(sink.mutations.length, 2)
        assert.equal(sink.mutations[0].deletes.length, MEMORY_DELETE_BATCH_SIZE)
        assert.equal(sink.mutations[1].deletes.length, 3)
        assert.deepEqual(await repository.listEntriesByPreset(presetId), [])
    })
})

it('registers caller-provided speaker keys before create and update commit', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )
        const memory = await mutations.createMemory(
            scope,
            { type: 'fact', content: 'manual memory' },
            ['caller-key']
        )
        assert.equal(
            (await repository.listPresetSpeakers(presetId)).find(
                (speaker) => speaker.speakerKey === 'caller-key'
            )?.speakerLabel,
            'user:caller-k'
        )

        await mutations.updateMemory(memory.id, {
            speakerKeys: ['patched-key']
        })
        assert.equal(
            (await repository.listPresetSpeakers(presetId)).find(
                (speaker) => speaker.speakerKey === 'patched-key'
            )?.speakerLabel,
            'user:patched-'
        )
    })
})

it('registers scope-derived default speaker keys on create', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )
        await mutations.createMemory(
            { ...scope, platform: 'onebot', userId: 'user-9' },
            { type: 'fact', content: 'scope attributed memory' }
        )
        const derivedKey = createSpeakerKey('onebot', 'user-9')
        assert.equal(
            (await repository.listPresetSpeakers(presetId)).find(
                (speaker) => speaker.speakerKey === derivedKey
            )?.speakerLabel,
            createSyntheticSpeakerLabel(derivedKey)
        )
    })
})

it('backfills registry rows for active memory keys missing rows on Dream coverage', async () => {
    // issue #6 回归：历史记忆键缺注册行时 Dream 渲染会崩，coverage 在
    // 预设级队列内重读活跃键并以合成标签补齐缺失行。
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )
        await repository.createMemory(
            scope,
            {
                type: 'fact',
                content: 'memory without registry row',
                keywords: [],
                summary: '',
                sentiment: '',
                importance: 0.5
            },
            ['orphan-key']
        )

        const speakers = await mutations.ensurePresetSpeakersCoverage(presetId)

        assert.equal(
            speakers.find((speaker) => speaker.speakerKey === 'orphan-key')
                ?.speakerLabel,
            createSyntheticSpeakerLabel('orphan-key')
        )
        assert.equal(
            (await mutations.ensurePresetSpeakersCoverage(presetId)).filter(
                (speaker) => speaker.speakerKey === 'orphan-key'
            ).length,
            1
        )
    })
})

it('returns extracted memories after index failure so extraction can advance once', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        sink.applyError = new Error('embedding unavailable')
        const { logger } = createLoggerStub()
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            logger
        )
        const saved = await mutations.appendExtractedMemories(
            scope,
            [
                {
                    role: 'user',
                    content: 'new fact',
                    transcriptLines: ['Alice说：new fact']
                }
            ],
            [
                {
                    type: 'fact',
                    content: 'new fact',
                    keywords: ['fact'],
                    summary: 'new fact',
                    sentiment: 'neutral',
                    importance: 0.5,
                    speakerKeys: []
                }
            ],
            []
        )
        assert.equal(saved.memories.length, 1)
        assert.equal(saved.warnings.length, 1)
        assert.equal((await repository.listEntriesByPreset(presetId)).length, 1)
        assert.equal(sink.reconciledPresets.length, 1)
    })
})
