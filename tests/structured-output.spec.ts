import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { createCapturedLogger, createResultToolChat, logger, toolFeedback } from './workflow-test-utils.ts'
import { Schema, schemasteryToJsonSchemaNode } from '@chatluna/schema'
import { CallId } from '@chatluna/symbol'
import { ModelError } from '@chatluna/ai'
import { invokeStructuredOutput } from '../src/service/workflows/structured_output.ts'
import type { Context } from 'cordis'

const schema = Schema.object({
    items: Schema.array(Schema.transform(Schema.string(), (value) => value.trim())).required(),
    note: Schema.transform(Schema.string(), (value) => value.trim()).optional()
})

const logging = { logger, stage: 'memory-extraction' } as const
const tool = { name: 'submit_result', description: '提交结果。', schema }
const call = (id: string, name = tool.name, item = 'alpha') => ({
    type: 'tool-call' as const, toolCallId: CallId(id), toolName: name, input: { items: [item] }
})

const createHarness = (responses: unknown[]) => {
    const pending = [...responses]
    const { chat, calls: prompts } = createResultToolChat(tool.name, () => pending.shift())
    const ctx = { chatluna: { chat } } as unknown as Context
    return { ctx, prompts }
}

const invoke = (
    responses: unknown[],
    validateResult?: (value: { items: string[]; note?: string }) => string | undefined
) => {
    const harness = createHarness(responses)
    return {
        ...harness,
        result: invokeStructuredOutput({
            ctx: harness.ctx,
            tool,
            logging,
            systemPrompt: '提交结果。',
            inputPrompt: '提交结果。',
            validateResult,
            stringifiedArrayField: 'items'
        })
    }
}

it('requires the result tool and reads its arguments even when the text contains a different valid answer', async () => {
    const { result, prompts } = invoke([[
        { type: 'text', text: '{"items":["from-text"]}' },
        call('valid')
    ]])

    const resolved = await result

    assert.deepEqual(resolved.value, { items: ['alpha'] })
    assert.equal(resolved.parseError, null)
    assert.equal(prompts.length, 1)
    const request = prompts[0]!
    assert.equal(request.system, '提交结果。')
    assert.equal(request.prompt, '提交结果。')
    assert.deepEqual(request.toolSpecs, [{ name: tool.name, description: tool.description, parameters: schemasteryToJsonSchemaNode(schema) }])
})

it('retries results rejected by contextual validation', async () => {
    const { result, prompts } = invoke(
        [{ items: ['unknown'] }, { items: ['corrected'] }],
        ({ items }) => (items.includes('unknown') ? 'unknown item' : undefined)
    )

    const resolved = await result

    assert.deepEqual(resolved.value, { items: ['corrected'] })
    assert.equal(resolved.parseError, null)
    assert.equal(prompts.length, 2)
    const [feedback] = toolFeedback(prompts[1]!)
    assert.equal(feedback!.toolCallId, 'call-1')
    assert.equal(feedback!.output.type, 'text')
    assert.match(feedback!.output.value, /unknown item/u)
})

it('retries malformed stringified arrays with direct array guidance', async () => {
    const { result, prompts } = invoke([{ items: '[]' }, { items: ['corrected'] }])

    const resolved = await result

    assert.deepEqual(resolved.value, { items: ['corrected'] })
    assert.equal(resolved.parseError, null)
    assert.equal(prompts.length, 2)
    const [feedback] = toolFeedback(prompts[1]!)
    assert.equal(feedback!.output.type, 'text')
    assert.match(feedback!.output.value, /调用 submit_result 一次/u)
    assert.match(feedback!.output.value, /参数 items 要传数组/u)
})

it('rejects a wrong tool and a multi-call response as whole attempts, replying to every rejected call ID', async () => {
    const { result, prompts } = invoke([
        [call('wrong-id', 'other_tool')],
        [call('valid-in-batch'), call('extra-id', 'other_tool')],
        { items: ['corrected'] }
    ])
    assert.deepEqual((await result).value, { items: ['corrected'] })
    assert.equal(prompts.length, 3)
    assert.deepEqual(toolFeedback(prompts[1]!).map(block => block.toolCallId), ['wrong-id'])
    assert.deepEqual(toolFeedback(prompts[2]!).slice(-2).map(block => block.toolCallId), ['valid-in-batch', 'extra-id'])
})

it('propagates model invocation errors without a correction retry', async () => {
    const failure = new Error('model request failed')
    const { result, prompts } = invoke([failure])

    await assert.rejects(result, (error) => error === failure)
    assert.equal(prompts.length, 1)
})

it('propagates an error or abort finish without retrying or accepting partial tool calls', async () => {
    for (const [kind, code] of [['error', 'TRANSPORT'], ['aborted', 'ABORTED']] as const) {
        for (const toolCalls of [[], [call('partial')]]) {
            let attempts = 0
            const failure = { code, message: 'provider stopped', retryable: false }
            const chat = async () => {
                attempts++
                return { text: '', content: toolCalls, toolCalls, finish: { kind, failure } }
            }
            const ctx = { chatluna: { chat } } as unknown as Context
            await assert.rejects(
                invokeStructuredOutput({ ctx, tool, logging, systemPrompt: '规则', inputPrompt: '输入' }),
                error => ModelError.is(error, code) && error.message === failure.message
            )
            assert.equal(attempts, 1)
        }
    }
})

it('rejects valid JSON text without a tool call and stops after three attempts', async () => {
    const { result, prompts } = invoke(Array(3).fill('{"items":["alpha"]}'))

    const resolved = await result

    assert.equal(resolved.value, null)
    assert.ok(resolved.parseError)
    assert.equal(prompts.length, 3)
    assert.equal(prompts[1]!.messages.at(-1)?.role, 'user')
    assert.match(JSON.stringify(prompts[1]!.messages.at(-1)?.content), /submit_result/u)
})

it('propagates cancellation without entering correction retries', async () => {
    const controller = new AbortController()
    const pending = Promise.withResolvers<never>()
    let calls = 0
    const ctx = {
        chatluna: {
            chat: () => {
                calls += 1
                return Object.assign(pending.promise, { abort: pending.reject })
            }
        }
    } as unknown as Context

    const result = invokeStructuredOutput({
        ctx, tool, logging, systemPrompt: '结果。', inputPrompt: '结果。', signal: controller.signal
    })
    controller.abort(new Error('disposed'))
    await assert.rejects(result, /disposed/u)
    assert.equal(calls, 1)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

it('logs the submitted tool arguments without reasoning, narration or tool definitions', async () => {
    const captured = createCapturedLogger()
    const { ctx } = createHarness([[
        { type: 'reasoning', text: '内部思考' },
        { type: 'text', text: '模型多余旁白' },
        call('valid', tool.name, '  trimmed  ')
    ]])
    const result = await invokeStructuredOutput({
        ctx, tool, systemPrompt: 'system', inputPrompt: 'input',
        logging: { logger: captured.logger, stage: 'memory-extraction' }
    })
    assert.deepEqual(result.value, { items: ['trimmed'] })
    const log = captured.info.join('\n')
    assert.match(log, /========系统提示词========\nsystem\n\n========消息 1 · user========\ninput/u)
    assert.ok(log.includes('submit_result\n' + JSON.stringify({ items: ['  trimmed  '] }, null, 2)))
    assert.doesNotMatch(log, /内部思考|模型多余旁白|Return ONLY|"properties"/u)
})

it('logs each new correction even when its wording repeats, and resets between workflows', async () => {
    const captured = createCapturedLogger()
    const { ctx, prompts } = createHarness([{ items: 'wrong' }, { items: 'wrong' }, { items: ['corrected'] }, { items: [] }])
    const options = { ctx, tool, systemPrompt: '固定系统词', inputPrompt: '原始聊天', logging: { ...logging, logger: captured.logger } }
    await invokeStructuredOutput(options)
    await invokeStructuredOutput(options)
    const requests = captured.info.filter(line => line.startsWith('事件：记忆提取模型调用;'))
    assert.equal(requests.length, 4)
    assert.match(requests[0]!, /固定系统词[\s\S]*原始聊天/u)
    for (const i of [1, 2]) {
        assert.match(requests[i]!, /提交失败/u)
        assert.doesNotMatch(requests[i]!, /固定系统词|原始聊天| · assistant========/u)
        assert.equal(prompts[i]!.system, options.systemPrompt)
        assert.equal(prompts[i]!.prompt, options.inputPrompt)
    }
    assert.match(requests[3]!, /固定系统词[\s\S]*原始聊天/u)
})

it('passes the configured model through to the call', async () => {
    const harness = createHarness([{ items: ['alpha'] }])
    const resolved = await invokeStructuredOutput({
        ctx: harness.ctx,
        tool,
        systemPrompt: 's',
        inputPrompt: 'p',
        model: 'openai/gpt-4o',
        logging
    })

    assert.equal(resolved.parseError, null)
    assert.equal(harness.prompts[0].model, 'openai/gpt-4o')
})
