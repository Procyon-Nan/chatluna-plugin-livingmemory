import type { ChatBlock } from '@chatluna/ai'
import type { ChatOptions, ChatResult } from '@chatluna/ai-runtime/ops'
import { formatLogScope, type LivingMemoryLogBlock, type LivingMemoryLogger } from './logger.ts'

export const modelStageLabels = {
    recall: '召回',
    dream: 'Dream',
    'dream-compression': 'Dream 上下文压缩',
    'memory-extraction': '记忆提取',
    'persona-card': '人设卡片',
    'user-profile': '人物画像'
}

/** 普通文本直接按原有换行显示；混合消息保留每个内容块的类型和顺序。 */
function logContent(content: readonly ChatBlock[]) {
    if (content.length === 1 && content[0]?.type === 'text') return content[0].text
    return content
}

interface ModelCallLog {
    beforeDispatch: NonNullable<ChatOptions['beforeDispatch']>
    response(result: ChatResult): void
}

export function modelCallLogging(logger: LivingMemoryLogger, stage: keyof typeof modelStageLabels, step: number): ModelCallLog {
    const label = modelStageLabels[stage]
    const beforeDispatch: ModelCallLog['beforeDispatch'] = (params, resolved) => {
        logger.diagnosticSummary(fields => {
            const blocks: LivingMemoryLogBlock[] = []
            if (params.system !== undefined) blocks.push({ title: '系统提示词', value: params.system })
            for (const [index, message] of params.messages.entries()) {
                blocks.push({ title: `消息 ${index + 1} · ${message.role}`, value: logContent(message.content) })
            }
            if (params.tools?.length) blocks.push({ title: '可用工具', value: params.tools })
            if (params.toolChoice !== undefined) blocks.push({ title: '工具选择', value: params.toolChoice })
            if (params.responseFormat !== undefined) blocks.push({ title: '输出格式', value: params.responseFormat })
            return {
                event: `${label}模型调用`,
                detail: `${formatLogScope(fields)}; 模型：${resolved.provider}:${resolved.model}; 调用序号：${step}`,
                blocks
            }
        })
    }
    function response(result: ChatResult) {
        logger.diagnosticSummary(fields => ({
            event: `${label}模型响应`,
            detail: `${formatLogScope(fields)}; 调用序号：${step}; 结束原因：${result.finish.kind}`,
            blocks: [{ title: '模型输出', value: logContent(result.content) }]
        }))
    }
    return { beforeDispatch, response }
}
