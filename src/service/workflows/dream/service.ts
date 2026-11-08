import type { Context } from 'cordis'
import type {} from '@chatluna/ai-runtime'
import type { PresetPersonaResolver } from '../../../contracts/memory.ts'
import type {
    DreamMemoryEntryRecord,
    LivingMemoryConfig
} from '../../../contracts/workflows.ts'
import type { DreamVectorProvider } from '../../../contracts/vector_index.ts'
import type { LivingMemoryMutationService } from '../../app/mutation_service.ts'
import type { LivingMemoryLogger } from '../../logging/logger.ts'
import { formatErrorDetails, isModelConfigured } from '../../shared/utils.ts'
import { SerialTaskQueue } from '../../shared/serial_task_queue.ts'
import { resolveScopeAssistantLabel } from '../../memory/helpers.ts'
import { DreamClusterer } from './clustering.ts'
import type { DreamWorkerRunner } from './worker/protocol.ts'
import {
    buildPostExtractionDreamBatches,
    refreshPostExtractionDreamBatch
} from './post_extraction.ts'
import type { LivingMemorySearchEngine } from '../recall/memory_search_engine.ts'
import type { DreamRunInput, DreamRunResult } from './types.ts'
import {
    createDreamSessionState,
    getDreamCoverage,
    type DreamSessionState
} from './session/state.ts'
import { createDreamSessionTools } from './session/tools.ts'
import { runDreamSession } from './session/runner.ts'
import { dreamCompressionThreshold } from './session/history.ts'

interface DreamRepository {
    listPresetSpeakers(presetId: string): Promise<
        Awaited<
            ReturnType<LivingMemoryMutationService['ensurePresetSpeakersCoverage']>
        >
    >
    listDreamEntriesByPreset(
        presetId: string
    ): Promise<DreamMemoryEntryRecord[]>
    getEntriesByPresetAndIds(
        presetId: string,
        ids: string[]
    ): Promise<{ id: string; status: string; speakerKeys: string[] }[]>
}

type DreamMutations = Pick<
    LivingMemoryMutationService,
    | 'ensurePresetSpeakersCoverage'
    | 'updateActiveMemory'
    | 'mergeActiveMemories'
    | 'splitActiveMemory'
    | 'archiveActiveMemories'
>

/**
 * Dream 服务：规划批次、准备人设与说话人、驱动对话会话，并汇总覆盖情况。
 *
 * 模型调用走插件自己的工具循环（见 `session/runner.ts`），不经过 v2 的对话
 * agent：Dream 的批次状态机、历史压缩与跳过条件都是插件自己的语义。
 */
export class LivingMemoryDreamService {
    private readonly clusterer: DreamClusterer
    private readonly planningQueue = new SerialTaskQueue()

    constructor(
        private readonly ctx: Context,
        private readonly config: Pick<LivingMemoryConfig, 'mainModel'>,
        private readonly repository: DreamRepository,
        private readonly mutations: DreamMutations,
        vectors: DreamVectorProvider,
        worker: DreamWorkerRunner,
        private readonly onOrganized: (
            presetId: string,
            mode: DreamRunInput['mode'],
            speakerKeys?: string[]
        ) => void,
        private readonly presetPersona: PresetPersonaResolver,
        private readonly search: Pick<
            LivingMemorySearchEngine,
            'searchMemoriesDetailed'
        >
    ) {
        this.clusterer = new DreamClusterer(vectors, worker)
    }

    async run(
        presetId: string,
        logger: LivingMemoryLogger,
        signal?: AbortSignal,
        input: DreamRunInput = { mode: 'full' }
    ): Promise<DreamRunResult> {
        signal?.throwIfAborted()
        let state!: DreamSessionState
        let error: string | undefined
        try {
            if (input.mode === 'post-extraction') {
                state = createDreamSessionState(
                    input.memoryIds,
                    'post-extraction'
                )
                const seeds = await this.repository.getEntriesByPresetAndIds(
                    presetId,
                    input.memoryIds
                )
                state.involvedSpeakerKeys = new Set(
                    seeds
                        .filter((entry) => entry.status === 'active')
                        .flatMap((entry) => entry.speakerKeys)
                )
                const plan = await buildPostExtractionDreamBatches(
                    presetId,
                    input.memoryIds,
                    seeds as never,
                    this.repository as never,
                    this.search,
                    logger,
                    signal
                )
                state.batches = plan.batches
                state.untouchedSeedIds = plan.untouchedSeedIds
            } else {
                await this.planningQueue.run('dream-planning', async () => {
                    signal?.throwIfAborted()
                    const entries =
                        await this.repository.listDreamEntriesByPreset(presetId)
                    state = createDreamSessionState(
                        entries.map((entry) => entry.id)
                    )
                    state.batches = await this.clusterer.buildClusters(
                        presetId,
                        entries,
                        logger,
                        signal
                    )
                })
            }
            if (state.batches.length > 0) {
                if (!isModelConfigured(this.config.mainModel)) {
                    throw new Error('Dream mainModel 未配置。')
                }
                const maxTokenLimit = await this.resolveContextLimit()
                signal?.throwIfAborted()
                const presetPrompt =
                    await this.presetPersona.resolveOrGenerateCardText(presetId)
                signal?.throwIfAborted()
                const speakers =
                    await this.mutations.ensurePresetSpeakersCoverage(presetId)
                signal?.throwIfAborted()
                const tools = createDreamSessionTools({
                    presetId,
                    state,
                    speakers,
                    getEntriesByPresetAndIds:
                        this.repository.getEntriesByPresetAndIds.bind(
                            this.repository
                        ),
                    mutations: this.mutations
                })
                await runDreamSession({
                    ctx: this.ctx,
                    model: this.config.mainModel,
                    maxTokenLimit,
                    presetId,
                    assistantLabel: resolveScopeAssistantLabel({
                        presetId
                    }),
                    presetPrompt,
                    speakers,
                    state,
                    tools,
                    logger,
                    ...(signal === undefined ? {} : { signal }),
                    loadBatch:
                        input.mode === 'post-extraction'
                            ? (batch) =>
                                  refreshPostExtractionDreamBatch(
                                      presetId,
                                      batch,
                                      this.repository as never
                                  )
                            : undefined
                })
            }
            signal?.throwIfAborted()
        } catch (cause) {
            // 捕获目标之前的失败交由任务入口记录，之后的失败保留覆盖明细。
            if (state === undefined) throw cause
            error = formatErrorDetails(cause)
        }
        const coverage = getDreamCoverage(state)
        let status: DreamRunResult['status'] = 'completed'
        if (
            error !== undefined ||
            (coverage.processedCount === 0 &&
                (input.mode === 'full' || coverage.targetCount > 0))
        ) {
            status = 'failed'
        } else if (coverage.unprocessedMemoryIds.length > 0) {
            status = 'partial'
        }
        const detail = [
            input.mode === 'full'
                ? `已处理 ${coverage.processedCount}/${coverage.targetCount} 条记忆，共 ${state.batches.length} 个批次。`
                : `各组累计处理 ${coverage.processedCount}/${coverage.targetCount} 项，共 ${state.batches.length} 组。`,
            `检查 ${state.stats.kept} 条，合并 ${state.stats.merged} 次，拆分 ${state.stats.split} 次，更新 ${state.stats.updated} 条，归档 ${state.stats.archived} 条。`,
            ...state.skippedBatches.map(
                (batch) =>
                    `批次 ${batch.batchId} 跳过剩余记忆：${batch.reason}。跳过的记忆 ID：${batch.memoryIds.join('、') || '无'}`
            ),
            ...state.completedBatches.map(
                (batch) =>
                    `批次 ${batch.batchId} 已处理 ${batch.processedCount}/${batch.targetCount} 条。未处理的记忆 ID：${batch.unprocessedMemoryIds.join('、') || '无'}`
            ),
            input.mode === 'post-extraction' ? `未整理的新记忆 ID：${state.untouchedSeedIds.join('、') || '无'}` : '',
            `未处理的记忆 ID：${coverage.unprocessedMemoryIds.join('、') || '无'}`,
            error === undefined ? '' : `失败原因：${error}`
        ]
            .filter(Boolean)
            .join('\n')
        if (error === undefined) {
            this.onOrganized(
                presetId,
                input.mode,
                state.involvedSpeakerKeys === undefined
                    ? undefined
                    : [...state.involvedSpeakerKeys]
            )
        }
        return {
            untouchedSeedIds: state.untouchedSeedIds,
            status,
            entryCount: coverage.targetCount,
            batchCount: state.batches.length,
            processedCount: coverage.processedCount,
            unprocessedMemoryIds: coverage.unprocessedMemoryIds,
            skippedBatches: state.skippedBatches,
            skipped: state.skippedBatches.length,
            ...state.stats,
            error,
            detail
        }
    }

    /**
     * v1 要求 Dream 模型至少 200k 上下文：历史压缩阈值固定为 200k，低于该值
     * 压缩永远不会触发而输入必然溢出。v2 从模型能力读 `contextWindow`，未知
     * 时按该下限处理。
     */
    private async resolveContextLimit(): Promise<number> {
        const caps = await this.ctx.ai.caps<'chat'>(this.config.mainModel)
        const limit = caps.contextWindow ?? dreamCompressionThreshold
        if (limit < dreamCompressionThreshold) {
            throw new Error('Dream 模型最大上下文须至少为 200k tokens。')
        }
        return limit
    }
}
