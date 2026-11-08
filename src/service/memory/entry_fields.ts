import { MAX_MEMORY_KEYWORDS } from '../../contracts/memory.ts'
import type { AttributedMemoryItem, ExtractedMemoryItem } from '../../contracts/workflows.ts'

export { MAX_MEMORY_KEYWORDS }
export const DEFAULT_MEMORY_IMPORTANCE = 0.5

export const normalizeMemoryText = (value: string) => value.trim()

export const normalizeOptionalMemoryText = (value: string | null | undefined) =>
    value?.trim() || null

export const normalizeMemoryKeywords = (
    value: readonly string[] = []
): string[] => {
    const keywords: string[] = []
    const seen = new Set<string>()
    for (const item of value) {
        const keyword = normalizeMemoryText(item)
        if (keyword.length === 0 || seen.has(keyword)) {
            continue
        }

        keywords.push(keyword)
        seen.add(keyword)
        if (keywords.length === MAX_MEMORY_KEYWORDS) {
            break
        }
    }

    return keywords
}

export const normalizeMemoryImportance = (
    value: number | null | undefined
): number | null => (value == null ? null : Math.min(1, Math.max(0, value)))

/** 只将工具可编辑的六个字段传给仓储。说话人昵称由调用方按预设解析。 */
export const toMemoryFields = (memory: ExtractedMemoryItem) => ({
    type: memory.type,
    content: memory.content,
    summary: memory.summary,
    keywords: memory.keywords,
    sentiment: memory.sentiment,
    importance: memory.importance
})

export const toAttributedMemory = (memory: ExtractedMemoryItem, speakerKeys: string[]): AttributedMemoryItem =>
    ({ ...toMemoryFields(memory), speakerKeys })
