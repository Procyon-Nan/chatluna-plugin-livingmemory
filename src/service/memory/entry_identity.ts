import type { MemoryEntryRecord, MemoryMutationInput } from '../../contracts/memory.ts'

/**
 * v1 的记忆没有主题与标题：提取器只产出 type/content/keywords/summary/sentiment/importance。
 * v2 的索引按主题分组、按标题列出条目，因此这里为 v1 输入补出确定性的映射：
 *
 * - 主题取记忆类型，与 v2 在缺省场景下的粒度一致（一条记忆只描述一个主题或事件）；
 * - 标题取调用方显式值，其次摘要，再次内容首行。三者都为空时退回 id 的短前缀。
 *
 * 该映射只在写入时确定一次，之后随记录持久化，不在读取侧重新推导。
 */
export const DEFAULT_MEMORY_TOPIC = 'other'
const TITLE_MAX_CHARS = 80

export function normalizeMemoryTopic(input: Pick<MemoryMutationInput, 'type' | 'topic'>): string {
  const explicit = input.topic?.trim()
  return explicit === undefined || explicit.length === 0 ? input.type : explicit
}

export function normalizeMemoryTitle(
  input: Pick<MemoryMutationInput, 'title' | 'summary'>,
  content: string,
  id = ''
): string {
  const explicit = input.title?.trim()
  if (explicit !== undefined && explicit.length > 0) return explicit
  const summary = input.summary?.trim()
  if (summary !== undefined && summary.length > 0) return summary
  const firstLine = content.split('\n')[0]?.trim() ?? ''
  if (firstLine.length > 0) return firstLine.slice(0, TITLE_MAX_CHARS)
  return id.slice(0, 8)
}

/** 读取侧补齐旧行缺失的标题：旧行 title 为 null，按同样的规则从内容派生。 */
export function titleOf(entry: Pick<MemoryEntryRecord, 'id' | 'title' | 'summary' | 'content'>): string {
  if (entry.title !== null) return entry.title
  return normalizeMemoryTitle({ title: undefined, summary: entry.summary }, entry.content, entry.id)
}