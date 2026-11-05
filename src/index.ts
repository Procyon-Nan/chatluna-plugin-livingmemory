import type { Context } from 'cordis'
import Schema from 'schemastery'
import type {} from '@chatluna/memory'
import type {} from '@chatluna/chat-observer'
import type {} from '@chatluna/agent'
import LivingmemoryService from './service.ts'

export const name = 'livingmemory'

/**
 * `inject` 是加载前置条件：任一项缺失时 cordis 会把插件置为 INACTIVE、整段
 * `apply` 不执行。这里只列 v2 实际存在的服务。消息采集走 `chat_observer`
 * 的拉取接口，领域钩子走 `ctx.agents.prepareStep` 与 `chatluna/agent-turn`。
 */
export const inject = [
    'chatluna',
    'memory',
    'database',
    'chat_observer',
    'agents'
] as const

export interface Config {}

export const Config: Schema<Config> = Schema.object({})

export async function apply(ctx: Context) {
    const service = new LivingmemoryService(ctx)
    ctx.effect(() => service.start())
    ctx.logger.info('livingmemory loaded')
}