import type { Disposable } from 'cordis'
import type {
  MemoryBackend,
  MemoryChange,
  MemoryEntry,
  MemoryExport,
  MemoryHit,
  MemoryInput,
  MemoryListQuery,
  MemoryPage,
  MemoryPatch,
  MemoryScope,
  MemorySearchInput,
  MemorySourceOrigin
} from '@chatluna/memory'
import type { MemoryEntryRecord, MemoryMutationInput, MemoryUpdatePatch } from '../contracts/memory.ts'
import { titleOf } from './memory/entry_identity.ts'
import { createPresetImportId } from './persistence/normalizers.ts'
import type { LivingMemoryRepository } from './persistence/repository.ts'

/**
 * LivingMemory 的 `ctx.memory` 后端。
 *
 * v1 的业务能力（消息池、提取、召回、Dream、画像、索引）仍由插件自身的工作流承担；
 * 这里只把 v2 定义的后端契约映射到 v1 的持久化仓储，使原生工具、管理界面与路由
 * 能够把 LivingMemory 当作普通后端使用。
 */
export class LivingMemoryBackend implements MemoryBackend {
  readonly id = 'livingmemory'
  readonly label = 'LivingMemory'

  private readonly listeners = new Set<(change: MemoryChange) => void>()

  constructor(private readonly repository: LivingMemoryRepository) {}

  async search(scope: MemoryScope, input: MemorySearchInput): Promise<readonly MemoryHit[]> {
    const entries = await this.listForScope(scope)
    const phrases = input.texts.map((text) => text.toLowerCase()).filter((text) => text.length > 0)
    const keywords = (input.keywords ?? []).map((keyword) => keyword.toLowerCase()).filter(Boolean)
    const types = input.types === undefined || input.types.includes('all') ? undefined : new Set(input.types)
    const status = input.status ?? 'active'
    const now = Date.now()
    const hits: MemoryHit[] = []
    for (const entry of entries) {
      if (types !== undefined && !types.has(entry.type)) continue
      if (status !== 'all' && entry.status !== status) continue
      if (input.topics !== undefined && !input.topics.includes(entry.topic)) continue
      const haystack = searchable(entry)
      const phraseScore = phrases.reduce((score, phrase) => score + (haystack.includes(phrase) ? 3 : 0), 0)
      const keywordScore = keywords.reduce((score, keyword) => score + (haystack.includes(keyword) ? 1 : 0), 0)
      if (phraseScore === 0 && keywordScore === 0 && phrases.length + keywords.length > 0) continue
      const importanceScore = entry.importance ?? 0.5
      const recencyScore = Math.max(0, 1 - (now - entry.updatedAt.getTime()) / (90 * 86_400_000))
      hits.push({
        entry,
        score: phraseScore + keywordScore + importanceScore + recencyScore,
        keywordScore,
        phraseScore,
        importanceScore,
        recencyScore,
        ...snippetOf(entry.content, phrases[0] ?? keywords[0])
      })
    }
    return hits.sort((left, right) => right.score - left.score).slice(0, input.limit ?? 10)
  }

  async get(id: string): Promise<MemoryEntry | undefined> {
    const record = await this.repository.getEntryById(id)
    return record === undefined ? undefined : toEntry(record)
  }

  async list(query: MemoryListQuery): Promise<MemoryPage> {
    const all = (await this.repository.listEntriesByPreset(query.presetId)).map(toEntry)
    let entries = all
    if (query.scope !== undefined) entries = entries.filter((entry) => sameScope(entry.scope, query.scope!))
    if (query.topic !== undefined) entries = entries.filter((entry) => entry.topic === query.topic)
    if (query.type !== undefined) entries = entries.filter((entry) => entry.type === query.type)
    if (query.status !== undefined && query.status !== 'all') {
      entries = entries.filter((entry) => entry.status === query.status)
    }
    if (query.text !== undefined) {
      const text = query.text.toLowerCase()
      entries = entries.filter((entry) => searchable(entry).includes(text))
    }
    const offset = Number(query.cursor ?? 0)
    const limit = query.limit ?? 100
    const items = [...entries].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(offset, offset + limit)
    return {
      items,
      facets: {
        topics: countBy(all, (entry) => entry.topic),
        types: countBy(all, (entry) => entry.type),
        active: all.filter((entry) => entry.status === 'active').length,
        archived: all.filter((entry) => entry.status === 'archived').length
      },
      ...(offset + items.length < entries.length ? { nextCursor: String(offset + items.length) } : {})
    }
  }

  async create(scope: MemoryScope, input: readonly MemoryInput[]): Promise<readonly MemoryEntry[]> {
    const records: MemoryEntryRecord[] = []
    for (const item of input) {
      records.push(await this.repository.createMemory(scopeOf(scope, scope.conversationId ?? ''), inputOf(item)))
    }
    this.emit('created', scope.presetId, records)
    return records.map(toEntry)
  }

  async update(id: string, patch: MemoryPatch): Promise<MemoryEntry> {
    const record = await this.repository.updateMemory(id, patchOf(patch))
    if (record === null) throw new Error(`no such memory: ${id}`)
    this.emit('updated', record.record.presetId, [record.record])
    return toEntry(record.record)
  }

  async merge(presetId: string, ids: readonly string[], into: MemoryInput): Promise<MemoryEntry> {
    const merged = await this.repository.mergeMemories(presetId, [...ids], attributed(into))
    this.emit('updated', presetId, [merged.memory, ...merged.archivedSources])
    return toEntry(merged.memory)
  }

  async split(presetId: string, id: string, into: readonly MemoryInput[]): Promise<readonly MemoryEntry[]> {
    const split = await this.repository.splitMemory(presetId, id, into.map(attributed))
    this.emit('updated', presetId, [...split.memories, split.archivedSource])
    return split.memories.map(toEntry)
  }

  async archive(presetId: string, ids: readonly string[]): Promise<void> {
    const archived = await this.repository.archiveActiveEntries(presetId, [...ids])
    this.emit('archived', presetId, archived)
  }

  async remove(presetId: string, ids: readonly string[]): Promise<void> {
    await this.repository.deleteEntries(presetId, [...ids])
    this.emit('removed', presetId, [])
  }

  async sources(id: string): Promise<readonly MemorySourceOrigin[]> {
    const record = await this.repository.getEntryById(id)
    if (record === undefined) return []
    return record.sourceOrigins.flatMap((origin) =>
      origin.messages.map((message) => ({
        by: 'extract' as const,
        ...(message.createdAt === undefined ? {} : { at: Date.parse(message.createdAt) }),
        text: message.content
      }))
    )
  }

  /**
   * v2 的索引行按主题聚合，形如 `- people (3): 摘要`。
   * v1 的记录没有主题摘要字段，这里按主题内最新条目生成一行。
   */
  async index(scope: MemoryScope, budget: number): Promise<string> {
    const entries = (await this.list({ presetId: scope.presetId, scope, status: 'active', limit: 10_000 })).items
    const groups = new Map<string, MemoryEntry[]>()
    for (const entry of entries) groups.set(entry.topic, [...(groups.get(entry.topic) ?? []), entry])
    const lines = [...groups]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([topic, items]) => {
        const latest = [...items].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]!
        return `- ${topic} (${items.length}): ${latest.summary ?? latest.title}`
      })
    const text = lines.join('\n')
    const maxChars = budget * 4
    if (text.length <= maxChars) return text
    return `${text.slice(0, Math.max(0, maxChars - 40)).trimEnd()}\n… index truncated; call memory_search for the rest`
  }

  async export(presetId: string): Promise<MemoryExport> {
    const entries = (await this.repository.listEntriesByPreset(presetId)).map(toEntry)
    return { version: 1, presetId, exportedAt: Date.now(), entries }
  }

  /**
   * v2 的导入语义是幂等合并：目标预设内已存在的 id 跳过；同 id 落在其他预设时
   * 换发导入 id（v1 的跨预设导入同样如此），因为记录表以 id 为主键。
   * 含来源与画像的完整预设导入走 v1 自有的 `importPresetData`。
   */
  async import(presetId: string, data: MemoryExport): Promise<void> {
    for (const entry of data.entries) {
      const existing = await this.repository.getEntryById(entry.id)
      if (existing?.presetId === presetId) continue
      await this.repository.createMemory(
        { presetId, conversationId: entry.scope.conversationId ?? '' },
        {
          id: existing === undefined ? entry.id : createPresetImportId('entry', presetId, entry.id),
          type: entry.type,
          status: entry.status,
          topic: entry.topic,
          title: entry.title,
          content: entry.content,
          keywords: [...entry.keywords],
          summary: entry.summary ?? null,
          sentiment: entry.sentiment ?? null,
          importance: entry.importance ?? null,
          fields: entry.fields === undefined ? null : { ...entry.fields }
        },
        [...entry.speakerKeys]
      )
    }
  }

  /** 后端变更通知：原生服务据此刷新任务与状态界面。 */
  watch(listener: (change: MemoryChange) => void): Disposable {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private async listForScope(scope: MemoryScope): Promise<MemoryEntry[]> {
    const entries = await this.repository.listEntriesByPreset(scope.presetId)
    return entries.map(toEntry).filter((entry) => sameScope(entry.scope, scope))
  }

  private emit(kind: MemoryChange['kind'], presetId: string, records: readonly MemoryEntryRecord[]): void {
    if (this.listeners.size === 0) return
    const change: MemoryChange = {
      kind,
      backend: this.id,
      presetId,
      ids: records.map((record) => record.id),
      entries: records.map(toEntry)
    }
    for (const listener of this.listeners) listener(change)
  }
}

function toEntry(record: MemoryEntryRecord): MemoryEntry {
  const scope: MemoryScope = {
    presetId: record.presetId,
    ...(record.sourceConversationId === null ? {} : { conversationId: record.sourceConversationId })
  }
  return {
    id: record.id,
    presetId: record.presetId,
    type: record.type,
    status: record.status,
    topic: record.topic,
    title: titleOf(record),
    content: record.content,
    keywords: [...record.keywords],
    speakerKeys: [...record.speakerKeys],
    sources: record.sourceOrigins.flatMap((origin) =>
      origin.messages.map((message) => ({
        by: 'extract' as const,
        ...(message.createdAt === undefined ? {} : { at: Date.parse(message.createdAt) }),
        text: message.content
      }))
    ),
    scope,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.summary === null ? {} : { summary: record.summary }),
    ...(record.sentiment === null ? {} : { sentiment: record.sentiment }),
    ...(record.importance === null ? {} : { importance: record.importance }),
    ...(record.fields === null ? {} : { fields: record.fields }),
    ...(record.sourceConversationId === null ? {} : { conversationId: record.sourceConversationId })
  }
}

function scopeOf(scope: MemoryScope, conversationId: string): { presetId: string; conversationId: string } {
  return { presetId: scope.presetId, conversationId }
}

function inputOf(input: MemoryInput): MemoryMutationInput {
  return {
    type: input.type ?? 'other',
    topic: input.topic,
    title: input.title,
    content: input.content,
    keywords: input.keywords === undefined ? undefined : [...input.keywords],
    summary: input.summary ?? null,
    sentiment: input.sentiment ?? null,
    importance: input.importance ?? null,
    fields: input.fields === undefined ? null : { ...input.fields }
  }
}

function attached(input: MemoryInput) {
  return { ...attributed(input), sourceOrigins: [] }
}

function attributed(input: MemoryInput) {
  return {
    type: input.type ?? 'other',
    topic: input.topic,
    title: input.title,
    content: input.content,
    keywords: [...(input.keywords ?? [])],
    summary: input.summary ?? '',
    sentiment: input.sentiment ?? '',
    importance: input.importance ?? 0.5,
    speakerKeys: [...(input.speakers ?? [])]
  }
}

function patchOf(patch: MemoryPatch): MemoryUpdatePatch {
  const result: MemoryUpdatePatch = {}
  if (patch.type !== undefined) result.type = patch.type
  if (patch.topic !== undefined) result.topic = patch.topic
  if (patch.title !== undefined) result.title = patch.title
  if (patch.content !== undefined) result.content = patch.content
  if (patch.keywords !== undefined) result.keywords = [...patch.keywords]
  if (patch.summary !== undefined) result.summary = patch.summary
  if (patch.sentiment !== undefined) result.sentiment = patch.sentiment
  if (patch.importance !== undefined) result.importance = patch.importance
  if (patch.fields !== undefined) result.fields = patch.fields
  if (patch.speakers !== undefined) result.speakerKeys = [...patch.speakers]
  if (patch.status !== undefined) result.status = patch.status
  return result
}

function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  return left.presetId === right.presetId && left.conversationId === right.conversationId
}

function searchable(entry: MemoryEntry): string {
  return `${entry.title} ${entry.summary ?? ''} ${entry.content} ${entry.keywords.join(' ')} ${entry.speakerKeys.join(' ')}`.toLowerCase()
}

function countBy<T>(items: readonly T[], keyOf: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of items) {
    const key = keyOf(item)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

function snippetOf(content: string, query: string | undefined) {
  if (query === undefined || query.length === 0) return {}
  const index = content.toLowerCase().indexOf(query)
  if (index < 0) return {}
  const start = Math.max(0, index - 40)
  return { snippet: content.slice(start, start + 120) }
}