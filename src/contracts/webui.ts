import type { MemoryEntryRecord, MemoryJobRecord } from './memory.ts'
import type { MemoryListQuery } from './rpc.ts'
import type { DreamTriggerResult, MemoryServiceStatus } from './workflows.ts'

/** 记忆页的作用域视图：与 v2 原生记忆页的 `MemoryScopeView` 同形。 */
export interface LivingMemoryScopeView {
    kind: 'global' | 'preset' | 'guild' | 'user' | 'conversation'
    presetId?: string | undefined
    platform?: string | undefined
    guildId?: string | undefined
    userId?: string | undefined
    conversationId?: string | undefined
}

export interface LivingMemoryScopeNode {
    key: string
    scope: LivingMemoryScopeView
    name: string
    count: number
    children: LivingMemoryScopeNode[]
}

export interface LivingMemoryScopesSnapshot {
    scopes: LivingMemoryScopeNode[]
    unavailable?: true
}

export interface LivingMemoryEntryView {
    id: string
    presetId: string
    type: MemoryEntryRecord['type']
    status: MemoryEntryRecord['status']
    topic: string
    title: string | null
    content: string
    summary: string | null
    keywords: string[]
    speakerKeys: string[]
    importance: number | null
    sourceLabel: string | null
    sourceConversationId: string | null
    createdAt: number
    updatedAt: number
}

/** 与 `query.ts` 的 `MemoryListFacets` 同形；这里只做界面投影。 */
export interface LivingMemoryFacetsView {
    statuses: Record<string, number>
    types: Record<string, Record<string, number>>
}

export interface LivingMemoryEntriesSnapshot {
    presetId: string
    entries: LivingMemoryEntryView[]
    facets: LivingMemoryFacetsView
    total: number
    page: number
    pageSize: number
}

export interface LivingMemoryProfilesSnapshot {
    presetId: string
    profiles: LivingMemoryProfileView[]
    total: number
    page: number
    pageSize: number
}

export interface LivingMemorySnapshotsSnapshot {
    presetId: string
    snapshots: LivingMemorySnapshotView[]
    total: number
    page: number
    pageSize: number
}

export interface LivingMemoryStatusSnapshot extends MemoryServiceStatus {
    presets: string[]
}

export interface LivingMemoryJobView {
    id: string
    presetId: string
    conversationId: string
    kind: MemoryJobRecord['kind']
    status: MemoryJobRecord['status']
    detail: string
    error: string | null
    createdAt: number
    startedAt: number | null
    finishedAt: number | null
}

export interface LivingMemoryPersonaView {
    presetId: string
    name: string
    card: string
    source: string
    stale: boolean
    updatedAt: number
}

export interface LivingMemoryProfileView {
    id: string
    speakerKey: string
    speakerLabel: string
    content: string
    sourceMemoryIds: string[]
    updatedAt: number
}

export interface LivingMemorySnapshotView {
    id: string
    conversationId: string
    query: string
    itemCount: number
    createdAt: number
}

/** 召回测试的命中项：保留混合检索的各路分数，与 v1 的测页面板同形。 */
export interface LivingMemorySearchHitView {
    id: string
    type: MemoryEntryRecord['type']
    content: string
    summary: string | null
    keywords: string[]
    cosineScore: number
    keywordMatchCount: number
    boostedScore: number
    rerankScore: number | null
    updatedAt: number
}

/** 列表查询的界面侧参数：预设由订阅参数给出，不在查询对象里重复。 */
export type LivingMemoryEntriesParams = Pick<
    MemoryListQuery,
    'page' | 'pageSize' | 'status' | 'type' | 'keyword' | 'speakerKey'
>

export type { DreamTriggerResult }
export type { MemoryEntryRecord, MemoryJobRecord }