import type { LivingMemoryRepository } from '../../persistence/repository.ts'
import type { LivingMemorySearchEngine } from '../recall/memory_search_engine.ts'
import type { DreamBatch } from './types.ts'
import type { MemoryEntryRecord } from '../../../contracts/memory.ts'

export async function buildPostExtractionDreamBatches(
    presetId: string,
    memoryIds: string[],
    seeds: MemoryEntryRecord[],
    repository: Pick<LivingMemoryRepository, 'getEntriesByPresetAndIds'>,
    search: Pick<LivingMemorySearchEngine, 'searchMemoriesDetailed'>,
    signal?: AbortSignal
) {
    const seedById = new Map(seeds.map((entry) => [entry.id, entry]))
    const groups: { seedMemoryId: string; memoryIds: string[] }[] = []
    const untouchedSeedIds: string[] = []
    for (const id of memoryIds) {
        signal?.throwIfAborted()
        const seed = seedById.get(id)
        if (seed === undefined || seed.status !== 'active') {
            untouchedSeedIds.push(id)
            continue
        }
        const hits = await search.searchMemoriesDetailed(
            presetId,
            {
                searchTexts: [seed.content],
                searchKeywords: [],
                memoryTypes: ['all'],
                memoryStatus: 'active'
            },
            undefined,
            memoryIds
        )
        signal?.throwIfAborted()
        if (hits.length === 0) {
            untouchedSeedIds.push(id)
            continue
        }
        groups.push({
            seedMemoryId: id,
            memoryIds: [id, ...hits.map((hit) => hit.id)]
        })
    }

    const entries = await repository.getEntriesByPresetAndIds(presetId, [
        ...new Set(groups.flatMap((group) => group.memoryIds))
    ])
    const activeById = new Map(
        entries
            .filter((entry) => entry.status === 'active')
            .map((entry) => [entry.id, entry])
    )
    const batches: (DreamBatch & { seedMemoryId: string })[] = []
    for (const group of groups) {
        const members = group.memoryIds.flatMap((id) => {
            const entry = activeById.get(id)
            return entry === undefined ? [] : [entry]
        })
        if (!activeById.has(group.seedMemoryId) || members.length <= 1) {
            untouchedSeedIds.push(group.seedMemoryId)
            continue
        }
        batches.push({
            id: `post-extraction:${group.seedMemoryId}`,
            seedMemoryId: group.seedMemoryId,
            entries: members
        })
    }
    return {
        batches,
        untouchedSeedIds
    }
}

export async function refreshPostExtractionDreamBatch(
    presetId: string,
    batch: DreamBatch,
    repository: Pick<
        LivingMemoryRepository,
        'getEntriesByPresetAndIds' | 'listPresetSpeakers'
    >
) {
    const records = await repository.getEntriesByPresetAndIds(
        presetId,
        batch.entries.map((entry) => entry.id)
    )
    const active = new Map(
        records
            .filter((entry) => entry.status === 'active')
            .map((entry) => [entry.id, entry])
    )
    const entries = batch.entries.flatMap((entry) => {
        const current = active.get(entry.id)
        return current === undefined ? [] : [current]
    })
    if (!active.has(batch.seedMemoryId!) || entries.length <= 1) return
    return { entries, speakers: await repository.listPresetSpeakers(presetId) }
}
