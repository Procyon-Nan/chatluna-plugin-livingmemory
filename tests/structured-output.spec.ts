import assert from 'node:assert/strict'
import { createCapturedLogger, createStructuredChat, logger } from './workflow-test-utils.ts'
import { Schema, schemasteryToJsonSchema } from '@chatluna/schema'
import { invokeStructuredOutput } from '../src/service/workflows/structured_output.ts'
import type { Context } from 'cordis'

const schema = Schema.object({
    items: Schema.array(Schema.transform(Schema.string(), (value) => value.trim())).required(),
    note: Schema.transform(Schema.string(), (value) => value.trim()).optional()
})

const logging = { logger, stage: 'memory-extraction' } as const

const createHarness = (responses: unknown[]) => {
    const pending = [...responses]
    const { chat, calls: prompts } = createStructuredChat(() => pending.shift())
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
            schema,
            logging,
            systemPrompt: '提交结果。',
            inputPrompt: '提交结果。',
            validateResult,
            stringifiedArrayField: 'items'
        })
    }
}

it('accepts one valid structured result', async () => {
    const { result, prompts } = invoke([{ items: ['alpha'] }])

    const resolved = await result

    assert.deepEqual(resolved.value, { items: ['alpha'] })
    assert.equal(resolved.parseError, null)
    assert.match(resolved.output, /^\[attempt 1\]/u)
    assert.equal(prompts.length, 1)
    const [system, instruction, jsonSchema] = prompts[0].system.split('\n\n')
    assert.equal(system, '提交结果。')
    assert.match(instruction, /Return ONLY a JSON value/u)
    assert.deepEqual(JSON.parse(jsonSchema), schemasteryToJsonSchema(schema))
    assert.equal(prompts[0].prompt, '提交结果。')
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
    assert.match(prompts[1].prompt, /unknown item/u)
})

it('retries malformed stringified arrays with direct array guidance', async () => {
    const { result, prompts } = invoke([{ items: '[]' }, { items: ['corrected'] }])

    const resolved = await result

    assert.deepEqual(resolved.value, { items: ['corrected'] })
    assert.equal(resolved.parseError, null)
    assert.equal(prompts.length, 2)
    assert.ok(prompts[1].prompt.includes('正确 {"items":[]}'))
    assert.ok(prompts[1].prompt.includes('错误 {"items":"[]"}'))
})

it('propagates model invocation errors without a correction retry', async () => {
    const failure = new Error('model request failed')
    const { result, prompts } = invoke([failure])

    await assert.rejects(result, (error) => error === failure)
    assert.equal(prompts.length, 1)
})

it('returns a parse error after three invalid structured responses', async () => {
    const { result, prompts } = invoke([
        'no JSON',
        'no JSON',
        'no JSON'
    ])

    const resolved = await result

    assert.equal(resolved.value, null)
    assert.match(resolved.parseError ?? '', /did not contain a JSON value/u)
    assert.equal(prompts.length, 3)
    assert.match(resolved.output, /\[attempt 1\][\s\S]*\[attempt 2\][\s\S]*\[attempt 3\]/u)
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
        ctx, schema, logging, systemPrompt: '结果。', inputPrompt: '结果。', signal: controller.signal
    })
    controller.abort(new Error('disposed'))
    await assert.rejects(result, /disposed/u)
    assert.equal(calls, 1)
})

it('omits the generated schema from logs but keeps prompts, retries and raw model text', async () => {
    const captured = createCapturedLogger()
    const raw = '模型说明：\n```json\n{"items":["  trimmed  "]}\n```'
    const { ctx } = createHarness(['malformed reply', raw])
    const result = await invokeStructuredOutput({
        ctx, schema, systemPrompt: 'system', inputPrompt: 'input',
        logging: { logger: captured.logger, stage: 'memory-extraction' }
    })
    assert.deepEqual(result.value, { items: ['trimmed'] })
    const requests = captured.info.filter(line => line.includes('记忆提取模型调用'))
    assert.equal(requests.length, 2)
    for (const request of requests) {
        assert.match(request, /========系统提示词========\nsystem\n\n========消息 1 · user========\ninput/u)
        assert.doesNotMatch(request, /Return ONLY|"properties"/u)
    }
    assert.match(requests[1], /结构化结果无效/u)
    const responses = captured.info.filter(line => line.includes('记忆提取模型响应'))
    assert.ok(responses[0].includes('malformed reply'))
    assert.ok(responses[1].includes(raw))
})

it('passes the configured model through to the call', async () => {
    const harness = createHarness([{ items: ['alpha'] }])
    const resolved = await invokeStructuredOutput({
        ctx: harness.ctx,
        schema,
        systemPrompt: 's',
        inputPrompt: 'p',
        model: 'openai/gpt-4o',
        logging
    })

    assert.equal(resolved.parseError, null)
    assert.equal(harness.prompts[0].model, 'openai/gpt-4o')
})
