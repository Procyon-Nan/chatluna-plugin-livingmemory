import { Context } from 'cordis'
import { database as conversationsDatabase } from '@chatluna/conversations'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import { LivingMemoryRepository } from '../src/service/persistence/repository.ts'

export const createTestContext = (baseUrl = process.cwd()) => {
  const ctx = new Context()
  ctx.baseUrl = baseUrl
  return ctx
}

/**
 * 每个测试独立的内存 SQLite 实例。表定义必须在驱动加载后注册：`ctx.model.extend`
 * 依赖 `model` 服务，字段与索引的迁移在 `database.prepared()` 时统一执行。
 */
export const withLivingMemoryRepository = async (
  callback: (ctx: Context, repository: LivingMemoryRepository) => Promise<void>
) => {
  const ctx = createTestContext()
  await ctx.plugin(Database)
  await ctx.plugin(SQLiteDriver, { path: ':memory:' })
  await ctx.plugin(conversationsDatabase)
  const repository = new LivingMemoryRepository(ctx)
  repository.defineTables()
  await ctx.database.prepared()

  try {
    await callback(ctx, repository)
  } finally {
    await ctx.fiber.dispose()
  }
}