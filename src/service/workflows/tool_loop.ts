import type { ChatSpecMessage } from '@chatluna/ai'
import type {} from '@chatluna/ai-runtime/ops'
import type { Context } from 'cordis'
import type { ChatBlock, ChatToolCallBlock, JsonSchemaNode } from '@chatluna/message'
import { schemasteryToJsonSchemaNode } from '@chatluna/schema'
import { formatErrorDetails } from '../shared/utils.ts'
import { formatLogScope, type LivingMemoryLogger } from '../logging/logger.ts'
import { modelStageLabels } from '../logging/model_calls.ts'
import {
    runLivingMemoryToolCall,
    textBlocks,
    type LivingMemoryChatHistory,
    type LivingMemoryLoopTool
} from './tool_call.ts'

export interface LivingMemoryChatFold {
    content: readonly ChatBlock[]
    text: string
    toolCalls: readonly ChatToolCallBlock[]
    usage?: { inputTokens?: number }
}

export interface LivingMemoryToolLoopOptions {
    ctx: Context
    model: string
    system: string
    /** 首条用户消息；传入 `history` 时由调用方自行决定是否写入。 */
    input: string
    tools: readonly LivingMemoryLoopTool[]
    logger: LivingMemoryLogger
    stage: 'recall' | 'dream'
    /** 沿用调用方的历史（Dream 的跨批次会话）；缺省时循环自建。 */
    history?: LivingMemoryChatHistory
    /**
     * 一次响应里出现多个工具调用时的处理：`reject` 整轮丢弃并追加纠正消息
     * （召回要求逐个提交）；`sequential` 依次执行（Dream 允许一次改多条）。
     */
    multipleToolCalls?: 'reject' | 'sequential'
    /** 每轮模型调用结束后回调，用于记录用量。 */
    onModelCall?(response: { fold: LivingMemoryChatFold; step: number }): void
    /** 取消信号：每轮模型调用与每次工具执行前检查。 */
    signal?: AbortSignal
    /** 发起下一轮前决定实际发送的消息（可压缩历史）；返回 undefined 表示沿用历史。 */
    prepareMessages?(
        messages: readonly ChatSpecMessage[],
        step: number
    ): Promise<readonly ChatSpecMessage[] | undefined>
}

const missingToolCallMessage =
    '你必须调用任务限定的工具提交结果。不要输出普通文本、Markdown 或解释说明。'

const multipleToolCallsMessage =
    '每次只调用一个工具，根据工具返回结果决定下一步操作，请重新提交。'

/** 维护内部工作流的模型和工具历史，由调用方决定按单轮推进还是等待收尾工具。 */
export class LivingMemoryToolLoop {
    private readonly history: LivingMemoryChatHistory
    private readonly specs: { name: string; description: string; parameters: JsonSchemaNode }[]
    private readonly toolsByName: Map<string, LivingMemoryLoopTool>

    constructor(private readonly options: LivingMemoryToolLoopOptions) {
        this.history = options.history ?? { messages: [] }
        if (options.history === undefined) {
            this.history.messages.push({
                role: 'user',
                content: textBlocks(options.input)
            })
        }
        this.specs = options.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: schemasteryToJsonSchemaNode(tool.args) as JsonSchemaNode
        }))
        this.toolsByName = new Map(
            options.tools.map((tool) => [tool.name, tool])
        )
    }

    async runUntilConclusion(options: {
        maxModelCalls: number
        conclusiveTools: readonly string[]
    }): Promise<number> {
        const { maxModelCalls, conclusiveTools } = options
        for (let step = 1; step <= maxModelCalls; step++) {
            const successfulTools = await this.runRound(step)
            if (successfulTools.some((name) => conclusiveTools.includes(name))) {
                return step
            }
        }
        throw new Error(
            `${modelStageLabels[this.options.stage]}在 ${maxModelCalls} 次模型调用内未完成`
        )
    }

    /** 执行一次模型调用，返回本轮成功执行的工具名；协议纠正也占一轮。 */
    async runRound(step: number): Promise<string[]> {
        const { signal, prepareMessages, onModelCall } = this.options
        signal?.throwIfAborted()
        const messages =
            (await prepareMessages?.(this.history.messages, step)) ??
            this.history.messages
        const fold = await this.callModel(messages, step)
        signal?.throwIfAborted()
        onModelCall?.({ fold, step })

        if (fold.toolCalls.length === 0) {
            this.history.messages.push({
                role: 'user',
                content: textBlocks(missingToolCallMessage)
            })
            return []
        }
        if (
            fold.toolCalls.length > 1 &&
            this.options.multipleToolCalls !== 'sequential'
        ) {
            this.history.messages.push({
                role: 'user',
                content: textBlocks(multipleToolCallsMessage)
            })
            return []
        }

        this.history.messages.push({
            role: 'assistant',
            content: fold.content
        })
        const successfulTools: string[] = []
        for (const call of fold.toolCalls) {
            signal?.throwIfAborted()
            const outcome = await runLivingMemoryToolCall(
                this.toolsByName.get(call.toolName),
                call
            )
            signal?.throwIfAborted()
            if (outcome.ok) successfulTools.push(call.toolName)
            this.history.messages.push({
                role: 'tool',
                content: [
                    {
                        type: 'tool-result',
                        toolCallId: call.toolCallId,
                        toolName: call.toolName,
                        output: { type: 'text', value: outcome.text }
                    }
                ]
            })
        }
        return successfulTools
    }

    private async callModel(
        messages: readonly ChatSpecMessage[],
        step: number
    ): Promise<LivingMemoryChatFold> {
        const { ctx, model, logger } = this.options
        const stage = modelStageLabels[this.options.stage]
        logger.diagnosticSummary((fields) => ({
            event: `${stage}模型调用`,
            detail: `${formatLogScope(fields)}; 模型：${model}; 调用序号：${step}`
        }))
        try {
            const fold = await ctx.chatluna.chat({
                model,
                system: this.options.system,
                messages: [...messages],
                toolSpecs: this.specs
            })
            logger.diagnosticSummary((fields) => {
                if (fold.toolCalls.length === 0) return undefined
                return {
                    event: `${stage}模型响应`,
                    detail: `${formatLogScope(fields)}; 工具调用：${fold.toolCalls
                        .map((call) => call.toolName)
                        .join('、')}`,
                    blocks: fold.toolCalls.map((call) => ({
                        title: '工具调用',
                        subtitle: `${call.toolName}:${call.toolCallId}`,
                        key: 'args',
                        value: call.input
                    }))
                }
            })
            return fold
        } catch (error) {
            logger.diagnosticSummary((fields) => ({
                event: `${stage}模型调用失败`,
                detail: `${formatLogScope(fields)}; 模型：${model}; 调用序号：${step}; 原因：${formatErrorDetails(error)}`
            }))
            throw error
        }
    }
}
