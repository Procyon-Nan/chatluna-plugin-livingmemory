import { addAbortListener } from 'node:events'
import type { ChatSpecMessage } from '@chatluna/ai'
import type {} from '@chatluna/ai-runtime/ops'
import type { Context } from 'cordis'
import { estimateMessageTokens } from '@chatluna/utils'
import { formatLogScope, type LivingMemoryLogger } from '../../../logging/logger.ts'
import { modelCallLogging } from '../../../logging/model_calls.ts'
import { buildDreamHistorySummaryPrompts } from '../../../prompts/dream.ts'
import { formatXmlBlock } from '../../../prompts/prompt_format.ts'
import { textBlocks, type LivingMemoryChatHistory } from '../../tool_call.ts'

/** 达到该输入量即压缩更早批次；低于此值的会话不做处理。 */
export const dreamCompressionThreshold = 200_000

/**
 * system 固定，当前批次不参与压缩；
 * 达到阈值时把更早批次摘要成一条 `<dream_history_summary>` 消息。
 *
 * 历史对象直接交给工具循环持有，循环在它上面追加消息。
 */
export class DreamSessionHistory implements LivingMemoryChatHistory {
    messages: ChatSpecMessage[] = []
    private readonly systemTokens: number
    private batchStart = 0
    private inputTokens: number | undefined
    private compressions = 0

    constructor(
        private readonly ctx: Context,
        private readonly model: string,
        systemPrompt: string,
        private readonly logger: LivingMemoryLogger
    ) {
        // 系统词通过 chat.system 单独发送，计入预算一次。
        this.systemTokens = estimateMessageTokens({ content: textBlocks(systemPrompt) })
    }

    /** 记录上一轮模型上报的输入量；缺失或无效时保留上一次有效值。 */
    recordUsage(usage: { inputTokens?: number } | undefined) {
        const tokens = usage?.inputTokens
        if (tokens !== undefined && Number.isFinite(tokens) && tokens > 0) {
            this.inputTokens = tokens
        }
    }

    startBatch(input: string) {
        this.batchStart = this.messages.length
        this.messages.push({ role: 'user', content: textBlocks(input) })
    }

    /** 追加一条推进消息，推动模型处理本批剩余记忆。 */
    appendUser(input: string) {
        this.messages.push({ role: 'user', content: textBlocks(input) })
    }

    /**
     * 发起下一轮前的历史：必要时先压缩更早批次，再检查是否超过模型上下文。
     * 超限时抛出，避免宿主静默裁剪当前批次。
     */
    async prepareMessages(
        maxTokenLimit: number,
        signal?: AbortSignal
    ): Promise<readonly ChatSpecMessage[]> {
        signal?.throwIfAborted()
        if (
            this.inputTokens !== undefined &&
            this.inputTokens >= dreamCompressionThreshold
        ) {
            await this.summarizeEarlierBatches(this.inputTokens, signal)
        }
        signal?.throwIfAborted()
        const tokens = this.messages.reduce(
            (total, message) => total + estimateMessageTokens(message),
            this.systemTokens
        )
        if (tokens > maxTokenLimit) {
            throw new Error(`Dream 输入超过模型可用预算：${tokens} tokens。`)
        }
        return this.messages
    }

    private async summarizeEarlierBatches(
        tokensBefore: number,
        signal?: AbortSignal
    ) {
        if (this.batchStart === 0) {
            throw new Error(
                '当前 Dream 批次已达到 200k，且没有可压缩的更早批次。'
            )
        }
        const transcript = JSON.stringify(
            this.messages.slice(0, this.batchStart)
        )
        const attempt = ++this.compressions
        this.logger.diagnosticSummary((fields) => ({
            event: 'Dream 上下文压缩开始',
            detail: `${formatLogScope(fields)}; 压缩序号：${attempt}; 压缩前输入量：${tokensBefore} tokens`
        }))
        const prompt = buildDreamHistorySummaryPrompts(transcript)
        signal?.throwIfAborted()
        const log = modelCallLogging(this.logger, 'dream-compression', attempt)
        const run = this.ctx.chatluna.chat({
            model: this.model,
            system: prompt.systemPrompt,
            messages: [
                { role: 'user', content: textBlocks(prompt.inputPrompt) }
            ],
            beforeDispatch: log.beforeDispatch
        })
        using cancellation = signal && addAbortListener(signal, () => run.abort(signal.reason))
        const fold = await run
        log.response(fold)
        signal?.throwIfAborted()
        const summary = fold.text.trim()
        if (!summary) {
            throw new Error('Dream 历史压缩未返回有效摘要。')
        }
        this.messages = [
            {
                role: 'user',
                content: textBlocks(
                    formatXmlBlock('dream_history_summary', summary).join('\n')
                )
            },
            ...this.messages.slice(this.batchStart)
        ]
        this.batchStart = 1
        // 摘要请求的 usage 与保留的旧响应都不代表新上下文大小。
        this.inputTokens = undefined
        this.logger.diagnosticSummary((fields) => ({
            event: 'Dream 上下文压缩完成',
            detail: `${formatLogScope(fields)}; 压缩序号：${attempt}; 压缩前输入量：${tokensBefore} tokens`
        }))
    }
}
