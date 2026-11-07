import assert from 'node:assert/strict'
import type { Context } from 'cordis'
import { withLivingMemoryRepository } from './persistence-test-utils.ts'
import { livingMemoryWebUI } from '../src/service/app/webui.ts'
import { LivingMemoryAdminService } from '../src/service/app/admin_service.ts'
import type { LivingMemoryAdminDeps } from '../src/service/app/admin_service.ts'
import { LivingMemoryMutationService } from '../src/service/app/mutation_service.ts'
import { createCapturedLogger } from './workflow-test-utils.ts'
import type { LivingMemoryRepository } from '../src/service/persistence/repository.ts'
import { DEFAULT_CONFIG } from '../src/service.ts'
import type { MemoryVectorIndexStatus } from '../src/contracts/vector_index.ts'

/**
 * 只实现被测状态与动作用到的 `chatluna_webui` 接口：注册时收集，读取时按
 * key 取参返回。真实服务的权限校验与推送由框架提供，不在这里重复。
 */
const createWebUI = () => {
    const states = new Map<string, (params: any) => unknown>()
    const refresh = new Map<string, readonly string[]>()
    const actions = new Map<string, (...args: any[]) => unknown>()
    const events: string[] = []

    const chatluna_webui = {
        state: (key: string, options: { get: (params: any) => unknown; refreshOn: readonly string[] }) => {
            states.set(key, options.get)
            refresh.set(key, options.refreshOn)
            return () => {}
        },
        action: (name: string, _options: unknown, handler: (...args: any[]) => unknown) => {
            actions.set(name, handler)
            return () => {}
        }
    }

    return {
        chatluna_webui,
        permissions: { levelOf: async () => Number.POSITIVE_INFINITY },
        emit: (event: string) => events.push(event),
        states,
        refresh,
        actions,
        events,
        read: async (key: string, params?: unknown) => {
            const get = states.get(key)
            assert.ok(get !== undefined, `state ${key} is not registered`)
            return await get(params)
        },
        call: async (name: string, input: unknown) => {
            const handler = actions.get(name)
            assert.ok(handler !== undefined, `action ${name} is not registered`)
            return await handler(input, { user: 'test' })
        }
    }
}

const adminOf = (repository: LivingMemoryRepository) =>
    new LivingMemoryAdminService({
        config: DEFAULT_CONFIG,
        repository,
        mutations: new LivingMemoryMutationService(
            repository,
            {
                applyMutation: async () => {},
                clearPreset: async () => {},
                reconcilePreset: async () => {},
                waitForMaintenance: async () => {},
                assertPresetReady: () => {},
                startRebuild: () => {}
            } as never,
            createCapturedLogger().logger
        ),
        listPresetIds: async () => ['preset-1'],
        cleanupConversation: async () => {},
        vectorIndex: {
            getStatus: (): MemoryVectorIndexStatus => ({
                state: 'idle',
                manifest: null,
                presets: [],
                currentJobId: null,
                lastError: null
            })
        }
    } as unknown as LivingMemoryAdminDeps)

const withWebUI = async (
    callback: (
        ctx: Context,
        repository: LivingMemoryRepository,
        ui: ReturnType<typeof createWebUI>
    ) => Promise<void>
) => {
    await withLivingMemoryRepository(async (ctx, repository) => {
        const ui = createWebUI()
        livingMemoryWebUI(
            {
                effect: ctx.effect.bind(ctx),
                chatluna_webui: ui.chatluna_webui,
                permissions: ui.permissions,
                emit: ui.emit
            } as never,
            {
                admin: adminOf(repository),
                repository,
                logger: { summary: () => {} } as never
            }
        )
        await callback(ctx, repository, ui)
    })
}

const seed = (
    ctx: Context,
    repository: LivingMemoryRepository,
    content: string,
    status: 'active' | 'archived' = 'active'
) =>
    repository.createMemory(
        { presetId: 'preset-1', conversationId: '' },
        { type: 'fact', content, status },
        []
    )

it('lists every preset once in the status snapshot', async () => {
    await withWebUI(async (_ctx, _repository, ui) => {
        const status = (await ui.read('livingmemory.status')) as {
            presets: string[]
        }
        assert.deepEqual(status.presets, ['preset-1'])
    })
})

it('projects entries with their facets and total', async () => {
    await withWebUI(async (ctx, repository, ui) => {
        await seed(ctx, repository, '第一条')
        await seed(ctx, repository, '第二条', 'archived')

        const snapshot = (await ui.read('livingmemory.entries', {
            presetId: 'preset-1',
            status: 'all'
        })) as {
            entries: { title: string | null }[]
            total: number
            facets: { statuses: Record<string, number> }
        }

        assert.equal(snapshot.total, 2)
        assert.equal(snapshot.facets.statuses.active, 1)
        assert.equal(snapshot.facets.statuses.archived, 1)
        assert.equal(snapshot.entries.length, 2)
    })
})

it('projects a profile with the memories it was built from', async () => {
    await withWebUI(async (ctx, repository, ui) => {
        const memory = await seed(ctx, repository, '用户喜欢喝咖啡')
        await repository.replaceUserProfile('preset-1', {
            speakerKey: 'speaker-1',
            speakerLabel: '小明',
            content: '喜欢咖啡',
            sourceMemoryIds: [memory.id]
        })

        const snapshot = (await ui.read('livingmemory.profiles', {
            presetId: 'preset-1'
        })) as {
            profiles: {
                speakerLabel: string
                sourceMemoryIds: string[]
                updatedAt: number
            }[]
            total: number
        }

        assert.equal(snapshot.total, 1)
        assert.equal(snapshot.profiles[0]?.speakerLabel, '小明')
        assert.deepEqual(snapshot.profiles[0]?.sourceMemoryIds, [memory.id])
        assert.equal(typeof snapshot.profiles[0]?.updatedAt, 'number')
    })
})

it('projects a snapshot row without its item payload', async () => {
    await withWebUI(async (ctx, repository, ui) => {
        await ctx.database.create('living_memory_snapshot', {
            id: 'snapshot-1',
            presetId: 'preset-1',
            conversationId: 'conversation-1',
            query: '用户喜欢什么',
            items: [{ finalText: '命中一条', toolCallSummary: {}, matchedMemories: [] }],
            createdAt: new Date('2026-11-05T00:00:00.000Z')
        })

        const snapshot = (await ui.read('livingmemory.snapshots', {
            presetId: 'preset-1'
        })) as {
            snapshots: { query: string; itemCount: number; createdAt: number }[]
        }

        assert.equal(snapshot.snapshots[0]?.query, '用户喜欢什么')
        assert.equal(snapshot.snapshots[0]?.itemCount, 1)
        assert.equal(
            snapshot.snapshots[0]?.createdAt,
            Date.parse('2026-11-05T00:00:00.000Z')
        )
    })
})

it('removes a snapshot and signals the page to refresh', async () => {
    await withWebUI(async (ctx, repository, ui) => {
        await ctx.database.create('living_memory_snapshot', {
            id: 'snapshot-1',
            presetId: 'preset-1',
            conversationId: 'conversation-1',
            query: 'query',
            items: [],
            createdAt: new Date()
        })
        assert.equal((await repository.listSnapshotsByPreset('preset-1')).length, 1)

        await ui.call('livingmemory.deleteSnapshot', { id: 'snapshot-1' })

        assert.deepEqual(await repository.listSnapshotsByPreset('preset-1'), [])
        assert.deepEqual(ui.events, ['livingmemory/change'])
    })
})

it('archives an entry by default and purges it when asked', async () => {
    await withWebUI(async (ctx, repository, ui) => {
        const memory = await seed(ctx, repository, '一条记忆')

        await ui.call('livingmemory.remove', { id: memory.id })
        assert.equal(
            (await repository.getEntryById(memory.id))?.status,
            'archived'
        )

        await ui.call('livingmemory.remove', { id: memory.id, purge: true })
        assert.equal(await repository.getEntryById(memory.id), undefined)
    })
})

it('overwrites a profile with the edited text', async () => {
    await withWebUI(async (ctx, repository, ui) => {
        await repository.replaceUserProfile('preset-1', {
            speakerKey: 'speaker-1',
            speakerLabel: '小明',
            content: '旧内容',
            sourceMemoryIds: []
        })
        const [profile] = await repository.listUserProfilesByPreset('preset-1')

        await ui.call('livingmemory.updateProfile', {
            id: profile!.id,
            content: '新内容'
        })

        const [updated] = await repository.listUserProfilesByPreset('preset-1')
        assert.equal(updated?.content, '新内容')
    })
})
it('refreshes the task list from its own repository and preserves partial Dream results', async () => {
    await withWebUI(async (_ctx, repository, ui) => {
        const job = await repository.createJob({ presetId: 'preset-1', conversationId: 'c' }, 'dream', 'manual')
        await repository.updateJob(job.id, { status: 'partial' })
        assert.deepEqual(ui.events, ['livingmemory/job-change', 'livingmemory/job-change'])
        assert.ok(ui.refresh.get('livingmemory.jobs')?.includes(ui.events[1]!))
        const rows = await ui.read('livingmemory.jobs', { presetId: 'preset-1' }) as { id: string; status: string }[]
        assert.deepEqual(rows.map(({ id, status }) => [id, status]), [[job.id, 'partial']])
    })
})
