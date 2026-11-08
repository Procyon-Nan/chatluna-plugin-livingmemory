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

export interface LivingMemoryToolLoopResult {
    /** 收尾工具的调用结果；没有收尾工具被调用时为 null。 */
    conclusion: { name: string; output: unknown } | null
    modelCalls: number
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
    maxModelCalls: number
    /** 调用这些工具即视为收尾，循环在它们执行成功后结束。 */
    conclusiveTools?: readonly string[]
    /** 沿用调用方的历史（Dream 的跨批次会话）；缺省时循环自建。 */
    history?: LivingMemoryChatHistory
    /** 模型没有提交工具调用时追加的纠正消息。 */
    missingToolCallMessage?: string
    /** 模型一次提交多个工具调用时追加的纠正消息。 */
    multipleToolCallsMessage?: string
    /**
     * 一次响应里出现多个工具调用时的处理：`reject` 整轮丢弃并追加纠正消息
     * （召回要求逐个提交）；`sequential` 依次执行（Dream 允许一次改多条）。
     */
    multipleToolCalls?: 'reject' | 'sequential'
    /** 每轮模型调用结束后回调，用于记录用量。 */
    onModelCall?(response: { fold: LivingMemoryChatFold; step: number }): void
    /**
     * 每轮工具执行结束后回调。`effective` 与 v1 一致：本轮至少有一个工具
     * 成功执行（重复更新同一条记忆也算有效操作）。
     */
    onRound?(outcome: { step: number; effective: boolean; toolCalls: number }): void
    /** 取消信号：每轮模型调用与每次工具执行前检查。 */
    signal?: AbortSignal
    /** 发起下一轮前决定实际发送的消息（可压缩历史）；返回 undefined 表示沿用历史。 */
    prepareMessages?(
        messages: readonly ChatSpecMessage[],
        step: number
    ): Promise<readonly ChatSpecMessage[] | undefined>
    /** 工具执行完仍未收尾时追加的推进消息；返回 undefined 表示不追加，直接进入下一轮。 */
    nextTurnInput?(step: number, outcome: { toolCalls: number }): string | undefined
}

const defaultMissingToolCallMessage =
    '你必须调用任务限定的工具提交结果。不要输出普通文本、Markdown 或解释说明。'

const defaultMultipleToolCallsMessage =
    '每次只调用一个工具，根据工具返回结果决定下一步操作，请重新提交。'

/**
 * 内部控制工具循环。
 *
 * v1 用 langchain 的 AgentRunner；v2 原生 agent 面向用户对话，要求 prompt /
 * presets / tool_search / trace 等一整套服务在场，还会把内部会话写进观察层。
 * 内部工作流按 v1 的形状直接驱动 `ctx.chatluna.chat`：一次模型调用 → 执行一个
 * 工具 → 由调用方决定是否追加推进消息。
 *
 * 与 v1 一致：没有工具调用或一次提交多个工具调用时，该响应不进入历史，只追加
 * 一条纠正消息让模型重试。
 */
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

    async run(): Promise<LivingMemoryToolLoopResult> {
        const { maxModelCalls, conclusiveTools = [] } = this.options
        const conclusive = new Set(conclusiveTools)

        for (let step = 1; step <= maxModelCalls; step++) {
            this.options.signal?.throwIfAborted()
            const prepared =
                (await this.options.prepareMessages?.(
                    this.history.messages,
                    step
                )) ?? this.history.messages
            const fold = await this.callModel(prepared, step)
            this.options.signal?.throwIfAborted()
            this.options.onModelCall?.({ fold, step })

            if (fold.toolCalls.length === 0) {
                this.history.messages.push({
                    role: 'user',
                    content: textBlocks(
                        this.options.missingToolCallMessage ??
                            defaultMissingToolCallMessage
                    )
                })
                continue
            }
            if (
                fold.toolCalls.length > 1 &&
                this.options.multipleToolCalls !== 'sequential'
            ) {
                this.history.messages.push({
                    role: 'user',
                    content: textBlocks(
                        this.options.multipleToolCallsMessage ??
                            defaultMultipleToolCallsMessage
                    )
                })
                continue
            }

            this.history.messages.push({
                role: 'assistant',
                content: fold.content
            })
            let conclusion: LivingMemoryToolLoopResult['conclusion'] = null
            let effective = false
            for (const call of fold.toolCalls) {
                this.options.signal?.throwIfAborted()
                const outcome = await runLivingMemoryToolCall(
                    this.toolsByName.get(call.toolName),
                    call
                )
                this.options.signal?.throwIfAborted()
                if (outcome.ok) effective = true
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
                if (outcome.ok && conclusive.has(call.toolName)) {
                    conclusion = {
                        name: call.toolName,
                        output: outcome.value
                    }
                }
            }
            if (conclusion !== null) {
                return { conclusion, modelCalls: step }
            }
            this.options.onRound?.({
                step,
                effective,
                toolCalls: fold.toolCalls.length
            })

            const next = this.options.nextTurnInput?.(step, {
                toolCalls: fold.toolCalls.length
            })
            if (next !== undefined) {
                this.history.messages.push({
                    role: 'user',
                    content: textBlocks(next)
                })
            }
        }

        throw new Error(
            `${modelStageLabels[this.options.stage]}在 ${maxModelCalls} 次模型调用内未完成`
        )
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
