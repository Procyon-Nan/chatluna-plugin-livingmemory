/**
 * v1 测试以 vitest 的 `globals: true` 运行，直接使用 `it` / `describe` 等全局函数。
 * 迁移到 node:test 后由本模块把同名 API 装回全局，测试体与断言保持不变。
 */
import { after, afterEach, before, beforeEach, describe, it, test } from 'node:test'

Object.assign(globalThis, { after, afterEach, before, beforeEach, describe, it, test })