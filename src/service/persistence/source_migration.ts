import type { Context } from 'cordis'
import { observedSourceRoutes } from '../memory/conversation_sources.ts'

// Character 的会话键、旧平台联系人键，以及普通聊天引擎的会话 UUID。
const PEER_ALIAS = /^(?:group|private|[^:]+:(?:guild|user)):.+$/
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const LEGACY_KEY = new RegExp(`${PEER_ALIAS.source}|${UUID.source}`, 'i')
const PHYSICAL_ROUTE = /^r-[0-9a-f]{12}$/
const NATIVE_KEY = /^(?:r-[0-9a-f]{12}(?::|$)|custom:)/

/** 有旧群号或用户号时枚举一次普通路由；多个账号或频道匹配同一旧键时归入全局。 */
export async function resolveImportedSources(ctx: Context, ids: readonly (string | null)[]) {
    const wanted = [...new Set(ids.filter((id): id is string => !!id))]
    const result = new Map<string | null, string | null>()
    if (!wanted.length) return result

    const aliases = new Set(wanted.filter(key => !NATIVE_KEY.test(key) && PEER_ALIAS.test(key)))
    const exact = { key: wanted }
    const query = aliases.size ? { $or: [exact, { key: PHYSICAL_ROUTE }] } : exact
    const heads = await ctx.database.get('chatluna_conversations', query, ['key', 'peer'])
    const routes = new Map<string, string | null>(observedSourceRoutes(ctx))
    for (const { key, peer } of heads) {
        if (peer || !routes.has(key)) routes.set(key, peer)
    }

    if (aliases.size) {
        for (const [route, peer] of routes) {
            if (!peer || !PHYSICAL_ROUTE.test(route)) continue
            const match = /^([^:]+):[^:]+:(guild|user):(.+)$/.exec(peer)
            if (!match) continue
            const [, platform, kind, id] = match
            const oldKeys = [`${kind === 'guild' ? 'group' : 'private'}:${id}`, `${platform}:${kind}:${id}`]
            for (const key of oldKeys) {
                if (aliases.has(key)) result.set(key, result.has(key) ? null : route)
            }
        }
    }
    for (const key of wanted) {
        if (routes.has(key)) result.set(key, key)
    }
    return result
}

/** 启动索引对账前更新主库，沿用原有向量，只同步新的会话归属。 */
export async function migrateLegacySources(ctx: Context) {
    const rows = await ctx.database.select('living_memory_entry', { sourceConversationId: { $regex: LEGACY_KEY } })
        .groupBy('sourceConversationId').execute(['sourceConversationId'])
    const keys = rows.map(row => row.sourceConversationId).filter((key): key is string => !!key && !NATIVE_KEY.test(key))
    if (!keys.length) return
    const sources = await resolveImportedSources(ctx, keys)
    await ctx.database.transact(async db => {
        for (const key of keys) {
            const target = sources.get(key) ?? null
            if (key !== target) await db.set('living_memory_entry', { sourceConversationId: key }, { sourceConversationId: target })
        }
    })
}
