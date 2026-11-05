import type {} from '@chatluna/ui-client/client'
import type {
    LivingMemoryEntriesParams,
    LivingMemoryEntriesSnapshot,
    LivingMemoryJobView,
    LivingMemoryPersonaView,
    LivingMemoryProfilesSnapshot,
    LivingMemoryScopesSnapshot,
    LivingMemorySearchHitView,
    LivingMemorySnapshotsSnapshot,
    LivingMemoryStatusSnapshot
} from './webui.ts'
import type {
    LivingMemorySearchMemoryType,
    MemoryEntryRecord,
    MemorySearchStatus
} from './memory.ts'
import type { DreamTriggerResult } from './workflows.ts'

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
        'livingmemory.scopes': LivingMemoryScopesSnapshot
        'livingmemory.entries': LivingMemoryEntriesSnapshot
        'livingmemory.jobs': LivingMemoryJobView[]
        'livingmemory.personas': LivingMemoryPersonaView[]
        'livingmemory.profiles': LivingMemoryProfilesSnapshot
        'livingmemory.snapshots': LivingMemorySnapshotsSnapshot
        'livingmemory.status': LivingMemoryStatusSnapshot
    }
    interface Actions {
        'livingmemory.create'(input: {
            presetId: string
            conversationId?: string
            userId?: string
            channelId?: string
            type: MemoryEntryRecord['type']
            content: string
            topic?: string
            title?: string
            keywords?: string[]
            speakerKeys?: string[]
        }): { id: string }
        'livingmemory.update'(input: {
            id: string
            content?: string
            topic?: string
            title?: string
            keywords?: string[]
            importance?: number
            status?: MemoryEntryRecord['status']
        }): void
        'livingmemory.remove'(input: { id: string; purge?: boolean }): void
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
    }
}