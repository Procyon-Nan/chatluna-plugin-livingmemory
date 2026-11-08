import assert from 'node:assert/strict'
import type { Context } from 'cordis'
import Routing from '@chatluna/routing'
import { loadMemorySourceMessages } from '../src/service/app/query_projections.ts'
import { contextMemoryFields, renderMemoriesForModel, renderMemorySourceMessagesForModel } from '../src/service/prompts/memory_entries.ts'
import { resolveTranscriptOrigin } from '../src/service/transcript/origin_context.ts'
import { routeIdOf, type RouteIdentity } from '@chatluna/satori'
import { LivingMemoryChatHistory } from '../src/service/chat_history.ts'
import { historyMessage } from './chat-history-test-utils.ts'
import type { Schema } from '@chatluna/schema'
import type { LivingMemoryEntriesSnapshot } from '../src/contracts/webui.ts'
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
        action: (name: string, options: { input: Schema }, handler: (...args: any[]) => unknown) => {
            actions.set(name, (input, action) => handler(options.input.parse(input), action))
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
        })) as LivingMemoryEntriesSnapshot

        assert.equal(snapshot.total, 2)
        assert.equal(snapshot.facets.statuses.active, 1)
        assert.equal(snapshot.facets.statuses.archived, 1)
        assert.equal(snapshot.entries.length, 2)
    })
})

it('creates the first memory in a preset and reads edited fields back from the list', async () => {
    await withWebUI(async (_ctx, _repository, ui) => {
        const presetId = 'new-preset'
        const memory = {
            type: 'fact', status: 'archived',
            content: '周五聚餐', summary: '聚餐安排', sentiment: '期待',
            importance: 0, keywords: ['晚餐'], speakerKeys: ['alice']
        }
        const { id } = await ui.call('livingmemory.create', { presetId, ...memory }) as { id: string }
        const read = async () => (await ui.read('livingmemory.entries', {
            presetId, status: 'all'
        }) as LivingMemoryEntriesSnapshot).entries[0]

        assert.partialDeepStrictEqual(await read(), {
            ...memory, id, presetId, sourceLabel: null
        })
        await ui.call('livingmemory.update', { id, sentiment: '开心', importance: 0.85 })
        assert.partialDeepStrictEqual(await read(), { ...memory, sentiment: '开心', importance: 0.85 })

        const revision = {
            type: 'plan', status: 'active', content: '改到周六',
            summary: '更改日期', keywords: [], sentiment: null, importance: null, speakerKeys: []
        }
        await ui.call('livingmemory.update', { id, ...revision })
        const edited = await read()
        assert.partialDeepStrictEqual(edited, revision)
        assert.deepEqual(edited?.keywords, [])
        assert.deepEqual(edited?.speakerKeys, [])
    })
})

it('offers registered speakers in the selected preset even without a profile', async () => {
    await withWebUI(async (_ctx, repository, ui) => {
        const alice = { speakerKey: 'alice', speakerLabel: '爱丽丝' }
        await repository.upsertPresetSpeaker({ presetId: 'preset-1', ...alice })
        await repository.upsertPresetSpeaker({ presetId: 'preset-2', speakerKey: 'bob', speakerLabel: '鲍勃' })

        assert.deepEqual(await ui.read('livingmemory.speakers', { presetId: 'preset-1' }), [alice])
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

it('selects all matching rows and deletes only the requested preset’s memories', async () => {
    await withWebUI(async (ctx, repository, ui) => {
        const active = await seed(ctx, repository, '周五聚餐')
        const archived = await seed(ctx, repository, '周六聚餐')
        const kept = await seed(ctx, repository, '读书')
        const other = await repository.createMemory(
            { presetId: 'other', conversationId: '' }, { type: 'fact', content: '异地聚餐' }
        )
        await ui.call('livingmemory.update', { id: archived.id, status: 'archived' })
        const filter = { presetId: 'preset-1', keyword: '聚餐', status: 'all' }
        const page = await ui.read('livingmemory.entries', { ...filter, pageSize: 1 }) as LivingMemoryEntriesSnapshot
        assert.equal(page.entries.length, 1)
        assert.equal(page.total, 2)
        const ids = await ui.call('livingmemory.listMemoryIds', filter) as string[]
        assert.deepEqual(new Set(ids), new Set([active.id, archived.id]))
        const result = await ui.call('livingmemory.deleteMemories', {
            presetId: filter.presetId, ids: [...ids, other.id, active.id]
        })
        assert.deepEqual(result, { deleted: 2 })
        assert.deepEqual((await repository.listEntriesByPreset(filter.presetId)).map(item => item.id), [kept.id])
        assert.ok(await repository.getEntryById(other.id))
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

it('uses the source conversation for the management list, model tools and exports', async () => {
    await withWebUI(async (ctx, repository, ui) => {
        await ctx.plugin(Routing)
        await ctx.database.prepared()
        const presetId = 'preset-1'
        for (const [kind, name, label] of [
            ['guild', '读书群', '「读书群」（群聊 ID：42）'],
            ['user', '小林', '「小林」（用户 ID：42）']
        ] as const) {
            const conversationId = routeIdOf({ platform: 'onebot', selfId: 'bot', isDirect: kind === 'user', userId: '42', channelId: '42' })
            const peer = `onebot:bot:${kind}:42`
            await ctx.database.create('chatluna_conversations', { key: conversationId, peer, headSessionId: kind })
            await ctx.database.create('chatluna_peers', { key: peer, platform: 'onebot', selfId: 'bot', kind, id: '42', name })
            const entry = await repository.createMemory({ presetId, conversationId }, { type: 'fact', content: name })
            await ctx.database.set('living_memory_entry', { id: entry.id }, { sourceLabel: '文件中的名称' })

            const page = await ui.read('livingmemory.entries', { presetId }) as LivingMemoryEntriesSnapshot
            assert.equal(page.entries.find(item => item.id === entry.id)?.sourceLabel, label)
            const hits = await repository.getSearchEntriesByPresetAndIds(presetId, [entry.id])
            assert.ok(renderMemoriesForModel(hits, { fields: contextMemoryFields }).split('\n').includes(`source=${label}`))
            const messages = await loadMemorySourceMessages(repository, presetId, entry.id)
            assert.ok(renderMemorySourceMessagesForModel(messages!).split('\n').includes(`source=${label}`))
            const exportFile = await repository.exportPresetData(presetId)
            assert.ok(exportFile.version === 5)
            assert.equal(exportFile.entries.find(item => item.id === entry.id)?.sourceLabel, label)
            await ctx.database.set('chatluna_peers', { key: peer }, { name: '42' })
            await ctx.database.set('living_memory_entry', { id: entry.id }, { sourceLabel: label })
            assert.equal((await repository.getEntriesWithSources(presetId, [entry.id]))[0].sourceLabel, label)
        }
    })
})

it('extracts from the observed channel and keeps its source across shared routes, retries and transfers', async () => {
    await withWebUI(async (ctx, repository, ui) => {
        await ctx.plugin(Routing)
        await ctx.database.prepared()
        const scope = { presetId: 'scope', sessionId: 'session', conversationId: 'custom:shared' }
        const identity = (isDirect: boolean, id: string): RouteIdentity => ({
            platform: 'onebot', selfId: 'bot', isDirect, guildId: isDirect ? undefined : id, channelId: id,
            userId: isDirect ? id : 'someone'
        })
        const first = identity(false, 'A')
        const actual = identity(false, 'B')
        const latest = identity(true, 'C')
        const peerKey = (id: string) => `onebot:bot:guild:${id}`
        await ctx.database.create('chatluna_conversations', { key: scope.conversationId, peer: peerKey('A') })
        for (const [id, name] of [['A', '甲群'], ['B', '乙群']]) {
            await ctx.database.create('chatluna_peers', { key: peerKey(id), platform: 'onebot', selfId: 'bot', kind: 'guild', id, name })
        }

        let channel = actual
        const rows = [historyMessage(1, '乙群中的聊天', { routeId: routeIdOf(actual), cid: 'onebot:B' })]
        const history = new LivingMemoryChatHistory({
            recentOfConversation: (_key, limit) => rows.slice(-limit),
            identityOfConversation: () => latest,
            channelOf: () => ({ identity: channel, routeId: routeIdOf(channel) })
        })
        const batch = await history.after(scope, -1)
        channel = first
        const origin = await resolveTranscriptOrigin(ctx, batch)
        assert.equal(origin.sourceLabel, '「乙群」（群聊 ID：B）')
        assert.ok(origin.header.includes(origin.sourceLabel!))
        assert.equal((await resolveTranscriptOrigin(ctx, await history.after(scope, -1))).sourceLabel, null)

        const [entry] = await repository.appendMemories(scope, [{ role: 'user', content: '乙群中的聊天', transcriptLines: ['乙群中的聊天'] }], [{
            type: 'fact', content: '乙群中的聊天', summary: '摘要', keywords: [], sentiment: '平静', importance: 0.5, speakerKeys: []
        }], origin.sourceLabel)
        const page = await ui.read('livingmemory.entries', { presetId: scope.presetId }) as LivingMemoryEntriesSnapshot
        assert.equal(page.entries[0].sourceLabel, origin.sourceLabel)
        assert.equal((await repository.getSearchEntriesByPresetAndIds(scope.presetId, [entry.id]))[0].sourceLabel, origin.sourceLabel)
        const file = await repository.exportPresetData(scope.presetId)
        assert.ok(file.version === 5)
        assert.equal(file.entries[0].sourceLabel, origin.sourceLabel)
        await repository.importPresetData('import', file)
        assert.equal((await repository.listEntriesByPreset('import'))[0].sourceLabel, origin.sourceLabel)

        // 同一私聊后来只报了用户号，不能盖掉之前消息中的昵称或目录里的昵称。
        channel = latest
        const dm = (i: number, name: string) => historyMessage(i, '私聊', { cid: 'onebot:C', routeId: routeIdOf(latest), userId: 'C', name })
        rows.splice(0, rows.length, dm(2, '小林'), dm(3, 'C'))
        assert.equal((await resolveTranscriptOrigin(ctx, await history.after(scope, -1))).sourceLabel, '「小林」（用户 ID：C）')
        await ctx.database.create('chatluna_peers', { key: 'onebot:bot:user:C', platform: 'onebot', selfId: 'bot', kind: 'user', id: 'C', name: '联系人小林' })
        rows.shift()
        assert.equal((await resolveTranscriptOrigin(ctx, await history.after(scope, -1))).sourceLabel, '「联系人小林」（用户 ID：C）')
    })
})
