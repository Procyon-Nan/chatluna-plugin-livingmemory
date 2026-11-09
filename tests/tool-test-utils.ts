/**
 * 工具测试的调用上下文替身。工具 `run` 只从 `call.agent` 读取预设与会话，
 * 这里按 `Agent.options` 的形状构造。
 */
export interface ToolAgentOptions {
    presetId?: string
    conversationKey?: string
    location?: {
        platform?: string
        user?: string
        guild?: string
        channel?: string
    }
    permissions?: { origin?: string[] }
}

export const toolCall = (options: ToolAgentOptions = {}) =>
    ({
        id: 'call-1' as never,
        agent: { options }
    }) as never

/** 直接调用工具定义：先按 schema 解析参数，再执行 run。 */
export const runTool = async <T>(
    definition: { args: (input: unknown) => unknown; run?: (args: unknown, call: never) => unknown },
    input: unknown,
    options: ToolAgentOptions = {}
) => {
    const parsed = definition.args(input)
    return (await definition.run?.(parsed, toolCall(options))) as T
}