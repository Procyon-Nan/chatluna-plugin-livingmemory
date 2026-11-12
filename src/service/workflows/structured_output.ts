import { addAbortListener } from 'node:events'
import { schemasteryToJsonSchemaNode } from '@chatluna/schema'
import { isRecord } from '@chatluna/utils/object'
import type { Context } from 'cordis'
import { ModelError, type ChatSpecMessage, type ChatToolCallBlock } from '@chatluna/ai'
import type { ChatResult } from '@chatluna/ai-runtime/ops'
import type {} from '@chatluna/core'
import type { LivingMemoryToolDoc } from '../prompts/memory_tools.ts'
import { formatLogScope, type LivingMemoryLogger } from '../logging/logger.ts'
import { ModelCallLogs, modelStageLabels } from '../logging/model_calls.ts'
import { textBlocks } from './tool_call.ts'

const structuredOutputMaxModelCalls = 3

interface StructuredOutputOptions<T> {
    ctx: Context
    tool: LivingMemoryToolDoc<T>
    systemPrompt: string
    inputPrompt: string
    model?: string
    signal?: AbortSignal
    /** 上下文级校验：返回字符串表示拒绝原因，返回 undefined 表示接受。 */
    validateResult?: (value: T) => string | undefined
    /** 数组被错误地写成字符串时，在修正提示里点名该字段。 */
    stringifiedArrayField?: string
    logging: { logger: LivingMemoryLogger; stage: 'memory-extraction' | 'persona-card' | 'user-profile' }
}

type StructuredOutputResult<T> =
    | { value: T; parseError: null }
    | { value: null; parseError: string }

function readSubmission<T>(
    { tool, validateResult, stringifiedArrayField }: StructuredOutputOptions<T>,
    calls: readonly ChatToolCallBlock[]
): StructuredOutputResult<T> {
    if (calls.length !== 1) return { value: null, parseError: `应调用 ${tool.name} 一次，实际收到 ${calls.length} 个工具调用` }
    const call = calls[0]!
    if (call.toolName !== tool.name) return { value: null, parseError: `调用了 ${call.toolName}，应调用 ${tool.name}` }
    const parsed = tool.schema.safeParse(call.input)
    if (parsed.success) {
        const error = validateResult?.(parsed.data)
        return error === undefined ? { value: parsed.data, parseError: null } : { value: null, parseError: error }
    }
    if (stringifiedArrayField && isRecord(call.input) && typeof call.input[stringifiedArrayField] === 'string') {
        return { value: null, parseError: `参数 ${stringifiedArrayField} 要传数组；空数组用 []，不要写成字符串 "[]"` }
    }
    const reason = parsed.error instanceof Error ? parsed.error.message : String(parsed.error)
    return { value: null, parseError: `${tool.name} 参数无效：${reason}` }
}

/**
 * 每次只接受一个指定工具提交的结果。提交不合格时将原因反馈给模型；调用错误和取消直接退出。
 */
export async function invokeStructuredOutput<T>(
    options: StructuredOutputOptions<T>
): Promise<StructuredOutputResult<T>> {
    const { logging: { logger, stage }, signal, tool } = options
    const toolSpecs = [{ name: tool.name, description: tool.description, parameters: schemasteryToJsonSchemaNode(tool.schema) }]
    const input: ChatSpecMessage = { role: 'user', content: textBlocks(options.inputPrompt) }
    let messages = [input]
    const log = new ModelCallLogs(logger, stage)
    for (let attempt = 1; ; attempt++) {
        signal?.throwIfAborted()
        const run = options.ctx.chatluna.chat({
            system: options.systemPrompt, messages, toolSpecs, toolChoice: 'required',
            ...(options.model === undefined ? {} : { model: options.model }),
            // 每次重试都保留首条输入，并以本次的纠正反馈替换上一轮反馈。
            beforeDispatch: log.beforeDispatch(attempt, { newMessagesFrom: 1 })
        })
        using cancellation = signal && addAbortListener(signal, () => run.abort(signal.reason))
        let fold: ChatResult
        try {
            fold = await run
        } finally {
            signal?.throwIfAborted()
        }
        if (fold.finish.kind === 'error' || fold.finish.kind === 'aborted') throw new ModelError(fold.finish.failure)
        log.response(attempt, fold)
        const submission = readSubmission(options, fold.toolCalls)
        if (submission.parseError === null) return submission
        logger.diagnosticSummary((fields) => ({
            event: `${modelStageLabels[stage]}结果解析失败`,
            detail: [
                formatLogScope(fields),
                `调用序号：${attempt}`,
                `原因：${submission.parseError}`
            ]
                .filter(Boolean)
                .join('; ')
        }))
        if (attempt === structuredOutputMaxModelCalls) return submission
        const correction = `提交失败：${submission.parseError}。请调用 ${tool.name} 一次，通过工具参数提交结果。`
        if (fold.toolCalls.length === 0) {
            messages = [input, { role: 'user', content: textBlocks(correction) }]
            continue
        }
        messages = [
            input,
            { role: 'assistant', content: fold.content },
            {
                role: 'tool',
                content: fold.toolCalls.map(call => ({
                    type: 'tool-result',
                    toolCallId: call.toolCallId,
                    toolName: call.toolName,
                    output: { type: 'text', value: correction }
                }))
            }
        ]
    }
}
