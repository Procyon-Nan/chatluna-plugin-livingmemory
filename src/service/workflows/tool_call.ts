import type { ChatBlock, ChatToolCallBlock } from '@chatluna/message'
import type { ChatSpecMessage } from '@chatluna/ai'
import type { Schema } from '@chatluna/schema'
import { isSchemaValidationError } from '@chatluna/schema'
import { MemoryInputError } from '../memory/errors.ts'
import { formatErrorDetails } from '../shared/utils.ts'

/** 会话历史由调用方持有，工具循环只在其上追加。 */
export interface LivingMemoryChatHistory {
    messages: ChatSpecMessage[]
}

/** 内部循环里的工具：提示词契约 + 实际执行。不需要 v2 工具服务的调用上下文。 */
export interface LivingMemoryLoopTool<I = any, O = unknown> {
    name: string
    description: string
    args: Schema<I>
    run(input: I): Promise<O>
}

export type LivingMemoryToolCallOutcome =
    | { ok: true; text: string; value: unknown }
    | { ok: false; text: string }

const unknownToolMessage = (name: string) => `未知工具：${name}`

const invalidToolArgsMessage = (name: string, reason: string) =>
    `工具 ${name} 的参数不合法：${reason}。请修正参数后重新提交。`

const toolFailedMessage = (name: string, reason: string) =>
    `工具 ${name} 执行失败：${reason}。请修正后重试。`

/** 工具返回给模型的内容：字符串原样，其余按 JSON 序列化。 */
export const renderToolOutput = (value: unknown) => {
    if (typeof value === 'string') return value
    const text = JSON.stringify(value)
    return text === undefined ? '' : text
}

/**
 * 执行一次模型提交的工具调用，并把结果折成给模型的文本。
 *
 * 参数校验失败与工具自身的输入错误（`MemoryInputError`）是可纠正错误，作为
 * 观察结果回给模型；其它异常属于契约被破坏，向上抛出。
 */
export const runLivingMemoryToolCall = async (
    tool: LivingMemoryLoopTool | undefined,
    call: ChatToolCallBlock
): Promise<LivingMemoryToolCallOutcome> => {
    if (tool === undefined) {
        return { ok: false, text: unknownToolMessage(call.toolName) }
    }
    let args: unknown
    try {
        args = tool.args(call.input)
    } catch (error) {
        if (!isSchemaValidationError(error)) throw error
        return {
            ok: false,
            text: invalidToolArgsMessage(call.toolName, formatErrorDetails(error))
        }
    }
    try {
        const value = await tool.run(args)
        return { ok: true, text: renderToolOutput(value), value }
    } catch (error) {
        if (!(error instanceof MemoryInputError)) throw error
        return {
            ok: false,
            text: toolFailedMessage(call.toolName, formatErrorDetails(error))
        }
    }
}

export const textBlocks = (text: string): ChatBlock[] => [{ type: 'text', text }]