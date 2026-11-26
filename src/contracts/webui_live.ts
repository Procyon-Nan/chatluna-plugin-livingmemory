import type {} from '@chatluna/ui-client/client'
import type {
    LivingMemoryEntriesParams,
    LivingMemoryEntriesSnapshot,
    LivingMemoryEntryView,
    LivingMemoryJobView,
    LivingMemoryPersonaView,
    LivingMemoryProfilesSnapshot,
    LivingMemorySearchHitView,
    LivingMemorySpeakerView,
    LivingMemorySnapshotsSnapshot,
    LivingMemoryStatusSnapshot
} from './webui.ts'
import type {
    LivingMemorySearchMemoryType,
    MemoryEntryRecord,
    MemoryMutationInput,
    MemorySearchStatus
} from './memory.ts'
import type { MemoryListFilter } from './rpc.ts'
import type { DreamTriggerResult } from './workflows.ts'

type EntryInput = MemoryMutationInput & { speakerKeys?: string[] }

/**
 * WebUI 的 live state 与 action 声明。
 *
 * 单独成文件，供服务端注册与客户端页面共用：服务端只从这里取 key 与入参
 * 类型，页面从这里取返回值类型。`@chatluna/ui-client/client` 的模块增强
 * 必须在使用 `chatluna_webui.state/action` 的编译单元里可见，否则 key 会被
 * 约束成内置的几个名字。
 */
declare module '@chatluna/ui-client/client' {
    interface States {
        'livingmemory.entries': LivingMemoryEntriesSnapshot
        'livingmemory.speakers': LivingMemorySpeakerView[]
        'livingmemory.jobs': LivingMemoryJobView[]
        'livingmemory.persona': { persona: LivingMemoryPersonaView | null }
        'livingmemory.profiles': LivingMemoryProfilesSnapshot
        'livingmemory.profileMemories': LivingMemoryEntryView[]
        'livingmemory.snapshots': LivingMemorySnapshotsSnapshot
        'livingmemory.status': LivingMemoryStatusSnapshot
        'livingmemory.settingsEntry': { id: string } | null
    }
    interface Actions {
        'livingmemory.create'(input: EntryInput & {
            presetId: string
            conversationId?: string
            userId?: string
            channelId?: string
        }): { id: string }
        'livingmemory.update'(input: Partial<EntryInput> & { id: string }): void
        'livingmemory.listMemorySelection'(filter: MemoryListFilter): Pick<MemoryEntryRecord, 'id' | 'status'>[]
        'livingmemory.archiveMemories'(input: { presetId: string; ids: string[] }): { archived: number }
        'livingmemory.deleteMemories'(input: { presetId: string; ids: string[] }): { deleted: number }
        'livingmemory.search'(input: {
            presetId: string
            searchTexts: string[]
            searchKeywords?: string[]
            memoryTypes?: LivingMemorySearchMemoryType[]
            memoryStatus?: MemorySearchStatus
        }): { hits: LivingMemorySearchHitView[] }
        'livingmemory.dream'(input: {
            presetId: string
        }): DreamTriggerResult
        'livingmemory.savePersona'(input: {
            presetId: string
            card: string
        }): void
        'livingmemory.resetPersona'(input: { presetId: string }): void
        'livingmemory.deleteSnapshot'(input: { id: string }): void
        'livingmemory.updateProfile'(input: { id: string; content: string }): void
        'livingmemory.deleteProfile'(input: { id: string }): void
        'livingmemory.regenerateProfile'(input: {
            presetId: string
            speakerKey: string
        }): void
        'livingmemory.exportPreset'(input: { presetId: string }): {
            data: unknown
        }
        'livingmemory.importPreset'(input: {
            presetId: string
            data: unknown
        }): {
            entries: number
            userProfiles: number
            presetSpeakers: number
            indexJobId: string
        }
        'livingmemory.rebuildIndex'(input: { presetId: string }): void
        'livingmemory.clearPreset'(input: { presetId: string }): void
    }
}

export type { LivingMemoryEntriesParams }

declare module 'cordis' {
    interface Events<C = any> {
        /** 管理页的刷新信号：记忆、画像或任务发生变化。 */
        'livingmemory/change'(): void
        'livingmemory/job-change'(): void
    }
}
