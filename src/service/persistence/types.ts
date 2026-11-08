import type { Database } from '@cordisjs/plugin-database'
import type { PresetSpeakerRecord } from '../../contracts/memory.ts'

/** 事务回调收到的数据库句柄；所有持久化写入共用同一类型。 */
export type LivingMemoryTransaction = Database

/** 由 `LivingMemoryRepository` 注入的串行事务入口。 */
export type LivingMemoryTransact = <T>(callback: (database: LivingMemoryTransaction) => Promise<T>) => Promise<T>

export interface LivingMemoryEntrySpeakerRecord {
  id: string
  presetId: string
  speakerKey: string
  memoryId: string
}

export interface PresetSpeakerTableRecord extends Omit<PresetSpeakerRecord, 'speakerAliases'> {
  speakerAliases: string[] | null
}