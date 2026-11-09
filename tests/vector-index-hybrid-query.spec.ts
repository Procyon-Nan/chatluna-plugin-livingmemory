import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import type {
    VectorIndexHybridQuery,
    VectorIndexKnnHit
} from '../src/service/vector_index/worker_protocol.ts'
import { queryVectorIndexHybrid } from '../src/service/vector_index/worker/queries.ts'

interface QueryCall {
    text: string
    parameters: unknown[] | undefined
}

const createQuery = (
    options: Partial<VectorIndexHybridQuery> = {}
): VectorIndexHybridQuery => ({
    presetId: 'preset-a',
    types: null,
    memoryStatus: 'active',
    limit: 2,
    vector: new Float32Array([1, 0, 0]),
    keywords: ['alpha', 'beta'],
    minSimilarity: 0.5,
    ...options
})

const createDatabase = (
    semanticHits: VectorIndexKnnHit[],
    keywordRows: Array<{
        memoryId: string
        cosineScore: number | null
        matchCount: string
    }>
) => {
    const calls: QueryCall[] = []
    const database = {
        query: async (text: string, parameters?: unknown[]) => {
            calls.push({ text, parameters })
            return {
                rows: text.includes('FROM lm_index_keywords')
                    ? keywordRows
                    : semanticHits
            }
        }
    } as unknown as PGlite
    return { database, calls }
}

it('reuses semantic scores for keyword candidates in the top-k intersection', async () => {
    const semanticHits = [
        { memoryId: 'semantic-alpha', cosineScore: 0.9 },
        { memoryId: 'semantic-only', cosineScore: 0.8 }
    ]
    const keywordRows = [
        {
            memoryId: 'semantic-alpha',
            cosineScore: null,
            matchCount: '2'
        },
        { memoryId: 'keyword-high', cosineScore: 0.7, matchCount: '1' },
        { memoryId: 'keyword-low', cosineScore: 0.2, matchCount: '1' }
    ]
    const { database, calls } = createDatabase(semanticHits, keywordRows)

    const result = await queryVectorIndexHybrid(database, createQuery())

    assert.deepEqual(result, [
        {
            memoryId: 'semantic-alpha',
            cosineScore: 0.9,
            keywordMatchCount: 2,
            boostedScore: 1.2
        },
        {
            memoryId: 'keyword-high',
            cosineScore: 0.7,
            keywordMatchCount: 1,
            boostedScore: 0.85
        }
    ])
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[1].parameters?.at(-1), [
        'semantic-alpha',
        'semantic-only'
    ])
})

it('orders equal hybrid scores by memory id', async () => {
    const semanticHits = [
        { memoryId: 'semantic-keyword', cosineScore: 0.4 },
        { memoryId: 'semantic-only', cosineScore: 0.6 }
    ]
    const keywordRows = [
        {
            memoryId: 'semantic-keyword',
            cosineScore: null,
            matchCount: '1'
        },
        { memoryId: 'keyword-b', cosineScore: 0.1, matchCount: '1' },
        { memoryId: 'keyword-a', cosineScore: 0.1, matchCount: '1' }
    ]
    const { database } = createDatabase(semanticHits, keywordRows)
    const result = await queryVectorIndexHybrid(database, createQuery({ minSimilarity: 0, limit: 4 }))

    assert.deepEqual(result.map((hit) => [hit.memoryId, hit.cosineScore, hit.keywordMatchCount, hit.boostedScore]), [
        ['semantic-only', 0.6, 0, 0.6],
        ['semantic-keyword', 0.4, 1, 0.55],
        ['keyword-a', 0.1, 1, 0.25],
        ['keyword-b', 0.1, 1, 0.25]
    ])
})

it('keeps the semantic-only path unchanged for empty normalized keywords', async () => {
    const semanticHits = [
        { memoryId: 'above-threshold', cosineScore: 0.8 },
        { memoryId: 'below-threshold', cosineScore: 0.4 }
    ]
    const { database, calls } = createDatabase(semanticHits, [])

    const result = await queryVectorIndexHybrid(
        database,
        createQuery({ keywords: ['  ', ''], minSimilarity: 0.5 })
    )

    assert.deepEqual(result, [
        {
            memoryId: 'above-threshold',
            cosineScore: 0.8,
            keywordMatchCount: 0,
            boostedScore: 0.8
        }
    ])
    assert.equal(calls.length, 1)
})

it('excludes extraction IDs in both SQL candidate paths before the result limit', async () => {
    const { database, calls } = createDatabase([], [])
    await queryVectorIndexHybrid(
        database,
        createQuery({ excludedMemoryIds: ['new-a', 'new-b'] })
    )
    assert.equal(calls.length, 2)
    for (const call of calls) {
        assert.match(call.text, /memory_id <> ALL\(\$3::text\[\]\)/u)
        assert.deepEqual(call.parameters?.[2], ['new-a', 'new-b'])
    }
    assert.ok(
        calls[0].text.indexOf('memory_id <> ALL') <
            calls[0].text.indexOf('LIMIT')
    )
})
