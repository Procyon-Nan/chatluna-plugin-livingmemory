import type { Context } from 'cordis'
import type {} from '@cordisjs/plugin-database'

export const name = 'chatluna-livingmemory-database'
export const inject = ['model', 'database']

export function defineLivingMemoryTables(ctx: Context) {
  ctx.model.extend(
    'living_memory_entry',
    {
      id: 'string(64)',
      presetId: 'string(255)',
      speakerKeys: {
        type: 'json',
        initial: []
      },
      type: 'string(32)',
      status: {
        type: 'string',
        length: 16,
        initial: 'active'
      },
      // v2 的 MemoryEntry 以 topic 分组目录与索引行；v1 无此概念，旧数据落为 other。
      topic: {
        type: 'string',
        length: 255,
        initial: 'other'
      },
      title: {
        type: 'text',
        nullable: true,
        initial: null
      },
      content: 'text',
      keywords: {
        type: 'json',
        initial: []
      },
      // v2 的结构化字段；v1 不使用，保留供工具与管理页面展示。
      fields: {
        type: 'json',
        nullable: true,
        initial: null
      },
      summary: {
        type: 'text',
        nullable: true,
        initial: null
      },
      sentiment: {
        type: 'text',
        nullable: true,
        initial: null
      },
      importance: {
        type: 'double',
        nullable: true,
        initial: null
      },
      sourceConversationId: {
        type: 'string',
        length: 255,
        nullable: true,
        initial: null
      },
      sourceLabel: {
        type: 'text',
        nullable: true,
        initial: null
      },
      sourceOrigins: 'array',
      // 仅用于首次向量索引迁移，迁移完成后不再参与运行时读写。
      embedding: {
        type: 'json',
        nullable: true,
        initial: null
      },
      embeddingModelId: {
        type: 'string',
        length: 255,
        nullable: true,
        initial: null
      },
      createdAt: 'timestamp',
      updatedAt: 'timestamp'
    },
    {
      autoInc: false,
      primary: 'id',
      indexes: [['presetId', 'status', 'updatedAt']]
    }
  )

  // 字段退役时先删除依赖它的旧索引，再由数据库驱动移除列。
  ctx.model.migrate('living_memory_entry', { isConsolidated: 'boolean' }, async (database) => {
    const table = 'living_memory_entry'
    const indexes = await database.select(table).driver.getIndexes(table)
    for (const index of indexes) {
      if (index.name && 'isConsolidated' in index.keys) {
        await database.select(table).driver.dropIndex(table, index.name)
      }
    }
  })

  ctx.model.extend(
    'living_memory_snapshot',
    {
      id: 'string(64)',
      presetId: 'string(255)',
      conversationId: 'string(255)',
      query: 'text',
      items: {
        type: 'json',
        initial: []
      },
      createdAt: 'timestamp'
    },
    {
      autoInc: false,
      primary: 'id'
    }
  )

  ctx.model.extend(
    'living_memory_entry_speaker',
    {
      id: 'string(64)',
      presetId: 'string(255)',
      speakerKey: 'string(255)',
      memoryId: 'string(64)'
    },
    {
      autoInc: false,
      primary: 'id',
      indexes: [
        ['presetId', 'speakerKey'],
        ['presetId', 'memoryId']
      ]
    }
  )

  ctx.model.extend(
    'living_memory_migration',
    {
      id: 'string(64)',
      appliedAt: 'timestamp'
    },
    {
      autoInc: false,
      primary: 'id'
    }
  )

  ctx.model.extend(
    'living_memory_job',
    {
      id: 'string(64)',
      presetId: 'string(255)',
      conversationId: 'string(255)',
      kind: 'string(16)',
      status: 'string(16)',
      input: 'text',
      detail: 'text',
      error: 'text',
      createdAt: 'timestamp',
      startedAt: 'timestamp',
      finishedAt: 'timestamp',
      updatedAt: 'timestamp'
    },
    {
      autoInc: false,
      primary: 'id'
    }
  )

  ctx.model.extend(
    'living_memory_user_profile',
    {
      id: 'string(64)',
      presetId: 'string(255)',
      speakerKey: 'string(255)',
      speakerLabel: 'string(255)',
      content: 'text',
      sourceMemoryIds: {
        type: 'json',
        initial: []
      },
      createdAt: 'timestamp',
      updatedAt: 'timestamp'
    },
    {
      autoInc: false,
      primary: 'id'
    }
  )

  ctx.model.extend(
    'living_memory_preset_speaker',
    {
      id: 'string(64)',
      presetId: 'string(255)',
      speakerKey: 'string(255)',
      speakerLabel: 'string(255)',
      speakerAliases: {
        type: 'json',
        nullable: true,
        initial: null
      },
      speakerId: {
        type: 'string',
        length: 255,
        nullable: true,
        initial: null
      },
      platform: {
        type: 'string',
        length: 255,
        nullable: true,
        initial: null
      },
      createdAt: 'timestamp',
      updatedAt: 'timestamp'
    },
    {
      autoInc: false,
      primary: 'id'
    }
  )

  // 每个预设缓存一张人设卡片，按 presetId 读取。
  ctx.model.extend(
    'living_memory_preset_persona',
    {
      presetId: 'string(255)',
      card: 'text',
      rawHash: 'string(64)',
      source: {
        type: 'string',
        length: 16,
        initial: 'generated'
      },
      totalLines: {
        type: 'integer',
        initial: 0
      },
      deletedLines: {
        type: 'integer',
        initial: 0
      },
      usedRawFallback: {
        type: 'boolean',
        initial: false
      },
      updatedAt: 'timestamp'
    },
    {
      autoInc: false,
      primary: 'presetId'
    }
  )
}

declare module '@cordisjs/plugin-database' {
  interface Tables {
    living_memory_entry: import('../../contracts/memory.ts').MemoryEntryRecord & {
      topic: string
      title: string | null
      fields: Record<string, string | number> | null
      embedding: number[] | null
      embeddingModelId: string | null
      isConsolidated?: boolean
    }
    living_memory_snapshot: import('../../contracts/memory.ts').MemorySnapshotRecord
    living_memory_entry_speaker: import('./types.ts').LivingMemoryEntrySpeakerRecord
    living_memory_migration: import('../../contracts/memory.ts').LivingMemoryMigrationRecord
    living_memory_job: import('../../contracts/memory.ts').MemoryJobRecord
    living_memory_user_profile: import('../../contracts/memory.ts').UserProfileRecord
    living_memory_preset_speaker: import('./types.ts').PresetSpeakerTableRecord
    living_memory_preset_persona: import('../../contracts/memory.ts').PresetPersonaRecord
  }
}
