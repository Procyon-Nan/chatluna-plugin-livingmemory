import type { Context } from 'cordis'
import type { RouteIdentity } from '@chatluna/satori'
import type { MemorySourceLabel } from '../../contracts/memory.ts'

export interface SourcePeer {
    key: string
    id: string
    kind: 'guild' | 'user'
    name?: string | undefined
}

export function sourcePeerOf({ platform, selfId, isDirect, userId, guildId }: RouteIdentity): SourcePeer | undefined {
    const kind = isDirect ? 'user' : 'guild'
    const id = isDirect ? userId : guildId
    if (id) return { kind, id, key: `${platform}:${selfId}:${kind}:${id}` }
}

export const formatConversationPeer = (peer: SourcePeer) => {
    const address = `${peer.kind === 'guild' ? '群聊' : '用户'} ID：${peer.id}`
    return peer.name ? `「${peer.name}」（${address}）` : address
}

export function knownName(id: string, name?: string | null) {
    if (name && name !== id) return name
}

export async function peerName(ctx: Context, peer: SourcePeer, storedName?: string) {
    const name = knownName(peer.id, peer.name) ?? knownName(peer.id, storedName)
    if (name) return name
    const profile = await ctx.routing.peers.profile(peer.key)
    return knownName(peer.id, profile.name)
}

/** 跨群对话只持久化一个会话头，各消息的实际路由由框架的频道记录提供。 */
export function observedSourceRoutes(ctx: Context) {
    const routes = new Map<string, string>()
    const observer = ctx.get('chat_observer')
    if (!observer) return routes
    for (const { conversationKey } of observer.channelStats()) {
        if (!conversationKey.startsWith('custom:')) continue
        const channel = observer.channelOf(conversationKey)
        if (!channel) continue
        const peer = sourcePeerOf(channel.identity)
        if (peer) routes.set(channel.routeId, peer.key)
    }
    return routes
}

/** 标准会话、个人会话和存档都以实际路由开头；自定义会话的首个联系人不能代表整段聊天。 */
export async function resolveConversationSources(ctx: Context, conversationIds: readonly (string | null)[]) {
    const sources = new Map<string, SourcePeer>()
    const keys = [...new Set(conversationIds.filter((key): key is string => key !== null && /^r-[0-9a-f]{12}(?::|$)/.test(key)))]
    if (keys.length === 0) return sources

    const rows = await ctx.database.get('chatluna_conversations', { key: keys }, ['key', 'peer'])
    const byRoute = new Map<string, string>()
    for (const { key, peer } of rows) if (peer) byRoute.set(key, peer)
    if (byRoute.size < keys.length) {
        const observed = observedSourceRoutes(ctx)
        for (const key of keys) {
            const peer = observed.get(key)
            if (peer) byRoute.set(key, peer)
        }
    }
    if (!byRoute.size) return sources

    const peers = await ctx.routing.peers.get([...new Set(byRoute.values())])
    for (const [key, peer] of byRoute) {
        const ref = peers.get(peer)
        if (!ref || (ref.kind !== 'guild' && ref.kind !== 'user')) continue
        const { kind, id } = ref
        const source = { key: ref.key, kind, id, name: ref.name }
        source.name = await peerName(ctx, source)
        sources.set(key, source)
    }
    return sources
}

export async function withSourceLabels<T extends { sourceConversationId: string | null }>(ctx: Context, entries: readonly T[]) {
    const sources = await resolveConversationSources(ctx, entries.map(entry => entry.sourceConversationId))
    return entries.map(entry => {
        const source = entry.sourceConversationId ? sources.get(entry.sourceConversationId) : undefined
        const sourceLabel: MemorySourceLabel = `来源 · ${source?.name ? formatConversationPeer(source) : 'unknown'}`
        return { ...entry, sourceLabel }
    })
}
