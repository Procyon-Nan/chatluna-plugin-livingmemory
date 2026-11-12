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

export function logMessageParts({ role, content }: ChatSpecMessage, displayText = (text: string) => text) {
    const lines: string[] = []
    for (const block of content) {
        if (block.type === 'text' && role !== 'assistant') lines.push(displayText(block.text))
        if (block.type === 'tool-call') lines.push(formatCall(block))
        if (block.type === 'tool-result' && block.output.type === 'text') lines.push(`${block.toolName} 返回：${block.output.value}`)
    }
    return lines.filter(Boolean)
}

/** 每个工作流单独比较相邻两次实际派发的请求。 */
export class ModelCallLogs {
    private previousSystem?: string
    private previousParts = new Map<string, number>()

    constructor(private readonly logger: LivingMemoryLogger, private readonly stage: keyof typeof modelStageLabels) {}

    beforeDispatch(step: number, {
        displayText = (text: string) => text,
        newMessagesFrom = Infinity
    }: { displayText?: (text: string) => string; newMessagesFrom?: number } = {}): NonNullable<ChatOptions['beforeDispatch']> {
        return (params, resolved, { degradations }) => this.logger.diagnosticSummary(fields => {
            const blocks: LivingMemoryLogBlock[] = []
            // 框架可能在重派时将同一系统词移到首条用户消息。
            const foldedUser = degradations.includes('system-to-user') ? params.messages.find(m => m.role === 'user') : undefined
            const folded = foldedUser?.content[0]
            const system = displayText(folded?.type === 'text' ? folded.text.slice('[system]\n'.length) : params.system ?? '')
            const previous = this.previousSystem
            const added = previous !== undefined && system.startsWith(previous) ? system.slice(previous.length) : system
            if (added) blocks.push({ title: '系统提示词', value: added })
            const current = new Map<string, number>()
            for (const [index, message] of params.messages.entries()) {
                // 后续请求回放的工具调用，已随模型响应打印。
                if (previous !== undefined && message.role === 'assistant') continue
                const visible = message === foldedUser ? { ...message, content: message.content.slice(1) } : message
                const parts: string[] = []
                // 按出现次数比较：Dream 在历史末尾再次追加同一句指令时，也要打印。
                for (const value of logMessageParts(visible, displayText)) {
                    const key = `${message.role}\n${value}`
                    const count = (current.get(key) ?? 0) + 1
                    current.set(key, count)
                    if (index >= newMessagesFrom || count > (this.previousParts.get(key) ?? 0)) parts.push(value)
                }
                if (parts.length) blocks.push({ title: `消息 ${index + 1} · ${message.role}`, value: parts.join('\n') })
            }
            this.previousSystem = system
            this.previousParts = current
            newMessagesFrom = Infinity // 同一请求再次派发时没有新的纠正消息。
            return {
                event: `${modelStageLabels[this.stage]}模型调用`,
                detail: `${formatLogScope(fields)}; 模型：${resolved.provider}:${resolved.model}; 调用序号：${step}`,
                blocks
            }
        })
    }

    response(step: number, result: ChatResult) {
        this.logger.diagnosticSummary(fields => {
            const output = this.stage === 'dream-compression' ? result.text : result.toolCalls.map(formatCall).join('\n')
            return {
                event: `${modelStageLabels[this.stage]}模型响应`,
                detail: `${formatLogScope(fields)}; 调用序号：${step}; 结束原因：${result.finish.kind}`,
                blocks: output ? [{ title: '模型输出', value: output }] : []
            }
        })
    }
}
