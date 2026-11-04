import { contentText } from '@chatluna/message'
import type { ChatBlock, ChatSpecMessage } from '@chatluna/ai'
import type { Context } from 'cordis'
import type {} from '@chatluna/ai-runtime/ops'
import type {} from '@chatluna/core'
import { formatErrorDetails } from '../shared/utils.ts'
import { formatLogScope, type LivingMemoryLogBlock, type LivingMemoryLogFields, type LivingMemoryLogger } from './logger.ts'

export interface LivingMemoryModelCallContext {
    logger: LivingMemoryLogger
    stage: string
    attempt: number | (() => number)
    promptLogging?: 'all' | 'first' | 'none'
    logResponseText?: boolean
}

export const modelStageLabels: Record<string, string> = {
    'agentic-decision': '召回',
    'dream-decision': 'Dream',
    'dream-compression': 'Dream 上下文压缩',
    'memory-extraction': '记忆提取',
    'persona-card': '人设卡片',
    'user-profile': '人物画像'
}

const messageRoleLabels: Record<string, string> = {
    system: '系统消息',
    user: '用户消息',
    assistant: '助手消息',
    tool: '工具消息'
}

const formatModelLogDetails = (fields: LivingMemoryLogFields, callNumber?: number) => {
    const details = [`模型：${fields.model}`]
    if (callNumber !== undefined) {
        details.push(`调用序号：${callNumber}`)
    }
    const scope = formatLogScope(fields)
    if (scope) details.push(scope)
    return details.join('; ')
}

const toPromptBlocks = (messages: readonly ChatSpecMessage[], system: string | undefined) => {
    const blocks: LivingMemoryLogBlock[] = []
    if (system !== undefined && system.length > 0) {
        blocks.push({ title: '系统消息', key: 'system', value: system })
    }
    for (const message of messages) {
        blocks.push({
            title: messageRoleLabels[message.role] ?? message.role,
            key: 'content',
            value: contentText(message.content)
        })
        for (const block of message.content) {
            if (block.type === 'tool-call') {
                blocks.push({
                    title: '工具调用',
                    subtitle: `${block.toolName}:${block.toolCallId}`,
                    key: 'args',
                    value: block.input
                })
            }
        }
    }
    return blocks
}

const toResponseBlocks = (content: readonly ChatBlock[], logResponseText: boolean) => {
    const blocks: LivingMemoryLogBlock[] = []
    if (logResponseText) {
        const text = contentText(content)
        if (text.length > 0) {
            blocks.push({ title: '模型文本', key: 'text', value: text })
        }
    }
    for (const block of content) {
        if (block.type !== 'tool-call') continue
        blocks.push({
            title: '工具调用',
            subtitle: `${block.toolName}:${block.toolCallId}`,
            key: 'args',
            value: block.input
        })
    }
    return blocks
}

/**
 * 带诊断日志的对话调用。v2 的 `ctx.chatluna.chat` 直接接收消息与 system，
 * 不再有 langchain 的 Runnable 包装；日志字段与阶段标签沿用 v1。
 */
export const invokeLoggedModel = async (
    ctx: Context,
    options: {
        model?: string
        messages: readonly ChatSpecMessage[]
        system?: string
        signal?: AbortSignal
        temperature?: number
    },
    context: LivingMemoryModelCallContext
) => {
    const attempt = typeof context.attempt === 'function' ? context.attempt() : context.attempt
    const stage = modelStageLabels[context.stage] ?? context.stage
    const logger = context.logger.with({ stage: context.stage, attempt, model: options.model })
    const promptLogging = context.promptLogging ?? 'all'
    const logPrompt = promptLogging === 'all' || (promptLogging === 'first' && attempt === 1)
    if (logPrompt) {
        logger.diagnosticSummary((fields) => ({
            event: `${stage}模型输入`,
            detail: formatModelLogDetails(fields, promptLogging === 'all' ? attempt : undefined),
            blocks: toPromptBlocks(options.messages, options.system)
        }))
    }
    const startedAt = performance.now()
    logger.diagnosticSummary((fields) => ({
        event: `${stage}模型调用`,
        detail: formatModelLogDetails(fields, attempt)
    }))
    try {
        const run = ctx.chatluna.chat({
            messages: options.messages,
            ...(options.system === undefined ? {} : { system: options.system }),
            ...(options.model === undefined ? {} : { model: options.model }),
            ...(options.temperature === undefined ? {} : { temperature: options.temperature })
        })
        if (options.signal !== undefined) {
            options.signal.addEventListener('abort', () => run.abort(), { once: true })
        }
        const fold = await run
        logger.diagnosticSummary((fields) => {
            const blocks = toResponseBlocks(fold.content, context.logResponseText ?? true)
            if (blocks.length === 0) return
            return {
                event: `${stage}模型响应`,
                detail: formatModelLogDetails(fields),
                blocks
            }
        })
        return fold
    } catch (error) {
        logger.diagnosticSummary((fields) => ({
            event: `${stage}模型调用失败`,
            detail: `${formatLogScope(fields)}; 模型：${fields.model}; 调用序号：${fields.attempt}; 耗时：${(
                (performance.now() - startedAt) /
                1000
            ).toFixed(3)} 秒; 原因：${formatErrorDetails(error)}`
        }))
        throw error
    }
}