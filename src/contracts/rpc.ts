import type {
    MemoryEntryRecord,
    MemoryEntryStatus,
    MemoryEntryType,
    MemoryJobRecord,
    MemoryJobStatus
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
}

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
