import { Context } from 'cordis'
import Schema from 'schemastery'
import type {} from '@chatluna/memory'
import LivingmemoryService from './service.ts'

export const name = 'livingmemory'

export const inject = ['chatluna', 'memory', 'database'] as const

export interface Config {}

export const Config: Schema<Config> = Schema.object({})

export async function apply(ctx: Context) {
    const service = new LivingmemoryService(ctx)
    ctx.effect(() => service.register())
    ctx.logger.info('livingmemory loaded')
}