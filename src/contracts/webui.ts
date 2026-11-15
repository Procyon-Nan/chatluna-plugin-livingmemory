import type { MemoryEntryRecord, MemorySourceLabel, MemoryJobRecord, PresetPersonaSource } from './memory.ts'
import type { MemoryListQuery } from './rpc.ts'
import type { DreamTriggerResult, MemoryServiceStatus } from './workflows.ts'

export interface LivingMemoryEntryView {
    id: string
    presetId: string
    type: MemoryEntryRecord['type']
    status: MemoryEntryRecord['status']
    content: string
    summary: string | null
    sentiment: string | null
    keywords: string[]
    speakerKeys: string[]
    importance: number | null
    sourceLabel: MemorySourceLabel
    createdAt: number
    updatedAt: number
}

export interface LivingMemorySpeakerView {
    speakerKey: string
    speakerLabel: string
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
    nativeMemoryActive: boolean
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
    card: string
    source: PresetPersonaSource
    stale: boolean
    updatedAt: number
}

export interface LivingMemoryProfileView {
    id: string
    speakerKey: string
    speakerLabel: string
    speakerId: string | null
    platform: string | null
    content: string
    sourceMemoryCount: number
    updatedAt: number
}

export interface LivingMemorySnapshotView {
    id: string
    conversationId: string | null
    conversationLabel: string | null
    content: string
    searchTexts: string[]
    searchKeywords: string[]
    matchedMemories: Pick<MemoryEntryRecord, 'type' | 'content'>[]
    createdAt: number
}

/** 召回测试展示混合检索的各路分数。 */
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
