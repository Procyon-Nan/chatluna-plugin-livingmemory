import type {} from '@chatluna/ui-client/client'
import type {
    LivingMemoryEntriesSnapshot,
    LivingMemoryJobView,
    LivingMemoryPersonaView,
    LivingMemoryProfilesSnapshot,
    LivingMemoryScopesSnapshot,
    LivingMemorySearchHitView,
    LivingMemorySnapshotsSnapshot,
    LivingMemoryStatusSnapshot
} from '../src/contracts/webui.ts'
import type {
    LivingMemorySearchMemoryType,
    MemoryEntryRecord,
    MemorySearchStatus
} from '../src/contracts/memory.ts'
import type { DreamTriggerResult } from '../src/contracts/workflows.ts'

/**
 * WebUI 客户端使用的 `States` / `Actions` 声明。
 *
 * 服务端注册时也要能看到这份增强，因此内容与 `src/contracts/webui_live.ts`
 * 保持一致；两处分开是因为客户端配置引用 React 类型、服务端编译不引入。
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
        'livingmemory.dream'(input: { presetId: string }): DreamTriggerResult
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