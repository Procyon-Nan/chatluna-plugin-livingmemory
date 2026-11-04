import type { Context } from 'cordis'
import type {} from '@chatluna/ai-runtime/ops'
import type {
    LivingMemorySearchDetailedResult,
    LivingMemorySearchInput,
    LivingMemorySearchResult,
    MemoryEntryType
} from '../../../contracts/memory.ts'
import type { MemoryVectorSearch } from '../../../contracts/vector_index.ts'
import type {
    LivingMemoryConfig,
    LivingMemorySearchProvider,
    RecallRepository
} from '../../../contracts/workflows.ts'
import { formatLogScope, type LivingMemoryLogger } from '../../logging/logger.ts'
import { isModelConfigured } from '../../shared/utils.ts'
import { loadIndexedMemoryEntries } from './indexed_entries.ts'

type MemorySearchConfig = Pick<
    LivingMemoryConfig,
    'memorySearchToolMaxResults' | 'memorySearchMinSimilarity' | 'rerankModel'
>

/** 配置了 Reranker 时，混合检索候选量按结果上限扩大该倍数后再重排。 */
const RERANK_CANDIDATE_MULTIPLIER = 3

const resolveMemoryTypes = (
    input: LivingMemorySearchInput
): MemoryEntryType[] | null => {
    if (input.memoryTypes.includes('all')) {
        return null
    }
    return input.memoryTypes as MemoryEntryType[]
}

export class LivingMemorySearchEngine implements LivingMemorySearchProvider {
    constructor(
        private readonly ctx: Context,
        private readonly config: MemorySearchConfig,
        private readonly repository: RecallRepository,
        private readonly vectorSearch: MemoryVectorSearch,
        private readonly logger: LivingMemoryLogger
    ) {}

    async searchMemories(
        presetId: string,
        input: LivingMemorySearchInput,
        conversationId?: string
    ): Promise<LivingMemorySearchResult[]> {
        const detailed = await this.searchMemoriesDetailed(
            presetId,
            input,
            conversationId
        )
        return detailed.map((entry) => ({
            id: entry.id,
            type: entry.type,
            content: entry.content,
            keywords: [...entry.keywords],
            summary: entry.summary,
            sentiment: entry.sentiment,
            importance: entry.importance,
            sourceLabel: entry.sourceLabel,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt
        }))
    }

    async searchMemoriesDetailed(
        presetId: string,
        input: LivingMemorySearchInput,
        conversationId?: string,
        excludedMemoryIds?: string[]
    ): Promise<LivingMemorySearchDetailedResult[]> {
        const limit = this.config.memorySearchToolMaxResults
        const hasReranker = isModelConfigured(this.config.rerankModel)
        const hits = await this.vectorSearch.searchHybrid({
            presetId,
            conversationId,
            excludedMemoryIds,
            searchTexts: input.searchTexts,
            keywords: input.searchKeywords ?? [],
            memoryTypes: resolveMemoryTypes(input),
            memoryStatus: input.memoryStatus ?? 'active',
            maxCandidates: hasReranker
                ? limit * RERANK_CANDIDATE_MULTIPLIER
                : limit,
            minSimilarity: this.config.memorySearchMinSimilarity
        })
        const entries = await loadIndexedMemoryEntries(
            this.repository,
            presetId,
            hits.map((hit) => hit.memoryId)
        )
        const results = entries.map((entry, index) => {
            const hit = hits[index]
            return {
                id: entry.id,
                type: entry.type,
                content: entry.content,
                keywords: [...entry.keywords],
                summary: entry.summary,
                sentiment: entry.sentiment,
                importance: entry.importance,
                sourceLabel: entry.sourceLabel,
                createdAt: entry.createdAt,
                updatedAt: entry.updatedAt,
                cosineScore: hit.cosineScore,
                keywordMatchCount: hit.keywordMatchCount,
                boostedScore: hit.boostedScore,
                rerankScore: null
            }
        })
        if (!hasReranker || results.length === 0) {
            return results
        }

        try {
            return await this.rerank(input.searchTexts, results, limit)
        } catch (error) {
            this.logger.summary(
                '记忆重排序降级',
                `${formatLogScope({ presetId, conversationId })}; 模型：${this.config.rerankModel}; 结果：重排序失败，沿用混合检索排序`,
                'warn',
                error
            )
            return results.slice(0, limit)
        }
    }

    /**
     * 每条查询短语各自重排一次，候选取各次得分的最大值，与混合检索多向量
     * 取最大的合并口径一致；未被任何一次重排返回的候选不进入结果。
     */
    private async rerank(
        searchTexts: string[],
        candidates: LivingMemorySearchDetailedResult[],
        limit: number
    ): Promise<LivingMemorySearchDetailedResult[]> {
        const documents = candidates.map((candidate) => candidate.content)
        // v2 的 `ctx.chatluna.rerank` 返回按输入顺序排列的分数；v1 的 langchain
        // Reranker 返回 (index, relevanceScore) 对。这里按同样的口径取每条查询
        // 短语对应候选的分数，再取各次最大值。
        const rankings = await Promise.all(
            searchTexts.map((searchText) =>
                this.ctx.chatluna.rerank(searchText, documents, {
                    model: this.config.rerankModel,
                    topN: documents.length
                })
            )
        )
        const bestScores = new Map<number, number>()
        for (const ranking of rankings) {
            if (ranking.scores.length !== candidates.length) {
                throw new Error(
                    `memory rerank score count mismatch: ` +
                        `expected=${candidates.length}, actual=${ranking.scores.length}`
                )
            }
            for (const [index, relevanceScore] of ranking.scores.entries()) {
                bestScores.set(
                    index,
                    Math.max(bestScores.get(index) ?? -Infinity, relevanceScore)
                )
            }
        }

        return [...bestScores]
            .sort(
                ([leftIndex, leftScore], [rightIndex, rightScore]) =>
                    rightScore - leftScore || leftIndex - rightIndex
            )
            .slice(0, limit)
            .map(([index, rerankScore]) => ({
                ...candidates[index],
                rerankScore
            }))
    }
}
