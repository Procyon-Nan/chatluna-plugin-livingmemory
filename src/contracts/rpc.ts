import type {
    LivingMemoryPresetExport,
    LivingMemoryPresetImportResult,
    LivingMemorySearchDetailedResult,
    LivingMemorySearchInput,
    MemoryEntryRecord,
    MemoryEntryStatus,
    MemoryEntryType,
    MemoryJobRecord,
    MemoryJobStatus,
    MemoryMutationInput,
    MemoryUpdatePatch,
    MemorySnapshotRecord,
    PresetPersonaCardInfo,
    PresetSpeakerRecord,
    UserProfileRecord
} from './memory.ts'
import type { DreamTriggerResult, MemoryServiceStatus } from './workflows.ts'

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

export interface CreateMemoryRequest {
    /** 缺省表示手工创建无会话归属，记忆全局可见。 */
    conversationId?: string
    presetId: string
    userId?: string
    channelId?: string
    memory: MemoryMutationInput
    speakerKeys?: string[]
}

