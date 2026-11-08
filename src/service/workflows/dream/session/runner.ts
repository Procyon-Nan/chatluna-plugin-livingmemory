import type {} from '@chatluna/ai-runtime/ops'
import type { Context } from 'cordis'
import type { PresetSpeakerRecord } from '../../../../contracts/memory.ts'
import type { LivingMemoryLogger } from '../../../logging/logger.ts'
import { formatLogScope } from '../../../logging/logger.ts'
import {
    buildDreamMemoryBatchPrompt,
    buildDreamSystemPrompt,
    buildDreamTurnFeedbackPrompt
} from '../../../prompts/dream.ts'
import { formatErrorDetails } from '../../../shared/utils.ts'
import { LivingMemoryToolLoop } from '../../tool_loop.ts'
import type { LivingMemoryLoopTool } from '../../tool_call.ts'
import type { DreamBatch } from '../types.ts'
import { DreamSessionHistory } from './history.ts'
import {
    advanceDreamBatch,
    pendingDreamMemoryIds,
    recordSkippedDreamBatch,
    recordDreamSpeakers,
    type DreamSessionState
} from './state.ts'

/** 每批最多轮次；连续无有效操作达到上限即跳过本批剩余记忆。 */
const maxBatchRounds = 60
const maxIneffectiveRounds = 3

interface DreamSessionRunInput {
    ctx: Context
    model: string
    /** 模型上下文上限，用于每轮发起前的容量检查。 */
    maxTokenLimit: number
    presetId: string
    assistantLabel: string
    presetPrompt: string
    speakers: readonly PresetSpeakerRecord[]
    state: DreamSessionState
    tools: readonly LivingMemoryLoopTool[]
    logger: LivingMemoryLogger
    signal?: AbortSignal
    loadBatch?: (batch: DreamBatch) => Promise<
        | { entries: DreamBatch['entries']; speakers: PresetSpeakerRecord[] }
        | undefined
    >
}

/**
 * Dream 会话：逐批推进，每批最多 60 轮。每轮由插件决定是否追加推进消息来驱动
 * 下一次模型调用，而不是等模型自然停止；批次状态机、历史压缩与跳过条件沿用
 * v1 语义，因此按 v1 的形状直接驱动 `ctx.chatluna.chat`。
 */
export async function runDreamSession(input: DreamSessionRunInput) {
    const { ctx, model, maxTokenLimit, state, tools, logger, signal } = input
    signal?.throwIfAborted()
    const systemPrompt = buildDreamSystemPrompt(
        input.assistantLabel,
        input.presetPrompt
    )
    const history = new DreamSessionHistory(ctx, model, systemPrompt, logger)
    logger.diagnosticSummary((fields) => ({
        event: 'Dream 会话开始',
        detail: formatLogScope(fields),
        blocks: [{ title: '系统消息', value: systemPrompt }]
    }))

    while (advanceDreamBatch(state) !== undefined) {
        signal?.throwIfAborted()
        let speakers = input.speakers
        if (input.loadBatch) {
            const refreshed = await input.loadBatch(state.currentBatch!)
            signal?.throwIfAborted()
            if (refreshed === undefined) {
                state.untouchedSeedIds.push(state.currentBatch!.seedMemoryId!)
                state.currentBatch = undefined
                continue
            }
            state.currentBatch = {
                ...state.currentBatch!,
                entries: refreshed.entries
            }
            state.availableMemoryIds = new Set(
                refreshed.entries.map((entry) => entry.id)
            )
            speakers = refreshed.speakers
        }
        const batch = state.currentBatch!
        recordDreamSpeakers(
            state,
            batch.entries.flatMap((entry) => entry.speakerKeys)
        )
        const batchLogger = logger.with({ batch: batch.id })
        const batchStartedAt = performance.now()
        const batchPrompt = buildDreamMemoryBatchPrompt(batch, [...speakers])
        history.startBatch(batchPrompt)
        batchLogger.diagnosticSummary((fields) => ({
            event: 'Dream 批次开始',
            detail: `${formatLogScope(fields)}; 批次：${batch.id}; 总批次：${state.batches.length}; 记忆：${batch.entries.length} 条`,
            blocks: [{ title: '用户消息', value: batchPrompt }]
        }))

        const loop = new LivingMemoryToolLoop({
            ctx,
            model,
            system: systemPrompt,
            input: batchPrompt,
            tools,
            logger: batchLogger,
            stage: 'dream',
            multipleToolCalls: 'sequential',
            history: history.history,
            prepareMessages: () => history.prepareMessages(maxTokenLimit, signal),
            onModelCall: ({ fold }) => history.recordUsage(fold.usage),
            ...(signal === undefined ? {} : { signal })
        })
        let ineffectiveRounds = 0
        for (let round = 1; round <= maxBatchRounds; round++) {
            signal?.throwIfAborted()
            let feedback = '请继续处理当前批次。'
            // 本轮是否有工具成功执行；与 v1 一致，重复操作也算有效。
            let effective = false
            try {
                const successfulTools = await loop.runRound(round)
                effective = successfulTools.length > 0
            } catch (error) {
                signal?.throwIfAborted()
                batchLogger.diagnosticSummary((fields) => ({
                    event: 'Dream 本轮处理失败',
                    detail: `${formatLogScope(fields)}; 批次：${batch.id}; 轮次：${round}; 原因：${formatErrorDetails(error)}`
                }))
                feedback = `本轮模型请求或工具执行失败：${formatErrorDetails(error)}`
            }
            signal?.throwIfAborted()

            const pendingAfter = pendingDreamMemoryIds(state)
            ineffectiveRounds = effective ? 0 : ineffectiveRounds + 1
            batchLogger.diagnosticSummary((fields) => ({
                event: 'Dream 本轮处理完成',
                detail: `${formatLogScope(fields)}; 批次：${batch.id}; 轮次：${round}; 已处理：${batch.entries.length - pendingAfter.length}/${batch.entries.length} 条; 连续无有效操作：${ineffectiveRounds} 轮`
            }))
            if (pendingAfter.length === 0) {
                batchLogger.summary(
                    'Dream 批次完成',
                    `${formatLogScope({ presetId: input.presetId })}; 批次：${batch.id}; 处理记忆：${batch.entries.length} 条; 轮次：${round}; 耗时：${((performance.now() - batchStartedAt) / 1000).toFixed(3)} 秒`
                )
                break
            }
            if (
                ineffectiveRounds >= maxIneffectiveRounds ||
                round === maxBatchRounds
            ) {
                const reason =
                    ineffectiveRounds >= maxIneffectiveRounds
                        ? '连续 3 轮无有效操作'
                        : '达到每批 60 轮上限'
                recordSkippedDreamBatch(state, reason)
                // 跳过原因写入历史，让下一批开始时模型知道上一批为何中断。
                history.appendUser(
                    buildDreamTurnFeedbackPrompt(
                        pendingAfter,
                        `${feedback}\n${reason}，跳过本批剩余记忆并进入下一批。`
                    )
                )
                logger.summary(
                    'Dream 跳过批次剩余记忆',
                    `预设：${input.presetId}; 批次：${batch.id}; 原因：${reason}; 已处理：${batch.entries.length - pendingAfter.length}/${batch.entries.length} 条; 跳过：${pendingAfter.length} 条`,
                    'warn'
                )
                break
            }
            history.appendUser(
                buildDreamTurnFeedbackPrompt(pendingAfter, feedback)
            )
        }
    }
}
