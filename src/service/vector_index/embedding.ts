import type { MemoryIndexSourceRecord } from '../../contracts/vector_index.ts'

export interface EmbeddingsLike {
    embedDocuments(texts: string[]): Promise<number[][]>
    embedQuery(text: string): Promise<number[]>
}

const VECTOR_INDEX_PROBE_TEXT = 'living memory vector index dimension probe'

export interface VectorIndexEmbeddingContext {
    embeddings: EmbeddingsLike
    dimension: number
}

const convertValidVector = (
    vector: number[],
    dimension: number
): Float32Array<ArrayBuffer> | null => {
    if (
        vector.length !== dimension ||
        vector.some((value) => !Number.isFinite(value))
    ) {
        return null
    }
    const converted = new Float32Array(vector)
    if (
        converted.some((value) => !Number.isFinite(value)) ||
        !converted.some((value) => value !== 0)
    ) {
        return null
    }
    return converted
}

export const createVectorIndexVector = (
    vector: number[],
    dimension: number,
    subject: string
) => {
    const converted = convertValidVector(vector, dimension)
    if (converted === null) {
        throw new Error(
            `vector index embedding invalid: ${subject}, dimension=${dimension}`
        )
    }
    return converted
}

export const probeVectorIndexDimension = async (embeddings: EmbeddingsLike) => {
    const vectors = await embeddings.embedDocuments([VECTOR_INDEX_PROBE_TEXT])
    if (vectors.length !== 1 || vectors[0].length === 0) {
        throw new Error('vector index embedding probe returned no vector')
    }
    createVectorIndexVector(
        vectors[0],
        vectors[0].length,
        'subject=dimension-probe'
    )
    return vectors[0].length
}

export const embedMemoryIndexSources = async (
    embeddings: EmbeddingsLike,
    dimension: number,
    sources: MemoryIndexSourceRecord[]
) => {
    if (!sources.length) return []
    const vectors = await embeddings.embedDocuments(
        sources.map((source) => source.content)
    )
    if (vectors.length !== sources.length) {
        throw new Error(
            `vector index embedding count mismatch: expected=${sources.length}, actual=${vectors.length}`
        )
    }
    return sources.map((source, index) => ({
        source,
        vector: createVectorIndexVector(
            vectors[index],
            dimension,
            `memory=${source.id}`
        )
    }))
}
