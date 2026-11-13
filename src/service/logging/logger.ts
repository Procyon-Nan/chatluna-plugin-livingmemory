import type { Logger } from 'cordis'
import type { MemoryScope } from '../../contracts/memory.ts'
import { toError } from '../shared/utils.ts'

type LogScope = Partial<
    Pick<MemoryScope, 'presetId' | 'conversationId' | 'isDirect' | 'userId' | 'guildId' | 'channelId'>
>

export interface LivingMemoryLogFields extends Record<string, unknown>, LogScope {
    model?: string
    attempt?: number
    speaker?: string
    batch?: string
}

export const formatLogScope = (scope: LogScope) => {
    const details: string[] = []
    if (scope.presetId != null) details.push(`预设：${scope.presetId}`)
    const id = scope.isDirect ? scope.userId : (scope.guildId ?? scope.channelId)
    if (scope.isDirect != null && id != null) {
        details.push(`会话：${scope.isDirect ? '私聊' : '群聊'} ${id}`)
    } else if (scope.conversationId != null) {
        const conversation = scope.conversationId.replace(/^group:/, '群聊 ').replace(/^private:/, '私聊 ')
        details.push(`会话：${conversation}`)
    }
    return details.join('; ')
}

export interface LivingMemoryLogBlock {
    title: string
    value: unknown
}

export type LivingMemoryLogSink = Pick<Logger, 'info' | 'warn' | 'error'>
export type LivingMemoryLogLevel = keyof LivingMemoryLogSink

interface LivingMemoryLoggerState {
    failureReported: boolean
}

const credentialKeyPattern =
    /(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|(?:^|[-_])token(?:$|[-_])|password|secret)/iu

const normalizeValue = (value: unknown, key: string, seen: WeakSet<object>): unknown => {
    if (credentialKeyPattern.test(key)) {
        return '[REDACTED]'
    }
    if (value == null || typeof value === 'boolean' || typeof value === 'string') {
        return value
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : String(value)
    }
    if (typeof value === 'bigint') {
        return `${value}n`
    }
    if (typeof value === 'symbol' || typeof value === 'function') {
        return `[${typeof value}]`
    }
    if (value instanceof Date) {
        return value.toISOString()
    }
    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            cause: value.cause == null ? undefined : normalizeValue(value.cause, 'cause', seen)
        }
    }
    const objectValue = value as object
    if (seen.has(objectValue)) {
        return '[Circular]'
    }
    seen.add(objectValue)
    try {
        if (Array.isArray(value)) {
            return value.map((item) => normalizeValue(item, '', seen))
        }
        const normalized: Record<string, unknown> = {}
        for (const entryKey of Object.keys(value).sort()) {
            const entryValue = normalizeValue((value as Record<string, unknown>)[entryKey], entryKey, seen)
            if (entryValue !== undefined) {
                normalized[entryKey] = entryValue
            }
        }
        return normalized
    } finally {
        seen.delete(objectValue)
    }
}

export function formatLogJson(value: unknown, indent?: number) {
    const normalized = normalizeValue(value, '', new WeakSet())
    return JSON.stringify(normalized, null, indent)
}

export function formatLogBlock({ title, value }: LivingMemoryLogBlock) {
    const body = typeof value === 'string' ? value : formatLogJson(value, 2)
    return `------------${title}------------\n${body}`
}

export class LivingMemoryLogger {
    constructor(
        private readonly sink: LivingMemoryLogSink,
        private readonly isDebugEnabled: () => boolean,
        private readonly context: LivingMemoryLogFields = {},
        private readonly state: LivingMemoryLoggerState = { failureReported: false }
    ) {}

    with(fields: LivingMemoryLogFields) {
        return new LivingMemoryLogger(
            this.sink,
            this.isDebugEnabled,
            { ...this.context, ...fields },
            this.state
        )
    }

    diagnosticSummary(
        render: (
            context: LivingMemoryLogFields
        ) => { event: string; detail: string; blocks?: LivingMemoryLogBlock[] }
    ) {
        if (!this.isDebugEnabled()) return
        try {
            const { event, detail, blocks } = render(this.context)
            let content = detail
            if (blocks?.length) {
                content += '\n' + blocks.map(formatLogBlock).join('\n\n')
            }
            this.summary(event, content)
        } catch (error) {
            this.reportFailure(error)
        }
    }

    summary(
        event: string,
        detail: string | string[] | ((context: LivingMemoryLogFields) => string),
        level: LivingMemoryLogLevel = 'info',
        error?: unknown
    ) {
        try {
            const resolved = typeof detail === 'function' ? detail(this.context) : detail
            const content = Array.isArray(resolved) ? `\n${resolved.join('\n')}` : ` ${resolved}`
            const message = `事件：${event};${content}`
            if (error === undefined) this.sink[level](message)
            else this.sink[level](`${message}\n%o`, toError(error))
        } catch (error) {
            this.reportFailure(error)
        }
    }

    private reportFailure(error: unknown) {
        if (this.state.failureReported) return
        this.state.failureReported = true
        try {
            this.sink.warn('事件：日志输出失败; 操作：输出日志\n%o', toError(error))
        } catch {
            // 日志是旁路能力，底层 logger 故障不得影响业务流程。
        }
    }
}
