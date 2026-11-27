import { modelMemoryIds, type MemoryIdSource } from '../model_ids.ts'

export async function mergeToolResult(
    source: MemoryIdSource, presetId: string, archived: string[], result: { memory: { id: string }; warnings: string[] }
) {
    const id = result.memory.id
    const { display } = await modelMemoryIds(source, presetId, [id, ...archived], result.warnings)
    return { memoryId: display(id), archivedMemoryIds: archived.map(display), merged: true, warnings: result.warnings }
}

export async function splitToolResult(
    source: MemoryIdSource, presetId: string, archived: string, result: { memories: { id: string }[]; warnings: string[] }
) {
    const ids = result.memories.map(memory => memory.id)
    const { display } = await modelMemoryIds(source, presetId, [archived, ...ids], result.warnings)
    return { memoryIds: ids.map(display), archivedMemoryId: display(archived), split: true, warnings: result.warnings }
}
