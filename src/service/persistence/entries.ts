import { MemoryInputError } from '../memory/errors.ts'
import { randomUUID } from 'node:crypto'
import { $ } from '@cordisjs/plugin-database'
import type { Context } from 'cordis'
import type {
    MemoryEntryRecord,
    MemoryMutationInput,
    MemoryScope,
    MemorySourceMessage,
    MemoryUpdatePatch
} from '../../contracts/memory.ts'
import type { MemoryIndexSourceRecord } from '../../contracts/vector_index.ts'
import type {
    AttributedMemoryItem,
    DreamMemoryEntryRecord
} from '../../contracts/workflows.ts'
import {
    normalizeMemoryImportance,
    normalizeMemoryKeywords,
    normalizeMemoryText,
    normalizeOptionalMemoryText
} from '../memory/entry_fields.ts'
import {
    createSourceOriginsFromMessages,
    mergeMemorySourceOrigins
} from '../memory/origins/source_origins.ts'
import {
    createActiveMemorySpeakerRows,
    normalizeEntryRecord,
    normalizeSourceConversationId
} from './normalizers.ts'
import type { LivingMemoryTransact, LivingMemoryTransaction } from './types.ts'
import {
    normalizeSpeakerKeys,
    resolveScopeSpeakerKeys
} from '../memory/speaker_identity.ts'

const memoryEntryFields: (keyof MemoryEntryRecord)[] = [
    'id',
    'presetId',
    'speakerKeys',
    'type',
    'status',
    'content',
    'keywords',
    'summary',
    'sentiment',
    'importance',
    'sourceConversationId',
    'sourceOrigins',
    'createdAt',
    'updatedAt'
]
const indexSourceFields: (keyof MemoryEntryRecord)[] = [
    'id',
    'presetId',
    'sourceConversationId',
    'status',
    'type',
    'content',
    'keywords',
    'updatedAt'
]
const dreamEntryFields: (keyof MemoryEntryRecord)[] = [
    'id',
    'presetId',
    'speakerKeys',
    'type',
    'content',
    'keywords',
    'summary',
    'sentiment',
    'importance',
    'createdAt',
    'updatedAt'
]
const recallEntryFields: (keyof MemoryEntryRecord)[] = [
    'id',
    'type',
    'content',
    'keywords',
    'summary',
    'sentiment',
    'importance',
    'sourceConversationId',
    'createdAt',
    'updatedAt'
]

export class LivingMemoryEntryRepository {
    constructor(
        private readonly ctx: Context,
        private readonly transact: LivingMemoryTransact
    ) {}

    /** 驱动就绪后才有 `database` 服务；仓储实例只在驱动加载后创建。 */
    private get database() {
        return this.ctx.get('database')!
    }

    async listEntriesByPreset(presetId: string): Promise<MemoryEntryRecord[]> {
        const entries = await this.database.get(
            'living_memory_entry',
            { presetId },
            memoryEntryFields
        )

        return entries.map(normalizeEntryRecord)
    }

    async listArchivedEntriesBefore(presetId: string, updatedBefore: Date) {
        return await this.database.get(
            'living_memory_entry',
            {
                presetId,
                status: 'archived',
                updatedAt: { $lte: updatedBefore }
            },
            ['id', 'importance', 'updatedAt']
        )
    }

    async listDreamEntriesByPreset(
        presetId: string
    ): Promise<DreamMemoryEntryRecord[]> {
        return await this.database.get(
            'living_memory_entry',
            { presetId, status: 'active' },
            dreamEntryFields
        )
    }

    async listActiveMemorySpeakerKeys(presetId: string): Promise<string[]> {
        const rows = await this.database
            .select('living_memory_entry_speaker', { presetId })
            .groupBy('speakerKey')
            .execute(['speakerKey'])
        return rows.map((row) => row.speakerKey).sort()
    }

    async listActiveMemorySpeakerLinks(
        presetId: string,
        speakerKeys: string[]
    ) {
        if (speakerKeys.length === 0) {
            return []
        }

        const links = await this.database.get(
            'living_memory_entry_speaker',
            { presetId, speakerKey: { $in: speakerKeys } },
            ['speakerKey', 'memoryId']
        )
        return links.sort(
            (left, right) =>
                left.speakerKey.localeCompare(right.speakerKey) ||
                left.memoryId.localeCompare(right.memoryId)
        )
    }

    async listEntryIndexSourcePage(
        afterId: string | null,
        limit: number
    ): Promise<MemoryIndexSourceRecord[]> {
        return this.selectEntryIndexSourcePage(null, afterId, limit)
    }

    async listEntryIndexSourcePageByPreset(
        presetId: string,
        afterId: string | null,
        limit: number
    ): Promise<MemoryIndexSourceRecord[]> {
        return this.selectEntryIndexSourcePage(presetId, afterId, limit)
    }

    private async selectEntryIndexSourcePage(
        presetId: string | null,
        afterId: string | null,
        limit: number
    ): Promise<MemoryIndexSourceRecord[]> {
        const selection =
            presetId === null
                ? this.database.select('living_memory_entry')
                : this.database.select('living_memory_entry', { presetId })
        if (afterId !== null) {
            selection.where({ id: { $gt: afterId } })
        }
        const records = await selection
            .orderBy('id', 'asc')
            .limit(limit)
            .execute(indexSourceFields)
        return records.map((record) => ({
            ...record,
            sourceConversationId: normalizeSourceConversationId(
                record.sourceConversationId
            )
        }))
    }

    countEntriesByPreset(presetId: string) {
        return this.database.eval(
            'living_memory_entry',
            (entry) => $.count(entry.id),
            {
                presetId
            }
        )
    }

    countEntries() {
        return this.database.eval('living_memory_entry', (entry) =>
            $.count(entry.id)
        )
    }

    async listEntryPresetIds() {
        const entries = await this.database
            .select('living_memory_entry')
            .groupBy('presetId')
            .execute(['presetId'])
        return entries.map((entry) => entry.presetId).sort()
    }

    countActiveEntries(presetId: string) {
        return this.database.eval(
            'living_memory_entry',
            (entry) => $.count(entry.id),
            {
                presetId,
                status: 'active'
            }
        )
    }

    async getEntryById(id: string): Promise<MemoryEntryRecord | undefined> {
        const record = (
            await this.database.get(
                'living_memory_entry',
                { id },
                memoryEntryFields
            )
        )[0]

        return record == null ? undefined : normalizeEntryRecord(record)
    }

    async getEntriesByPresetAndIds(
        presetId: string,
        ids: string[]
    ): Promise<MemoryEntryRecord[]> {
        if (ids.length === 0) {
            return []
        }

        const entries = await this.database.get(
            'living_memory_entry',
            {
                presetId,
                id: {
                    $in: ids
                }
            },
            memoryEntryFields
        )

        return entries.map(normalizeEntryRecord)
    }

    async getSearchEntriesByPresetAndIds(presetId: string, ids: string[]) {
        if (ids.length === 0) {
            return []
        }

        return await this.database.get(
            'living_memory_entry',
            {
                presetId,
                id: { $in: ids }
            },
            recallEntryFields
        )
    }

    async appendMemories(
        scope: MemoryScope,
        sourceOriginMessages: MemorySourceMessage[],
        extracted: AttributedMemoryItem[]
    ) {
        if (extracted.length === 0) {
            return []
        }

        const now = new Date()
        const sourceOrigins =
            createSourceOriginsFromMessages(sourceOriginMessages)
        const records = extracted.map((item) =>
            this.buildMemoryEntry(
                scope,
                item,
                sourceOrigins,
                now,
                item.speakerKeys
            )
        )
        await this.transact(async (database) => {
            await database.upsert('living_memory_entry', records)
            await this.replaceActiveMemorySpeakers(database, records)
        })
        return records
    }

    async createMemory(
        scope: MemoryScope,
        input: MemoryMutationInput,
        speakerKeys?: string[]
    ) {
        const record = this.buildMemoryEntry(
            scope,
            input,
            [],
            new Date(),
            speakerKeys ?? resolveScopeSpeakerKeys(scope)
        )
        await this.transact(async (database) => {
            await database.create('living_memory_entry', record)
            await this.replaceActiveMemorySpeakers(database, [record])
        })
        return record
    }

    private buildMemoryEntry(
        scope: MemoryScope,
        fields: MemoryMutationInput,
        sourceOrigins: MemoryEntryRecord['sourceOrigins'],
        createdAt: Date,
        speakerKeys: string[]
    ): MemoryEntryRecord {
        const content = normalizeMemoryText(fields.content)
        return {
            id: randomUUID(),
            presetId: scope.presetId,
            speakerKeys: normalizeSpeakerKeys(speakerKeys),
            type: fields.type,
            status: fields.status ?? 'active',
            content,
            keywords: normalizeMemoryKeywords(fields.keywords),
            summary: normalizeOptionalMemoryText(fields.summary),
            sentiment: normalizeOptionalMemoryText(fields.sentiment),
            importance: normalizeMemoryImportance(fields.importance),
            // 空串表示无会话上下文（WebUI 手工创建），落库归一为 null，
            // 使「全局可见」只依赖 sourceConversationId == null 单一判定。
            sourceConversationId: scope.conversationId.trim() || null,
            sourceOrigins,
            createdAt,
            updatedAt: createdAt
        }
    }

    async updateMemory(id: string, patch: MemoryUpdatePatch) {
        const current = await this.getEntryById(id)
        if (current == null) {
            return null
        }
        const fields = this.buildMemoryUpdatePatch(current, patch)
        const speakersChanged =
            fields.status !== current.status ||
            fields.speakerKeys.length !== current.speakerKeys.length ||
            fields.speakerKeys.some(
                (speakerKey, index) => speakerKey !== current.speakerKeys[index]
            )
        return await this.transact(async (database) => {
            const update = {
                ...fields,
                updatedAt: new Date()
            }
            const record = { ...current, ...update }
            await database.set(
                'living_memory_entry',
                { id: current.id },
                update
            )
            if (speakersChanged) {
                await this.replaceActiveMemorySpeakers(database, [record])
            }
            return {
                record,
                contentChanged: record.content !== current.content
            }
        })
    }

    async archiveActiveEntries(presetId: string, ids: string[]) {
        if (ids.length === 0) {
            return []
        }
        const records = (
            await this.getEntriesByPresetAndIds(presetId, ids)
        ).filter((record) => record.status === 'active')
        if (records.length === 0) {
            return []
        }

        const updatedAt = new Date()
        const archived = records.map((record) => ({
            ...record,
            status: 'archived' as const,
            updatedAt
        }))
        await this.transact(async (database) => {
            await database.set(
                'living_memory_entry',
                {
                    presetId,
                    status: 'active',
                    id: { $in: records.map((record) => record.id) }
                },
                { status: 'archived', updatedAt }
            )
            await this.replaceActiveMemorySpeakers(database, archived)
        })
        return archived
    }

    async splitMemory(
        presetId: string,
        sourceMemoryId: string,
        memories: AttributedMemoryItem[]
    ) {
        if (memories.length < 2) {
            throw new MemoryInputError('拆分结果至少需要两条记忆。')
        }
        return this.transact(async (database) => {
            const [row] = await database.get(
                'living_memory_entry',
                { presetId, id: sourceMemoryId, status: 'active' },
                memoryEntryFields
            )
            if (row === undefined) {
                throw new MemoryInputError(
                    `不存在 ID 为 ${sourceMemoryId} 的记忆，请重新查明记忆 ID 后再调用。`
                )
            }
            const source = normalizeEntryRecord(row)
            const now = new Date()
            const records = memories.map((memory) => {
                const record = this.buildMemoryEntry(
                    {
                        presetId,
                        conversationId: source.sourceConversationId ?? ''
                    },
                    memory,
                    source.sourceOrigins,
                    now,
                    memory.speakerKeys
                )
                return record
            })
            await database.upsert('living_memory_entry', records)
            await database.set(
                'living_memory_entry',
                { presetId, id: sourceMemoryId },
                { status: 'archived', updatedAt: now }
            )
            const archivedSource = {
                ...source,
                status: 'archived' as const,
                updatedAt: now
            }
            await this.replaceActiveMemorySpeakers(database, [
                ...records,
                archivedSource
            ])
            return { memories: records, archivedSource }
        })
    }

    async mergeMemories(
        presetId: string,
        sourceMemoryIds: string[],
        memory: AttributedMemoryItem
    ) {
        const sourceIds = new Set(sourceMemoryIds)
        if (sourceIds.size < 2 || sourceIds.size !== sourceMemoryIds.length) {
            throw new MemoryInputError(
                '合并来源至少需要两条记忆，ID 不得重复。'
            )
        }
        return this.transact(async (database) => {
            const entries = (
                await database.get(
                    'living_memory_entry',
                    {
                        presetId,
                        id: { $in: sourceMemoryIds },
                        status: 'active'
                    },
                    memoryEntryFields
                )
            ).map(normalizeEntryRecord)
            const entryById = new Map(entries.map((entry) => [entry.id, entry]))
            const sources = sourceMemoryIds.map((id) => {
                const entry = entryById.get(id)
                if (entry === undefined) {
                    throw new MemoryInputError(
                        `不存在 ID 为 ${id} 的记忆，请重新查明记忆 ID 后再调用。`
                    )
                }
                return entry
            })
            const sameConversation = sources.every(
                (source) =>
                    source.sourceConversationId ===
                    sources[0].sourceConversationId
            )
            const now = new Date()
            const record = this.buildMemoryEntry(
                {
                    presetId,
                    conversationId: sameConversation
                        ? (sources[0].sourceConversationId ?? '')
                        : ''
                },
                memory,
                mergeMemorySourceOrigins(sources),
                now,
                memory.speakerKeys
            )
            await database.create('living_memory_entry', record)
            await database.set(
                'living_memory_entry',
                { presetId, id: { $in: sourceMemoryIds } },
                { status: 'archived', updatedAt: now }
            )
            const archivedSources = sources.map((source) => ({
                ...source,
                status: 'archived' as const,
                updatedAt: now
            }))
            await this.replaceActiveMemorySpeakers(database, [
                record,
                ...archivedSources
            ])
            return { memory: record, archivedSources }
        })
    }

    async deleteEntries(presetId: string, ids: string[]) {
        if (ids.length === 0) {
            return
        }
        await this.transact(async (database) => {
            await database.remove('living_memory_entry', {
                presetId,
                id: { $in: ids }
            })
            await database.remove('living_memory_entry_speaker', {
                presetId,
                memoryId: { $in: ids }
            })
        })
    }

    private async replaceActiveMemorySpeakers(
        database: LivingMemoryTransaction,
        entries: Pick<
            MemoryEntryRecord,
            'id' | 'presetId' | 'speakerKeys' | 'status'
        >[]
    ) {
        if (entries.length === 0) {
            return
        }

        // 按 presetId 分组删除：入参每条记录自带 presetId，写入侧也按各自的
        // presetId 生成关联行，删除侧必须保持同一口径，否则跨预设批次会残留
        // 旧关联行。删除条件保留 presetId 以命中 (presetId, memoryId) 索引。
        const memoryIdsByPreset = new Map<string, string[]>()
        for (const entry of entries) {
            const memoryIds = memoryIdsByPreset.get(entry.presetId)
            if (memoryIds == null) {
                memoryIdsByPreset.set(entry.presetId, [entry.id])
            } else {
                memoryIds.push(entry.id)
            }
        }
        for (const [presetId, memoryIds] of memoryIdsByPreset) {
            await database.remove('living_memory_entry_speaker', {
                presetId,
                memoryId: { $in: memoryIds }
            })
        }

        const rows = entries.flatMap(createActiveMemorySpeakerRows)
        if (rows.length > 0) {
            await database.upsert('living_memory_entry_speaker', rows)
        }
    }

    private buildMemoryUpdatePatch(
        current: MemoryEntryRecord,
        patch: Partial<MemoryMutationInput> & { speakerKeys?: string[] }
    ) {
        const content =
            patch.content === undefined
                ? current.content
                : normalizeMemoryText(patch.content)
        const keywords =
            patch.keywords === undefined
                ? current.keywords
                : normalizeMemoryKeywords(patch.keywords)
        const summary =
            patch.summary === undefined
                ? current.summary
                : normalizeOptionalMemoryText(patch.summary)
        const status =
            patch.status === undefined ? current.status : patch.status
        const sentiment =
            patch.sentiment === undefined ? current.sentiment : patch.sentiment
        const importance =
            patch.importance === undefined
                ? current.importance
                : patch.importance
        const speakerKeys =
            patch.speakerKeys === undefined
                ? current.speakerKeys
                : normalizeSpeakerKeys(patch.speakerKeys)
        return {
            speakerKeys,
            type: patch.type ?? current.type,
            status,
            content,
            keywords,
            summary,
            sentiment: normalizeOptionalMemoryText(sentiment),
            importance: normalizeMemoryImportance(importance)
        }
    }
}
