import assert from 'node:assert/strict'
import { Schema } from '@chatluna/schema'
import { invokeStructuredOutput } from '../src/service/workflows/structured_output.ts'
import type { Context } from 'cordis'

const schema = Schema.object({
    items: Schema.array(Schema.transform(Schema.string(), (value) => value.trim())).required(),
    note: Schema.transform(Schema.string(), (value) => value.trim()).optional()
})

/** 按顺序返回预设响应：值表示成功，Error 表示模型调用失败。 */
const createHarness = (responses: (unknown | Error)[]) => {
    const pending = [...responses]
    const prompts: { prompt: string; system: string; model?: string }[] = []
    const ctx = {
        chatluna: {
            extract: async (_schema: unknown, options: { prompt: string; system?: string; model?: string }) => {
                prompts.push({ prompt: options.prompt, system: options.system ?? '', ...(options.model === undefined ? {} : { model: options.model }) })
                const response = pending.shift()
                if (response === undefined) throw new Error('missing fake model response')
                if (response instanceof Error) throw response
                return response
            }
        }
    } as unknown as Context
    return { ctx, prompts }
}

const invoke = (
    responses: (unknown | Error)[],
    validateResult?: (value: { items: string[]; note?: string }) => string | undefined
) => {
    const harness = createHarness(responses)
    return {
        ...harness,
        result: invokeStructuredOutput({
            ctx: harness.ctx,
            schema,
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
    assert.equal(prompts[0].system, '提交结果。')
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
    const { result, prompts } = invoke([new Error('items is not an array'), { items: ['corrected'] }])

    const resolved = await result

    assert.deepEqual(resolved.value, { items: ['corrected'] })
    assert.equal(resolved.parseError, null)
    assert.equal(prompts.length, 2)
    assert.ok(prompts[1].prompt.includes('正确 {"items":[]}'))
    assert.ok(prompts[1].prompt.includes('错误 {"items":"[]"}'))
})

it('propagates model invocation errors after the retry budget', async () => {
    const failure = new Error('model request failed')
    const { result, prompts } = invoke([failure, failure, failure])

    const resolved = await result

    assert.equal(resolved.value, null)
    assert.match(resolved.parseError ?? '', /model request failed/u)
    assert.equal(prompts.length, 3)
})

it('returns a parse error after three invalid structured responses', async () => {
    const { result, prompts } = invoke([
        new Error('schema mismatch'),
        new Error('schema mismatch'),
        new Error('schema mismatch')
    ])

    const resolved = await result

    assert.equal(resolved.value, null)
    assert.match(resolved.parseError ?? '', /schema mismatch/u)
    assert.equal(prompts.length, 3)
    assert.match(resolved.output, /\[attempt 1\][\s\S]*\[attempt 2\][\s\S]*\[attempt 3\]/u)
})

it('propagates cancellation without entering correction retries', async () => {
    const controller = new AbortController()
    let calls = 0
    const ctx = {
        chatluna: {
            extract: async () => {
                calls += 1
                controller.abort(new Error('disposed'))
                return { items: ['invalid'] }
            }
        }
    } as unknown as Context

    await assert.rejects(
        invokeStructuredOutput({
            ctx,
            schema,
            systemPrompt: '结果。',
            inputPrompt: '结果。',
            signal: controller.signal
        }),
        /disposed|abort/iu
    )
    assert.equal(calls, 1)
})

it('passes the configured model through to the call', async () => {
    const harness = createHarness([{ items: ['alpha'] }])
    const resolved = await invokeStructuredOutput({
        ctx: harness.ctx,
        schema,
        systemPrompt: 's',
        inputPrompt: 'p',
        model: 'openai/gpt-4o'
    })

    assert.equal(resolved.parseError, null)
    assert.equal(harness.prompts[0].model, 'openai/gpt-4o')
})