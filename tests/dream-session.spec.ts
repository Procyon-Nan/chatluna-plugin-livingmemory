import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { estimateMessageTokens } from '@chatluna/utils'
import type { Context } from 'cordis'
import type { ChatOptions as ChatRequest } from '@chatluna/ai-runtime/ops'
import { ModelId, ProviderId } from '@chatluna/symbol'
import { Schema } from '@chatluna/schema'
import type { ChatBlock, ChatToolCallBlock } from '@chatluna/message'
import { LivingMemoryLogger } from '../src/service/logging/logger.ts'
import { buildDreamMemoryBatchPrompt } from '../src/service/prompts/dream.ts'
import { DreamSessionHistory } from '../src/service/workflows/dream/session/history.ts'
import { runDreamSession } from '../src/service/workflows/dream/session/runner.ts'
import {
    createDreamSessionState,
    getDreamCoverage,
    recordDreamOperation
} from '../src/service/workflows/dream/session/state.ts'
import type { DreamBatch } from '../src/service/workflows/dream/types.ts'
import type { LivingMemoryLoopTool } from '../src/service/workflows/tool_call.ts'

interface ChatFold {
    finish: { kind: 'tool-calls' | 'stop' }
    content: readonly ChatBlock[]
    text: string
    toolCalls: readonly ChatToolCallBlock[]
    usage?: { inputTokens?: number }
}

const cluster = (id: string): DreamBatch => ({
    id,
    entries: [
        {
            id,
            presetId: 'preset',
            type: 'fact',
            content: `正文 ${id}`,
            summary: `摘要 ${id}`,
            keywords: ['关键词'],
            sentiment: '平静',
            importance: 0.7,
            speakerKeys: [],
            sourceConversationId: null,
            updatedAt: new Date('2026-10-19T01:00:00Z')
        }
    ]
})

const logger = () => {
    const logs: string[] = []
    return {
        logs,
        logger: new LivingMemoryLogger(
            {
                info: (value: string) => logs.push(value),
                warn: () => {},
                error: () => {}
            },
            () => true
        )
    }
}

const toolCall = (name: string, input: unknown, id: string) => {
    const block: ChatToolCallBlock = {
        type: 'tool-call',
        toolCallId: id as never,
        toolName: name,
        input: input as never
    }
    return block
}

const callFold = (...blocks: ChatToolCallBlock[]): ChatFold => ({
    finish: { kind: 'tool-calls' },
    content: blocks,
    text: '',
    toolCalls: blocks
})

const textFold = (text: string): ChatFold => ({
    finish: { kind: 'stop' },
    content: [{ type: 'text', text }],
    text,
    toolCalls: []
})

const checkedArgs = Schema.object({
    memoryIds: Schema.array(Schema.string()).required(),
    reason: Schema.string().required()
})

const updateArgs = Schema.object({
    memoryId: Schema.string().required()
})

const check = (memoryIds: string[], id: string) =>
    toolCall(
        'living_memory_checked_memory',
        { memoryIds, reason: '内容准确完整' },
        id
    )

/**
 * 构造一轮可重复使用的会话输入。`respond` 收到的请求就是 `ctx.chatluna.chat`
 * 的入参，可以直接断言历史、工具清单与模型地址。
 */
const createRun = (options: {
    respond: (request: ChatRequest, index: number) => ChatFold
    batches?: (string | string[])[]
    maxTokenLimit?: number
}) => {
    const requests: ChatRequest[] = []
    const batches = options.batches ?? ['a', 'b']
    const state = createDreamSessionState(batches.flatMap((batch) => batch))
    state.batches = batches.map((batch, index) => {
        if (typeof batch === 'string') return cluster(batch)
        return {
            id: `batch-${index}`,
            entries: batch.flatMap((id) => cluster(id).entries)
        }
    })
    const checked: LivingMemoryLoopTool = {
        name: 'living_memory_checked_memory',
        description: '检查记忆',
        args: checkedArgs,
        async run(input: unknown) {
            const { memoryIds } = input as { memoryIds: string[] }
            recordDreamOperation(state, memoryIds, 'kept')
            return { warnings: [] }
        }
    }
    const update: LivingMemoryLoopTool = {
        name: 'living_memory_update_memory',
        description: '更新记忆',
        args: updateArgs,
        async run(input: unknown) {
            const { memoryId } = input as { memoryId: string }
            recordDreamOperation(state, [memoryId], 'updated')
            return '更新成功'
        }
    }
    const tools = [checked, update] as LivingMemoryLoopTool[]
    const captured = logger()
    const ctx = {
        chatluna: {
            chat: async (request: ChatRequest) => {
                requests.push(request)
                await request.beforeDispatch?.({ system: request.system, messages: request.messages },
                    { provider: ProviderId('test'), model: ModelId('test-model') }, { degradations: [] })
                return options.respond(request, requests.length)
            }
        }
    } as unknown as Context
    return {
        requests,
        tools,
        logs: captured.logs,
        run: (overrides: { signal?: AbortSignal } = {}) =>
            runDreamSession({
                ctx,
                model: 'test-model',
                maxTokenLimit: options.maxTokenLimit ?? 1_000_000,
                presetId: 'preset',
                assistantLabel: '角色',
                presetPrompt: '人设',
                speakers: [],
                state,
                tools,
                logger: captured.logger,
                ...overrides
            }),
        state
    }
}

const userTexts = (request: ChatRequest | undefined) =>
    (request?.messages ?? [])
        .filter((message) => message.role === 'user')
        .map((message) =>
            message.content
                .map((block) => (block.type === 'text' ? block.text : ''))
                .join('')
        )

it('drives the dream conversation with stable prefixes and paired tools', async () => {
    const run = createRun({
        batches: [['a', 'b']],
        respond: (_request, index) =>
            index === 1
                ? callFold(
                      toolCall(
                          'living_memory_update_memory',
                          { memoryId: 'a' },
                          'update-1'
                      ),
                      check(['a'], 'check-a')
                  )
                : callFold(check(['b'], 'check-b'))
    })
    await run.run()

    assert.equal(run.requests.length, 2)
    const progress = userTexts(run.requests[1]).at(-1)!
    assert.match(progress, /当前批次尚未处理的记忆 ID：b\n/u)
    assert.doesNotMatch(progress, /本轮模型请求或工具执行失败|次模型调用内未完成/u)
    assert.ok(!run.logs.some((log) => log.includes('Dream 本轮处理失败')))
    assert.deepEqual(getDreamCoverage(run.state), {
        targetCount: 2,
        processedCount: 2,
        unprocessedMemoryIds: []
    })
    assert.ok(run.requests[0]!.system)
    assert.equal(run.requests[1]!.system, run.requests[0]!.system)
    // 第二轮在首轮历史之上追加：system 与批次输入保持同一前缀。
    assert.deepEqual(
        run.requests[1]!.messages.slice(0, run.requests[0]!.messages.length),
        run.requests[0]!.messages
    )
    assert.deepEqual(
        run.requests[1]!.messages.map((message) => message.role),
        ['user', 'assistant', 'tool', 'tool', 'user']
    )
    assert.deepEqual(
        run.requests[1]!.messages
            .filter((message) => message.role === 'tool')
            .map((message) =>
                message.content
                    .filter((block) => block.type === 'tool-result')
                    .map((block) => block.toolCallId)
            )
            .flat(),
        ['update-1', 'check-a']
    )
    for (const request of run.requests) {
        assert.equal(request.model, 'test-model')
        assert.equal(request.toolSpecs?.length, 2)
    }
})

it('keeps successful work, retries ineffective rounds and moves on after three consecutive failures', async () => {
    const run = createRun({
        batches: ['a', 'b', 'c'],
        respond: (_request, index) => {
            if (index === 1) return callFold(check(['a'], 'first'))
            if (index === 2 || index === 5) {
                throw new Error('request failed')
            }
            if (index === 3) {
                return callFold(toolCall('missing', {}, 'bad'))
            }
            if (index === 4) {
                return callFold(
                    toolCall(
                        'living_memory_update_memory',
                        { memoryId: 'a' },
                        'update'
                    )
                )
            }
            if (index < 8) return textFold('这一批结束了')
            return callFold(check(['c'], 'last'))
        }
    })
    await run.run()

    assert.equal(run.requests.length, 8)
    const requests = run.logs.filter(line => line.startsWith('事件：Dream模型调用;'))
    assert.equal(requests.filter(line => line.includes('========系统提示词========')).length, 1)
    assert.match(requests[1]!, /正文 b/u)
    assert.doesNotMatch(requests[1]!, /正文 a/u)
    assert.match(requests[2]!, /request failed/u)
    assert.match(requests[5]!, /request failed/u)
    const failures = run.logs.filter((log) => log.includes('Dream 本轮处理失败'))
    assert.equal(failures.length, 2)
    for (const failure of failures) assert.match(failure, /request failed/u)
    for (const nextRequest of [run.requests[2], run.requests[5]]) {
        assert.match(userTexts(nextRequest).at(-1)!, /request failed/u)
    }
    assert.deepEqual(
        getDreamCoverage(run.state).unprocessedMemoryIds,
        ['b']
    )
    assert.equal(run.state.skippedBatches.length, 1)
    assert.deepEqual(run.state.skippedBatches[0]!.memoryIds, ['b'])
    assert.ok(
        userTexts(run.requests[7]).some((text) => text.includes('跳过本批'))
    )
})

it('limits repeated updates of processed memories to sixty rounds and preserves partial batch results', async () => {
    const run = createRun({
        batches: [['a', 'b'], 'c'],
        respond: (_request, index) => {
            if (index === 1) return callFold(check(['a'], 'a'))
            if (index <= 60) {
                return callFold(
                    toolCall(
                        'living_memory_update_memory',
                        { memoryId: 'a' },
                        `update-${index}`
                    )
                )
            }
            return callFold(check(['c'], 'c'))
        }
    })
    await run.run()

    assert.equal(run.requests.length, 61)
    assert.deepEqual(
        getDreamCoverage(run.state).unprocessedMemoryIds,
        ['b']
    )
    assert.match(run.state.skippedBatches[0]!.reason, /60/u)
})

it('stops further writes when cancelled between tools in one response', async () => {
    const controller = new AbortController()
    const run = createRun({
        respond: () =>
            callFold(check(['a'], 'a'), check(['b'], 'b'))
    })
    const checkedTool = run.tools[0]!
    run.tools[0] = {
        ...checkedTool,
        async run(input: unknown) {
            const result = await checkedTool.run(input)
            controller.abort(new Error('disposed'))
            return result
        }
    } as LivingMemoryLoopTool

    await assert.rejects(
        run.run({ signal: controller.signal }),
        /disposed/u
    )
    assert.deepEqual([...run.state.processedMemoryIds], ['a'])
})

it('compresses only older batches and retains complete current input', async () => {
    const { logger: capturedLogger, logs } = logger()
    const compressionRequests: ChatRequest[] = []
    const history = new DreamSessionHistory(
        {
            chatluna: {
                chat: async (request: ChatRequest) => {
                    compressionRequests.push(request)
                    // 框架可将系统提示词折入第一条用户消息。
                    const content: ChatBlock[] = [{ type: 'text', text: `[system]\n${request.system}` }, ...request.messages[0]!.content]
                    const model = { provider: ProviderId('test'), model: ModelId('test-model') }
                    const folded = { messages: [{ role: 'user' as const, content }] }
                    await request.beforeDispatch?.(folded, model, { degradations: ['system-to-user'] })
                    await request.beforeDispatch?.({ system: request.system, messages: request.messages }, model, { degradations: [] })
                    await request.beforeDispatch?.(folded, model, { degradations: ['system-to-user'] })
                    return textFold('早期结论与相关 ID')
                }
            }
        } as unknown as Context,
        'test-model',
        '固定系统',
        capturedLogger
    )
    history.startBatch('早期记忆')
    history.messages.push({
        role: 'assistant',
        content: [
            { type: 'reasoning', text: '历史压缩前的模型思考' },
            toolCall('living_memory_checked_memory', { ids: ['a'] }, 'early-call')
        ]
    })
    const current = buildDreamMemoryBatchPrompt(cluster('current').entries.map(entry => ({ ...entry, sourceLabel: '来源 · unknown' })), [])
    history.startBatch(current)
    history.messages.push({
        role: 'tool',
        content: [
            {
                type: 'tool-result',
                toolCallId: 'current-call' as never,
                toolName: 'living_memory_checked_memory',
                output: { type: 'text', value: '当前结果'.repeat(1000) }
            }
        ]
    })
    history.recordUsage({ inputTokens: 200_000 })

    const signal = new AbortController().signal
    const messages = await history.prepareMessages(1_000_000, signal)
    assert.equal(getEventListeners(signal, 'abort').length, 0)
    assert.equal(messages[0]!.role, 'user')
    assert.match(
        String((messages[0]!.content[0] as { text: string }).text),
        /早期结论/u
    )
    assert.equal(
        String((messages[1]!.content[0] as { text: string }).text),
        current
    )
    assert.equal(compressionRequests.length, 1)
    assert.ok(logs.some(message => message.includes('Dream 上下文压缩模型调用') && message.includes('早期记忆')))
    const dispatches = logs.filter(message => message.startsWith('事件：Dream 上下文压缩模型调用;'))
    assert.equal(dispatches.length, 3)
    assert.match(dispatches[0]!, /你负责压缩/u)
    for (const retry of dispatches.slice(1)) assert.doesNotMatch(retry, /========|早期记忆|你负责压缩/u)
    assert.ok(logs.some(message => message.includes('Dream 上下文压缩模型响应') && message.includes('早期结论与相关 ID')))
    const compressionInput = JSON.stringify(compressionRequests[0]!.messages)
    assert.match(compressionInput, /历史压缩前的模型思考/u)
    assert.doesNotMatch(logs.join('\n'), /历史压缩前的模型思考/u)
    assert.ok(logs.some(message => message.includes('living_memory_checked_memory')))
    assert.ok(
        compressionInput.includes('早期记忆'),
        '压缩输入包含更早批次'
    )
    assert.ok(
        !compressionInput.includes('current-call'),
        '压缩输入不包含当前批次的工具交换'
    )
})

it('uses only reported input for the threshold, without local estimates', async () => {
    let calls = 0
    const history = new DreamSessionHistory(
        {
            chatluna: {
                chat: async () => {
                    calls++
                    return textFold('摘要')
                }
            }
        } as unknown as Context,
        'test-model',
        'system',
        logger().logger
    )
    history.startBatch('旧'.repeat(310_000))
    history.startBatch('当前完整字段')
    assert.equal((await history.prepareMessages(990_000)).length, 2)
    history.recordUsage({ inputTokens: 199_999 })
    assert.equal((await history.prepareMessages(990_000)).length, 2)
    assert.equal(calls, 0)
    history.recordUsage({ inputTokens: 200_000 })
    const compressed = await history.prepareMessages(990_000)
    assert.match(
        String((compressed[0]!.content[0] as { text: string }).text),
        /dream_history_summary/u
    )
    assert.equal(calls, 1)
})

it('leaves old history intact after a failed compression', async () => {
    let fail = true
    const history = new DreamSessionHistory(
        {
            chatluna: {
                chat: async () => {
                    if (fail) throw new Error('summary failed')
                    return textFold('保留结论')
                }
            }
        } as unknown as Context,
        'test-model',
        'system',
        logger().logger
    )
    history.startBatch('早期记忆')
    history.startBatch('当前完整字段')
    history.recordUsage({ inputTokens: 200_000 })
    history.recordUsage(undefined)
    history.recordUsage({ inputTokens: Number.NaN })
    await assert.rejects(
        history.prepareMessages(990_000),
        /summary failed/u
    )
    fail = false
    const messages = await history.prepareMessages(990_000)
    assert.equal(
        String((messages[1]!.content[0] as { text: string }).text),
        '当前完整字段'
    )
})

it('rejects oversized input instead of letting the host drop current batch messages', async () => {
    const history = new DreamSessionHistory(
        { chatluna: { chat: async () => textFold('unused') } } as unknown as Context,
        'test-model',
        'system',
        logger().logger
    )
    history.startBatch('当前完整字段'.repeat(1000))
    history.messages.push({
        role: 'user',
        content: [{ type: 'text', text: '继续' }]
    })
    const budget = history.messages.reduce((size, entry) => size + estimateMessageTokens(entry),
        estimateMessageTokens({ content: [{ type: 'text', text: 'system' }] }))
    await history.prepareMessages(budget)
    await assert.rejects(
        history.prepareMessages(budget - 1),
        /输入超过模型可用预算/u
    )
})

it('returns coverage for a singleton post-extraction group without model calls', async () => {
    const run = createRun({
        batches: [['a', 'b']],
        respond: () => callFold(check(['a'], 'a'))
    })
    await run.run()
    assert.equal(getDreamCoverage(run.state).processedCount, 1)
    assert.deepEqual(
        getDreamCoverage(run.state).unprocessedMemoryIds,
        ['b']
    )
})
