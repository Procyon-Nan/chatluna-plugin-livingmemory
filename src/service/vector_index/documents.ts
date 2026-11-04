import type { MemoryIndexSourceRecord } from '../../contracts/vector_index.ts'
import type { VectorIndexDocument } from './worker_protocol.ts'
import { createMemoryIndexHashes } from './hashes.ts'

export const createVectorIndexDocument = (
    source: MemoryIndexSourceRecord
): VectorIndexDocument => ({
    memoryId: source.id,
    presetId: source.presetId,
    sourceConversationId: source.sourceConversationId,
    status: source.status,
    type: source.type,
    ...createMemoryIndexHashes(source),
    keywords: source.keywords,
    updatedAt: +source.updatedAt
})
