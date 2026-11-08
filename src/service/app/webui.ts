import type { Context } from 'cordis'
import { Schema } from '@chatluna/schema'
import type {} from '../../contracts/webui_live.ts'
import { requireActionLevel } from '@chatluna/ui-server'
import type {} from '@chatluna/ui-server'
import type {} from '@chatluna/permission'
import { ApiError } from '@chatluna/server'
import type {} from '@chatluna/server'
import type { LivingMemoryAdminService } from './admin_service.ts'
import type { LivingMemoryRepository } from '../persistence/repository.ts'
import type { LivingMemoryLogger } from '../logging/logger.ts'
import type {
    LivingMemoryEntriesSnapshot,
    LivingMemoryEntryView,
    LivingMemoryJobView,
    LivingMemoryPersonaView,
    LivingMemoryProfilesSnapshot,
    LivingMemoryProfileView,
    LivingMemoryScopesSnapshot,
    LivingMemorySearchHitView,
    LivingMemorySnapshotsSnapshot,
    LivingMemorySnapshotView,
    LivingMemoryStatusSnapshot
} from '../../contracts/webui.ts'
import type {
    LivingMemoryPresetExport,
    MemoryEntryRecord,
    MemoryJobRecord,
    MemorySnapshotRecord,
    PresetPersonaCardInfo,
    UserProfileRecord
} from '../../contracts/memory.ts'
import type { MemoryListQuery } from '../../contracts/rpc.ts'
import { memoryEntryStatuses, memoryEntryTypes } from '../../contracts/memory.ts'

/** 管理页写操作要求的权限等级。 */
const WRITE_LEVEL = 4

const entryFields = {
    topic: Schema.string(),
    title: Schema.string(),
    summary: Schema.string(),
    sentiment: Schema.string(),
    importance: Schema.number().min(0).max(1),
    status: Schema.union(memoryEntryStatuses),
    // 省略数组时保留原值；显式传 [] 才清空。
    keywords: Schema.array(Schema.string()).optional().default(undefined),
    speakerKeys: Schema.array(Schema.string()).optional().default(undefined)
}

interface LivingMemoryWebUI {
    admin: LivingMemoryAdminService
    repository: LivingMemoryRepository
    logger: LivingMemoryLogger
}

/**
 * 管理页的数据面。只做两件事：把管理服务的返回值投影成界面视图，把写操作
 * 转给管理服务。
 */
export const livingMemoryWebUI = (ctx: Context, ui: LivingMemoryWebUI) => {
    ctx.effect(() => ui.repository.watchJobs(() => ctx.emit('livingmemory/job-change')))
    const refreshOn = ['livingmemory/change'] as const

    ctx.chatluna_webui.state('livingmemory.scopes', {
        get: async (): Promise<LivingMemoryScopesSnapshot> => {
            const presets = await ui.admin.listPresetIds()
            return {
                scopes: [
                    {
                        key: '*',
                        scope: { kind: 'global' },
                        name: '全部预设',
                        count: 0,
                        children: presets.map((presetId) => ({
                            key: presetId,
                            scope: { kind: 'preset', presetId },
                            name: presetId,
                            count: 0,
                            children: []
                        }))
                    }
                ]
            }
        },
        refreshOn
    })

    ctx.chatluna_webui.state('livingmemory.entries', {
        params: Schema.object({
            presetId: Schema.string().required(),
            page: Schema.natural(),
            pageSize: Schema.natural(),
            status: Schema.union(['active', 'archived', 'all'] as const),
            type: Schema.union(memoryEntryTypes),
            keyword: Schema.string(),
            speakerKey: Schema.string()
        }),
        get: async (
            params: { presetId: string } & Partial<MemoryListQuery>
        ): Promise<LivingMemoryEntriesSnapshot> => {
            const result = await ui.admin.listMemories(params)
            return {
                presetId: params.presetId,
                entries: result.items.map(toEntryView),
                facets: result.facets,
                total: result.total,
                page: result.page,
                pageSize: result.pageSize
            }
        },
        refreshOn
    })

    ctx.chatluna_webui.state('livingmemory.speakers', {
        params: Schema.object({ presetId: Schema.string().required() }),
        get: async ({ presetId }: { presetId: string }) => {
            const speakers = await ui.admin.listPresetSpeakers(presetId)
            return speakers.map(({ speakerKey, speakerLabel }) => ({ speakerKey, speakerLabel }))
        },
        refreshOn
    })

    ctx.chatluna_webui.state('livingmemory.jobs', {
        params: Schema.object({ presetId: Schema.string().required() }),
        get: async ({ presetId }: { presetId: string }): Promise<LivingMemoryJobView[]> => {
            const page = await ui.admin.listJobs({
                presetId,
                pageSize: 100
            })
            return page.items.map(toJobView)
        },
        refreshOn: ['livingmemory/job-change', ...refreshOn]
    })

    ctx.chatluna_webui.state('livingmemory.personas', {
        get: async (): Promise<LivingMemoryPersonaView[]> => {
            const cards = await ui.admin.listPresetPersonas()
            return cards.map(toPersonaView)
        },
        refreshOn
    })

    ctx.chatluna_webui.state('livingmemory.profiles', {
        params: Schema.object({
            presetId: Schema.string().required(),
            page: Schema.natural(),
            pageSize: Schema.natural()
        }),
        get: async ({
            presetId,
            page,
            pageSize
        }: {
            presetId: string
            page?: number
            pageSize?: number
        }): Promise<LivingMemoryProfilesSnapshot> => {
            const result = await ui.admin.listUserProfiles({
                presetId,
                ...(page === undefined ? {} : { page }),
                ...(pageSize === undefined ? {} : { pageSize })
            })
            return {
                presetId,
                profiles: result.items.map(toProfileView),
                total: result.total,
                page: result.page,
                pageSize: result.pageSize
            }
        },
        refreshOn
    })

    ctx.chatluna_webui.state('livingmemory.snapshots', {
        params: Schema.object({
            presetId: Schema.string().required(),
            page: Schema.natural(),
            pageSize: Schema.natural()
        }),
        get: async ({
            presetId,
            page,
            pageSize
        }: {
            presetId: string
            page?: number
            pageSize?: number
        }): Promise<LivingMemorySnapshotsSnapshot> => {
            const result = await ui.admin.listSnapshots({
                presetId,
                ...(page === undefined ? {} : { page }),
                ...(pageSize === undefined ? {} : { pageSize })
            })
            return {
                presetId,
                snapshots: result.items.map(toSnapshotView),
                total: result.total,
                page: result.page,
                pageSize: result.pageSize
            }
        },
        refreshOn
    })

    ctx.chatluna_webui.state('livingmemory.status', {
        get: async (): Promise<LivingMemoryStatusSnapshot> => ({
            ...ui.admin.status,
            presets: await ui.admin.listPresetIds()
        }),
        refreshOn
    })

    // ── 写操作 ────────────────────────────────────────────────────────

    ctx.chatluna_webui.action(
        'livingmemory.create',
        {
            input: Schema.object({
                presetId: Schema.string().required(),
                conversationId: Schema.string(),
                userId: Schema.string(),
                channelId: Schema.string(),
                type: Schema.union(memoryEntryTypes).required(),
                content: Schema.string().required(),
                ...entryFields
            }).role('strict')
        },
        async (input, action) => {
            await requireActionLevel(ctx, action, WRITE_LEVEL)
            const { presetId, conversationId, userId, channelId, speakerKeys, ...memory } = input
            const entry = await ui.admin.createMemory(
                { presetId, conversationId: conversationId ?? '', userId, channelId },
                memory,
                speakerKeys
            )
            notifyChanged(ctx)
            return { id: entry.id }
        }
    )

    ctx.chatluna_webui.action(
        'livingmemory.update',
        {
            input: Schema.object({
                id: Schema.string().required(),
                type: Schema.union(memoryEntryTypes),
                content: Schema.string(),
                ...entryFields
            }).role('strict')
        },
        async (input, action) => {
            await requireActionLevel(ctx, action, WRITE_LEVEL)
            const { id, ...patch } = input
            await ui.admin.updateMemory(id, patch)
            notifyChanged(ctx)
        }
    )

    ctx.chatluna_webui.action(
        'livingmemory.remove',
        {
            input: Schema.object({
                id: Schema.string().required(),
                purge: Schema.boolean()
            })
        },
        async ({ id, purge }, action) => {
            await requireActionLevel(ctx, action, WRITE_LEVEL)
            if (purge === true) await ui.admin.deleteMemory(id)
            else {
                const memory = await ui.admin.getMemory(id)
                if (memory === undefined) {
                    throw new ApiError('NOT_FOUND', `no such memory: ${id}`)
                }
                await ui.admin.archiveMemories(memory.presetId, [id])
            }
            notifyChanged(ctx)
        }
    )

    ctx.chatluna_webui.action(
        'livingmemory.search',
        {
            input: Schema.object({
                presetId: Schema.string().required(),
                searchTexts: Schema.array(Schema.string()).required(),
                searchKeywords: Schema.array(Schema.string()),
                memoryTypes: Schema.array(Schema.union(memoryEntryTypes)),
                memoryStatus: Schema.union(['active', 'archived', 'all'] as const)
            })
        },
        async ({
            presetId,
            searchTexts,
            searchKeywords,
            memoryTypes,
            memoryStatus
        }): Promise<{ hits: LivingMemorySearchHitView[] }> => {
            const hits = await ui.admin.searchMemoriesDetailed(presetId, {
                searchTexts,
                ...(searchKeywords === undefined ? {} : { searchKeywords }),
                memoryTypes: memoryTypes ?? ['all'],
                ...(memoryStatus === undefined ? {} : { memoryStatus })
            })
            return {
                hits: hits.map((hit) => ({
                    id: hit.id,
                    type: hit.type,
                    content: hit.content,
                    summary: hit.summary,
                    keywords: [...hit.keywords],
                    cosineScore: hit.cosineScore,
                    keywordMatchCount: hit.keywordMatchCount,
                    boostedScore: hit.boostedScore,
                    rerankScore: hit.rerankScore,
                    updatedAt: hit.updatedAt.getTime()
                }))
            }
        }
    )

    ctx.chatluna_webui.action(
        'livingmemory.dream',
        { input: Schema.object({ presetId: Schema.string().required() }) },
        async ({ presetId }, action) => {
            await requireActionLevel(ctx, action, WRITE_LEVEL)
            const result = await ui.admin.runDream(presetId)
            notifyChanged(ctx)
            return result
        }
    )

    ctx.chatluna_webui.action(
        'livingmemory.savePersona',
        {
            input: Schema.object({
                presetId: Schema.string().required(),
                card: Schema.string().required()
            })
        },
        async ({ presetId, card }, action) => {
            await requireActionLevel(ctx, action, WRITE_LEVEL)
            await ui.admin.savePresetPersonaCard(presetId, card)
            notifyChanged(ctx)
        }
    )

    ctx.chatluna_webui.action(
        'livingmemory.resetPersona',
        { input: Schema.object({ presetId: Schema.string().required() }) },
        async ({ presetId }, action) => {
            await requireActionLevel(ctx, action, WRITE_LEVEL)
            await ui.admin.resetPresetPersonaCard(presetId)
            notifyChanged(ctx)
        }
    )

    ctx.chatluna_webui.action(
        'livingmemory.deleteSnapshot',
        { input: Schema.object({ id: Schema.string().required() }) },
        async ({ id }, action) => {
            await requireActionLevel(ctx, action, WRITE_LEVEL)
            await ui.admin.deleteSnapshot(id)
            notifyChanged(ctx)
        }
    )

    ctx.chatluna_webui.action(
        'livingmemory.updateProfile',
        {
            input: Schema.object({
                id: Schema.string().required(),
                content: Schema.string().required()
            })
        },
        async ({ id, content }, action) => {
            await requireActionLevel(ctx, action, WRITE_LEVEL)
            await ui.admin.updateUserProfile(id, content)
            notifyChanged(ctx)
        }
    )

    ctx.chatluna_webui.action(
        'livingmemory.deleteProfile',
        { input: Schema.object({ id: Schema.string().required() }) },
        async ({ id }, action) => {
            await requireActionLevel(ctx, action, WRITE_LEVEL)
            await ui.admin.deleteUserProfile(id)
            notifyChanged(ctx)
        }
    )

    ctx.chatluna_webui.action(
        'livingmemory.regenerateProfile',
        {
            input: Schema.object({
                presetId: Schema.string().required(),
                speakerKey: Schema.string().required()
            })
        },
        async ({ presetId, speakerKey }, action) => {
            await requireActionLevel(ctx, action, WRITE_LEVEL)
            await ui.admin.regenerateUserProfile(presetId, speakerKey)
            notifyChanged(ctx)
        }
    )

    ctx.chatluna_webui.action(
        'livingmemory.exportPreset',
        { input: Schema.object({ presetId: Schema.string().required() }) },
        async ({ presetId }) => ({ data: await ui.admin.exportPreset(presetId) })
    )

    ctx.chatluna_webui.action(
        'livingmemory.importPreset',
        {
            input: Schema.object({
                presetId: Schema.string().required(),
                data: Schema.any().required()
            })
        },
        async ({ presetId, data }, action) => {
            await requireActionLevel(ctx, action, WRITE_LEVEL)
            const summary = await ui.admin.importPreset(
                presetId,
                data as LivingMemoryPresetExport
            )
            notifyChanged(ctx)
            return {
                entries: summary.entries,
                userProfiles: summary.userProfiles,
                presetSpeakers: summary.presetSpeakers,
                indexJobId: summary.indexJobId
            }
        }
    )

    ctx.chatluna_webui.action(
        'livingmemory.rebuildIndex',
        { input: Schema.object({ presetId: Schema.string().required() }) },
        async ({ presetId }, action) => {
            await requireActionLevel(ctx, action, WRITE_LEVEL)
            await ui.admin.reconcileVectorIndex(presetId)
        }
    )

    ctx.chatluna_webui.action(
        'livingmemory.clearPreset',
        { input: Schema.object({ presetId: Schema.string().required() }) },
        async ({ presetId }, action) => {
            await requireActionLevel(ctx, action, WRITE_LEVEL)
            await ui.admin.clearPresetData(presetId)
            ui.logger.summary('已清空预设数据', `预设：${presetId}`, 'warn')
            notifyChanged(ctx)
        }
    )

    /** 通知管理页重新读取数据。 */
    function notifyChanged(context: Context) {
        context.emit('livingmemory/change')
    }
}

const toEntryView = (entry: MemoryEntryRecord): LivingMemoryEntryView => ({
    id: entry.id,
    presetId: entry.presetId,
    type: entry.type,
    status: entry.status,
    topic: entry.topic,
    title: entry.title,
    content: entry.content,
    summary: entry.summary,
    sentiment: entry.sentiment,
    keywords: [...entry.keywords],
    speakerKeys: [...entry.speakerKeys],
    importance: entry.importance,
    sourceLabel: entry.sourceLabel,
    sourceConversationId: entry.sourceConversationId,
    createdAt: entry.createdAt.getTime(),
    updatedAt: entry.updatedAt.getTime()
})

const toJobView = (job: MemoryJobRecord): LivingMemoryJobView => ({
    id: job.id,
    presetId: job.presetId,
    conversationId: job.conversationId,
    kind: job.kind,
    status: job.status,
    detail: job.detail ?? '',
    error: job.error,
    createdAt: job.createdAt.getTime(),
    startedAt: job.startedAt === null ? null : job.startedAt.getTime(),
    finishedAt: job.finishedAt === null ? null : job.finishedAt.getTime()
})

const toPersonaView = (card: PresetPersonaCardInfo): LivingMemoryPersonaView => ({
    presetId: card.presetId,
    name: card.presetId,
    card: card.card,
    source: card.source,
    stale: card.stale,
    updatedAt: card.updatedAt.getTime()
})

const toProfileView = (profile: UserProfileRecord): LivingMemoryProfileView => ({
    id: profile.id,
    speakerKey: profile.speakerKey,
    speakerLabel: profile.speakerLabel,
    content: profile.content,
    sourceMemoryIds: [...profile.sourceMemoryIds],
    updatedAt: profile.updatedAt.getTime()
})

const toSnapshotView = (
    snapshot: MemorySnapshotRecord
): LivingMemorySnapshotView => ({
    id: snapshot.id,
    conversationId: snapshot.conversationId,
    query: snapshot.query,
    itemCount: snapshot.items.length,
    createdAt: snapshot.createdAt.getTime()
})
