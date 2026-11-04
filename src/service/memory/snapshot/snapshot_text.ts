import type { AgenticMemorySnapshotItem } from '../../../contracts/memory.ts'

export const renderSnapshotText = (
    items: readonly AgenticMemorySnapshotItem[]
) => {
    return items
        .map((item) => item.finalText.trim())
        .filter((text) => text.length > 0)
        .join('\n')
}