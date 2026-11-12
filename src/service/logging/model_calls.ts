import type { ChatSpecMessage, ChatToolCallBlock } from '@chatluna/ai'
import type { ChatOptions, ChatResult } from '@chatluna/ai-runtime/ops'
import { formatLogJson, formatLogScope, type LivingMemoryLogBlock, type LivingMemoryLogger } from './logger.ts'

export const modelStageLabels = {
    recall: '召回',
    dream: 'Dream',
    'dream-compression': 'Dream 上下文压缩',
    'memory-extraction': '记忆提取',
    'persona-card': '人设卡片',
    'user-profile': '人物画像'
}

const formatCall = (call: ChatToolCallBlock) => `${call.toolName}\n${formatLogJson(call.input, 2)}`

export function formatLogMessage({ role, content }: ChatSpecMessage, displayText = (text: string) => text) {
    const lines: string[] = []
    for (const block of content) {
        if (block.type === 'text' && role !== 'assistant') lines.push(displayText(block.text))
        if (block.type === 'tool-call') lines.push(formatCall(block))
        if (block.type === 'tool-result' && block.output.type === 'text') lines.push(`${block.toolName} 返回：${block.output.value}`)
    }
    return lines.join('\n')
}

interface ModelCallLog {
    beforeDispatch: NonNullable<ChatOptions['beforeDispatch']>
    response(result: ChatResult): void
}

export function modelCallLogging(
    logger: LivingMemoryLogger, stage: keyof typeof modelStageLabels, step: number, displayText = (text: string) => text
): ModelCallLog {
    const label = modelStageLabels[stage]
    const beforeDispatch: ModelCallLog['beforeDispatch'] = (params, resolved) => {
        logger.diagnosticSummary(fields => {
            const blocks: LivingMemoryLogBlock[] = []
            const system = displayText(params.system ?? '')
            if (system) blocks.push({ title: '系统提示词', value: system })
            for (const [index, message] of params.messages.entries()) {
                const value = formatLogMessage(message, displayText)
                if (value) blocks.push({ title: `消息 ${index + 1} · ${message.role}`, value })
            }
            return {
                event: `${label}模型调用`,
                detail: `${formatLogScope(fields)}; 模型：${resolved.provider}:${resolved.model}; 调用序号：${step}`,
                blocks
            }
        })
    }
    function response(result: ChatResult) {
        logger.diagnosticSummary(fields => {
            const output = stage === 'dream-compression' ? result.text : result.toolCalls.map(formatCall).join('\n')
            return {
                event: `${label}模型响应`,
                detail: `${formatLogScope(fields)}; 调用序号：${step}; 结束原因：${result.finish.kind}`,
                blocks: output ? [{ title: '模型输出', value: output }] : []
            }
        })
    }
    return { beforeDispatch, response }
}
