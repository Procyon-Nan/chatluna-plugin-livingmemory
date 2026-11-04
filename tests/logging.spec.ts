import assert from 'node:assert/strict'
import { LivingMemoryLogger } from '../src/service/logging/logger.ts'

const createLogger = (debug = false) => {
    const info: unknown[][] = []
    const warnings: unknown[][] = []
    const errors: unknown[][] = []
    return {
        log: new LivingMemoryLogger(
            {
                info: (...args: unknown[]) => info.push(args),
                warn: (...args: unknown[]) => warnings.push(args),
                error: (...args: unknown[]) => errors.push(args)
            } as never,
            () => debug
        ),
        info,
        warnings,
        errors
    }
}

it('formats a Chinese summary using inherited context', () => {
    const captured = createLogger(true)
    captured.log
        .with({ presetId: 'surtur' })
        .summary('人物画像处理失败', (fields) => `预设：${fields.presetId}; 原因：结果格式错误`, 'warn')
    assert.equal(
        captured.warnings[0]?.[0],
        '事件：人物画像处理失败; 预设：surtur; 原因：结果格式错误'
    )
})

it('does not build diagnostic fields when debug logging is disabled', () => {
    const captured = createLogger(false)
    let built = false
    captured.log.diagnosticSummary(() => {
        built = true
        return { event: '诊断', detail: '值：1' }
    })
    assert.equal(built, false)
    assert.equal(captured.info.length, 0)
})

it('redacts credential fields and handles circular values', () => {
    const captured = createLogger(true)
    const circular: Record<string, unknown> = { apiKey: 'secret' }
    circular['self'] = circular
    captured.log.diagnosticSummary(() => ({
        event: '诊断',
        detail: '内容',
        blocks: [{ title: '数据', value: circular }]
    }))
    const message = String(captured.info[0]?.[0])
    assert.match(message, /"apiKey": "\[REDACTED\]"/u)
    assert.match(message, /"self": "\[Circular\]"/u)
    assert.doesNotMatch(message, /secret/u)
})

it('isolates sink failures from callers', () => {
    const warnings: unknown[][] = []
    const log = new LivingMemoryLogger(
        {
            info: () => {
                throw new Error('sink unavailable')
            },
            warn: (...args: unknown[]) => warnings.push(args),
            error: () => {}
        } as never,
        () => true
    )

    assert.doesNotThrow(() => log.summary('事件', '详情'))
    assert.equal(warnings.length, 1)
    assert.match(String(warnings[0]?.[0]), /日志输出失败/u)
})

it('formats multi-line blocks with headings and fields', () => {
    const captured = createLogger(true)
    captured.log.diagnosticSummary(() => ({
        event: '模型输入',
        detail: '预设：surtur',
        blocks: [
            {
                title: '系统消息',
                fields: { attempt: 1 },
                key: 'system',
                value: { nested: ['a'] }
            }
        ]
    }))

    const message = String(captured.info[0]?.[0])
    assert.match(message, /========系统消息 attempt：1========/u)
    assert.match(message, /"nested": \[/u)
})