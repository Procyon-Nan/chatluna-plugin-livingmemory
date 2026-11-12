import { addAbortListener } from 'node:events'
import { schemasteryToJsonSchema, type Schema } from '@chatluna/schema'
import type { Context } from 'cordis'
import { ProtocolError } from '@chatluna/ai'
import { extractJsonValue } from '@chatluna/ai-runtime/ops'
import type {} from '@chatluna/core'
import { formatErrorDetails } from '../shared/utils.ts'
import { formatLogScope, type LivingMemoryLogger } from '../logging/logger.ts'
import { modelCallLogging, modelStageLabels } from '../logging/model_calls.ts'

const structuredOutputMaxModelCalls = 3

interface StructuredOutputOptions<T> {
    ctx: Context
    schema: Schema<any, T>
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
    | { value: T; output: string; parseError: null }
    | { value: null; output: string; parseError: string }

function parseStructuredResponse<T>(schema: Schema<any, T>, text: string): T {
    const json = extractJsonValue(text)
    if (json === undefined) {
        throw new ProtocolError({ message: 'extract: model output did not contain a JSON value' })
    }
    const parsed = schema.safeParse(json)
    if (parsed.success) return parsed.data
    const reason = parsed.error instanceof Error ? parsed.error.message : String(parsed.error)
    throw new ProtocolError({ message: `extract: model output failed schema validation: ${reason}` })
}

/**
 * 调用结构化输出。取消信号在每次调用前检查，取消不进入修正重试。
 * 模型自身错误原样抛出——只有解析与校验失败才会带着修正提示重试。
 */
export async function invokeStructuredOutput<T>(
    options: StructuredOutputOptions<T>
): Promise<StructuredOutputResult<T>> {
    const outputs: string[] = []
    const { logging: { logger, stage }, signal } = options
    let correction: string | undefined
    let lastError = 'structured output failed'
    const system = [
        options.systemPrompt,
        'Return ONLY a JSON value that validates against the following JSON Schema:',
        JSON.stringify(schemasteryToJsonSchema(options.schema))
    ].filter(Boolean).join('\n\n')

    for (let attempt = 1; attempt <= structuredOutputMaxModelCalls; attempt++) {
        signal?.throwIfAborted()
        const prompt = correction === undefined ? options.inputPrompt : `${options.inputPrompt}\n\n${correction}`
        try {
            const log = modelCallLogging(logger, stage, attempt, text => text.replace(system, () => options.systemPrompt))
            const run = options.ctx.chatluna.chat({
                system,
                messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
                ...(options.model === undefined ? {} : { model: options.model }),
                beforeDispatch: log.beforeDispatch
            })
            using cancellation = signal && addAbortListener(signal, () => run.abort(signal.reason))
            const fold = await run
            signal?.throwIfAborted()
            log.response(fold)
            const value = parseStructuredResponse(options.schema, fold.text)
            outputs.push(`[attempt ${attempt}]\n${JSON.stringify(value, null, 2)}`)
            const validationError = options.validateResult?.(value)
            if (validationError === undefined) {
                return { value, output: outputs.join('\n\n'), parseError: null }
            }
            lastError = validationError
        } catch (error) {
            signal?.throwIfAborted()
            if (!(error instanceof ProtocolError)) throw error
            lastError = formatErrorDetails(error)
            outputs.push(`[attempt ${attempt}]\n${lastError}`)
        }
        logger.diagnosticSummary((fields) => ({
            event: `${modelStageLabels[stage]}结果解析失败`,
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
