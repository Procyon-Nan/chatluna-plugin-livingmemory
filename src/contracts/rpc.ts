import type {
    MemoryEntryRecord,
    MemoryEntryStatus,
    MemoryEntryType,
    MemoryJobRecord,
    MemoryJobStatus,
    PresetSpeakerRecord,
    UserProfileRecord
} from './memory.ts'

export interface PageRequest {
    page?: number
    pageSize?: number
}

export interface MemoryListFilter {
    presetId: string
    type?: MemoryEntryRecord['type']
    status?: MemoryEntryStatus | 'all'
    keyword?: string
    speakerKey?: string
}

export interface MemoryListQuery extends MemoryListFilter, PageRequest {}

export interface SnapshotListQuery extends PageRequest {
    presetId: string
    conversationId?: string
}

export interface JobListQuery extends PageRequest {
    presetId: string
    kind?: MemoryJobRecord['kind']
    status?: MemoryJobStatus
}

export interface UserProfileListQuery extends PageRequest {
    presetId: string
    keyword?: string
}

export type UserProfileListItem = UserProfileRecord & Pick<PresetSpeakerRecord, 'speakerId' | 'platform'>

export interface PageResult<T> {
    items: T[]
    page: number
    pageSize: number
    total: number
}

export type MemoryFacetStatus = MemoryEntryStatus | 'all'

export interface MemoryListFacets {
    statuses: Record<MemoryFacetStatus, number>
    types: Record<MemoryFacetStatus, Record<MemoryEntryType, number>>
}

export interface MemoryListResult extends PageResult<MemoryEntryRecord> {
    facets: MemoryListFacets
}
