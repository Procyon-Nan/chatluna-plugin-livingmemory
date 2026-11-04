/**
 * v1 测试以 vitest 的 `globals: true` 运行，直接使用 `it` / `describe` 等全局函数。
 * 迁移到 node:test 后由本模块把同名 API 装回全局，测试体与断言保持不变。
 *
 * 另补 v1 测试用到的 vitest 能力：`it.each`、`vi.fn` 与 `expect`。
 */
import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it, test } from 'node:test'

const each = <T>(cases: readonly T[]) =>
    (
        name: string,
        fn: (value: T, index: number) => unknown
    ) =>
    cases.forEach((value, index) => {
        it(name.replace('%i', String(value)).replace('%s', String(value)), () =>
            fn(value, index)
        )
    })

type AnyFunction = (...args: any[]) => any

/** 只记录调用次数与参数，足够覆盖迁移过来的断言。 */
const fn = <F extends AnyFunction>(impl?: F) => {
    const calls: unknown[][] = []
    const spy = (...args: unknown[]) => {
        calls.push(args)
        return impl?.(...args)
    }
    return Object.assign(spy, { mock: { calls } })
}

type Matchers = Record<string, (...args: any[]) => void>

/** 部分字段匹配：`toEqual` 递归比对时遇到它只比较列出的字段。 */
interface ObjectContaining {
    __objectContaining: Record<string, unknown>
}

const isObjectContaining = (value: unknown): value is ObjectContaining =>
    typeof value === 'object' &&
    value !== null &&
    '__objectContaining' in value

const matchesShape = (actual: any, expected: any): boolean => {
    if (isObjectContaining(expected)) {
        return Object.entries(expected.__objectContaining).every(([key, value]) =>
            matchesShape(actual?.[key], value)
        )
    }
    if (Array.isArray(expected)) {
        if (!Array.isArray(actual) || actual.length !== expected.length) {
            return false
        }
        return expected.every((item, index) => matchesShape(actual[index], item))
    }
    try {
        assert.deepStrictEqual(actual, expected)
        return true
    } catch {
        return false
    }
}

/** 迁移自 vitest 测试体的断言集合，按 vitest 语义映射到 node:assert。 */
const createMatchers = (actual: any, negated: boolean): Matchers => {
    const check = (condition: boolean, message: string) => {
        if (condition === negated) {
            assert.fail(
                `${negated ? 'Expected not to ' : 'Expected to '}${message}`
            )
        }
    }
    return {
        toBe: (expected) =>
            check(
                Object.is(actual, expected),
                `be ${String(expected)}, got ${String(actual)}`
            ),
        toEqual: (expected) =>
            check(
                matchesShape(actual, expected),
                `equal ${JSON.stringify(expected)}`
            ),
        toHaveLength: (expected) =>
            check(
                actual?.length === expected,
                `have length ${expected}, got ${actual?.length}`
            ),
        toContain: (expected) =>
            check(
                actual?.includes(expected) === true,
                `contain ${JSON.stringify(expected)}`
            )
    }
}

const expect = Object.assign(
    (actual: any) => {
        const matchers = createMatchers(actual, false)
        return {
            ...matchers,
            not: createMatchers(actual, true)
        }
    },
    {
        objectContaining: (shape: Record<string, unknown>): ObjectContaining => ({
            __objectContaining: shape
        })
    }
)

Object.assign(globalThis, {
    after,
    afterEach,
    before,
    beforeEach,
    describe,
    expect,
    it: Object.assign(it, { each }),
    test,
    vi: { fn }
})