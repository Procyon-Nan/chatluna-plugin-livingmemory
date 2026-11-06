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
import type {
  MemoryEntryRecord,
  MemoryMutationInput,
  MemoryUpdatePatch,
  MemoryScope as LivingMemoryScope
} from '../contracts/memory.ts'
import type { MemoryBackendScheduling } from '../contracts/framework.ts'
import type { LivingMemoryMutationService } from './app/mutation_service.ts'
import { formatLogScope, type LivingMemoryLogger } from './logging/logger.ts'
import { titleOf } from './memory/entry_identity.ts'
import { createPresetImportId } from './persistence/normalizers.ts'
import type { LivingMemoryRepository } from './persistence/repository.ts'

/**
 * LivingMemory 的 `ctx.memory` 后端。
 *
 * v1 的业务能力（消息池、提取、召回、Dream、画像、索引）仍由插件自身的工作流承担；
 * 这里把 v2 定义的后端契约映射到插件的持久化仓储与变更服务，使原生工具、管理界面
 * 与路由能够把 LivingMemory 当作普通后端使用。
 *
 * 写操作全部委托 `LivingMemoryMutationService`：预设级串行队列、索引就绪预检与
 * 落库后的索引同步只在该服务内实现。后端直接写仓储会让索引与主数据脱节，下一次
 * 变更的条数校验随即失败并把预设标记为 dirty。
 */
export class LivingMemoryBackend implements MemoryBackend {
  readonly id = 'livingmemory'
  readonly label = 'LivingMemory'
  /**
   * 自动流程归属（M01-C1）：三个入口都由插件自己的协调器驱动，原生对应入口
   * 让出调度。原生手动入口（`ctx.memory.extract`、`ctx.memory.dream`）不受影响。
   */
  readonly scheduling: MemoryBackendScheduling = {
    extract: true,
    dream: true,
    recall: true
  }

  private readonly listeners = new Set<(change: MemoryChange) => void>()

  constructor(
    private readonly repository: LivingMemoryRepository,
    private readonly mutations: LivingMemoryMutationService,
    private readonly logger: LivingMemoryLogger
  ) {}

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
      records.push(await this.mutations.createMemory(scopeOf(scope), inputOf(item), speakerKeysOf(item)))
    }
    const entries = records.map(toEntry)
    this.emit('created', scope.presetId, entries)
    return entries
  }

  async update(id: string, patch: MemoryPatch): Promise<MemoryEntry> {
    const updated = await this.mutations.updateMemory(id, patchOf(patch))
    if (updated === null) throw new Error(`no such memory: ${id}`)
    const entry = toEntry(updated.record)
    this.emit('updated', updated.record.presetId, [entry])
    return entry
  }

  async merge(presetId: string, ids: readonly string[], into: MemoryInput): Promise<MemoryEntry> {
    const merged = await this.mutations.mergeActiveMemories(presetId, [...ids], attributed(into))
    this.reportWarnings(presetId, merged.warnings)
    const entry = toEntry(merged.memory)
    this.emitIds('updated', presetId, [...ids, entry.id], [entry])
    return entry
  }

  async split(presetId: string, id: string, into: readonly MemoryInput[]): Promise<readonly MemoryEntry[]> {
    const split = await this.mutations.splitActiveMemory(presetId, id, into.map(attributed))
    this.reportWarnings(presetId, split.warnings)
    const entries = split.memories.map(toEntry)
    this.emitIds('updated', presetId, [id, ...entries.map((entry) => entry.id)], entries)
    return entries
  }

  async archive(presetId: string, ids: readonly string[]): Promise<void> {
    const result = await this.mutations.archiveActiveMemories(presetId, [...ids])
    if (result.archived === 0) return
    const archived = (
      await this.repository.getEntriesByPresetAndIds(presetId, [...ids])
    ).filter((record) => record.status === 'archived')
    this.emit('archived', presetId, archived.map(toEntry))
  }

  async remove(presetId: string, ids: readonly string[]): Promise<void> {
    // 先取本预设内真实存在的 id：跨预设与已删除的 id 由变更服务幂等跳过，
    // 通知里只应出现真正被删除的条目。
    const known = await this.repository.getEntriesByPresetAndIds(presetId, [...ids])
    if (known.length === 0) return
    await this.mutations.deleteMemories(presetId, known.map((record) => record.id))
    // 记录已删除，变更只携带 id：原生消费者会把 `entries` 的内容回写到自己的状态，
    // 带上已删除的条目会让它们复活。
    this.emitIds('removed', presetId, known.map((record) => record.id))
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
   * v2 的导入语义是幂等合并：目标预设内已存在的条目跳过；同 id 落在其他预设时
   * 换发导入 id（v1 的跨预设导入同样如此），因为记录表以 id 为主键。
   * 含来源与画像的完整预设导入走 v1 自有的 `importPresetData`。
   *
   * 迁移 id 由「目标预设 + 源 id」确定性推导，所以「目标 id 已被占用」就是
   * 「这批数据已经导入过」的判据；只看源 id 会让第二次导入重复写入同一个 id。
   */
  async import(into: MemoryScope, data: MemoryExport): Promise<number> {
    const written: MemoryEntryRecord[] = []
    for (const entry of data.entries) {
      const targetId = await this.resolveImportId(into.presetId, entry.id)
      if (targetId === null) continue
      written.push(await this.mutations.createMemory(scopeOf(into, entry.scope.conversationId ?? ''), importInputOf(entry, targetId), [...entry.speakerKeys]))
    }
    if (written.length > 0) this.emit('created', into.presetId, written.map(toEntry))
    return written.length
  }

  /** 返回可写入的 id；目标已有同名记录时返回 `null` 表示跳过。 */
  private async resolveImportId(presetId: string, entryId: string): Promise<string | null> {
    const existing = await this.repository.getEntryById(entryId)
    const targetId =
      existing === undefined || existing.presetId === presetId
        ? entryId
        : createPresetImportId('entry', presetId, entryId)
    return (await this.repository.getEntryById(targetId)) === undefined ? targetId : null
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

  /**
   * 合并与拆分的结果里包含「事实已提交、索引同步失败」的警告。后端契约没有
   * 警告通道，写入本身已经成功，这里只把提示写进日志，由后台对账修复索引。
   */
  private reportWarnings(presetId: string, warnings: readonly string[]): void {
    if (warnings.length === 0) return
    this.logger.summary(
      '记忆写入后索引同步失败',
      [formatLogScope({ presetId }), ...warnings].join('; '),
      'warn'
    )
  }

  private emit(kind: MemoryChange['kind'], presetId: string, entries: readonly MemoryEntry[]): void {
    this.emitIds(kind, presetId, entries.map((entry) => entry.id), entries)
  }

  private emitIds(
    kind: MemoryChange['kind'],
    presetId: string,
    ids: readonly string[],
    entries?: readonly MemoryEntry[]
  ): void {
    if (this.listeners.size === 0) return
    const change: MemoryChange = {
      kind,
      backend: this.id,
      presetId,
      ids,
      ...(entries === undefined ? {} : { entries })
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

/**
 * v2 的作用域允许缺省会话；插件侧把空会话当作「无会话上下文」落库，
 * 这里统一补成空串，保持与手工创建记忆相同的语义。
 */
function scopeOf(scope: MemoryScope, conversationId = scope.conversationId ?? ''): LivingMemoryScope {
  return {
    presetId: scope.presetId,
    conversationId,
    ...(scope.platform === undefined ? {} : { platform: scope.platform }),
    ...(scope.guildId === undefined ? {} : { guildId: scope.guildId }),
    ...(scope.channelId === undefined ? {} : { channelId: scope.channelId }),
    ...(scope.userId === undefined ? {} : { userId: scope.userId }),
    ...(scope.speakerId === undefined ? {} : { speakerId: scope.speakerId }),
    ...(scope.isDirect === undefined ? {} : { isDirect: scope.isDirect })
  }
}

function inputOf(input: MemoryInput): MemoryMutationInput {
  return {
    ...(input.id === undefined ? {} : { id: input.id }),
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

/**
 * 导入按原样保留条目字段：状态、时间之外的展示字段不做归一推导，
 * 只把 v2 导出里缺省的可选项映射成仓储的空值形态。
 */
function importInputOf(entry: MemoryEntry, id: string): MemoryMutationInput {
  return {
    id,
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
  }
}

/**
 * 显式说话人优先；省略或为空时交由变更服务按 scope 推导，与仓储侧的
 * 「键从 scope 来」保持同一条规则。
 */
function speakerKeysOf(input: MemoryInput): string[] | undefined {
  return input.speakers === undefined || input.speakers.length === 0 ? undefined : [...input.speakers]
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