import type { Schema } from '@chatluna/schema'
import type { Context } from 'cordis'
import { ProtocolError } from '@chatluna/ai'
import type {} from '@chatluna/ai-runtime/ops'
import type {} from '@chatluna/core'
import { formatErrorDetails } from '../shared/utils.ts'
import { formatLogScope, type LivingMemoryLogger } from '../logging/logger.ts'
import { modelStageLabels } from '../logging/model_calls.ts'

const structuredOutputMaxModelCalls = 3

export interface StructuredOutputLogging {
    logger: LivingMemoryLogger
    stage: keyof typeof modelStageLabels
}

/**
 * 结构化输出的重试语义沿用 v1：最多三次模型调用，每次把上一次的错误
 * 与修正要求回给模型。v2 用 `ctx.chatluna.extract` 直接约束 JSON schema
 * 结果，不再构造 langchain 的 agent 与工具循环。
 *
 * 只有解析与校验失败进入修正重试：`extract` 在输出缺少 JSON 或未通过
 * schema 时抛 `ProtocolError`，与 v1 的 `OutputParserException` 同义。
 * 模型请求本身失败原样抛出，等待调用方的失败语义处理。
 */
export interface StructuredOutputOptions<T> {
    ctx: Context
    schema: Schema<any, T>
    systemPrompt: string
    inputPrompt: string
    model?: string
    signal?: AbortSignal
    /** 上下文级校验：返回字符串表示拒绝原因，返回 undefined 表示接受。 */
    validateResult?: (value: T) => string | undefined
    /**
     * 模型把数组字段序列化成字符串时，纠正提示里点名该字段。v1 会先解码
     * 这份字符串再接受结果；v2 不做解码——格式错误回给模型重写，连续三次
     * 仍不合格时记解析失败并丢弃本批，避免把模型的错误结果写进记忆。
     */
    stringifiedArrayField?: string
    logging?: StructuredOutputLogging
}

export type StructuredOutputResult<T> =
    | { value: T; output: string; parseError: null }
    | { value: null; output: string; parseError: string }

/**
 * 调用结构化输出。取消信号在每次调用前检查，取消不进入修正重试。
 * 模型自身错误原样抛出——只有解析与校验失败才会带着修正提示重试。
 */
export async function invokeStructuredOutput<T>(
    options: StructuredOutputOptions<T>
): Promise<StructuredOutputResult<T>> {
    const outputs: string[] = []
    const { logging } = options
    let correction: string | undefined
    let lastError = 'structured output failed'

    for (let attempt = 1; attempt <= structuredOutputMaxModelCalls; attempt++) {
        options.signal?.throwIfAborted()
        const prompt = correction === undefined ? options.inputPrompt : `${options.inputPrompt}\n\n${correction}`
        try {
            const value = await options.ctx.chatluna.extract(options.schema, {
                prompt,
                system: options.systemPrompt,
                ...(options.model === undefined ? {} : { model: options.model }),
                ...(options.signal === undefined ? {} : { signal: options.signal })
            })
            options.signal?.throwIfAborted()
            outputs.push(`[attempt ${attempt}]\n${JSON.stringify(value, null, 2)}`)
            const validationError = options.validateResult?.(value)
            if (validationError === undefined) {
                return { value, output: outputs.join('\n\n'), parseError: null }
            }
            lastError = validationError
        } catch (error) {
            options.signal?.throwIfAborted()
            if (!(error instanceof ProtocolError)) throw error
            lastError = formatErrorDetails(error)
            outputs.push(`[attempt ${attempt}]\n${lastError}`)
        }
        logging?.logger.diagnosticSummary((fields) => ({
            event: `${modelStageLabels[logging.stage]}结果解析失败`,
            detail: [
                formatLogScope(fields),
                `调用序号：${attempt}`,
                `原因：${lastError}`
            ]
                .filter(Boolean)
                .join('; ')
        }))
        correction = formatCorrection(lastError, options.stringifiedArrayField)
    }

    return { value: null, output: outputs.join('\n\n'), parseError: lastError }
}

/**
 * 修正提示：v1 通过工具调用的 scratchpad 回传，v2 没有代理循环，改为追加到
 * 输入提示之后。保留 v1 的措辞，让模型接受到的纠正信号保持一致。
 */
const formatCorrection = (error: string, stringifiedArrayField?: string) => {
    const instructions = [`结构化结果无效：${error}。`, '必须只输出符合 schema 的 JSON，并完整修正所有字段。']
    if (stringifiedArrayField != null) {
        instructions.push(
            `${stringifiedArrayField} 必须直接传 JSON 数组：正确 {"${stringifiedArrayField}":[]}；错误 {"${stringifiedArrayField}":"[]"}。`
        )
    }
    instructions.push('不要在 JSON 之外输出解释性文本。')
    return instructions.join(' ')
}
