import type { Context } from 'cordis'
import { routeIdOf } from '@chatluna/satori'
import type { ChatHistoryEntry } from '../chat_history.ts'

export interface MemoryTranscriptOrigin {
    header: string
    sourceLabel: string | null
}

export interface SourcePeer {
    key: string
    id: string
    kind: 'guild' | 'user'
    name?: string | undefined
}

const formatSource = (peer: SourcePeer, name?: string) => {
    const address = `${peer.kind === 'guild' ? '群聊' : '用户'} ID：${peer.id}`
    return name ? `「${name}」（${address}）` : address
}

function knownName(id: string, name?: string | null) {
    return name && name !== id ? name : undefined
}

async function peerName(ctx: Context, peer: SourcePeer, storedName?: string) {
    const name = knownName(peer.id, peer.name) ?? knownName(peer.id, storedName)
    return name ?? knownName(peer.id, (await ctx.routing.peers.profile(peer.key)).name)
}

function ownsRoute(key: string, platform: string, selfId: string, { kind, id }: SourcePeer) {
    if (kind === 'user') return routeIdOf({ platform, selfId, userId: id, isDirect: true }) === key
    const guild = { platform, selfId, userId: '', guildId: id, isDirect: false }
    return routeIdOf(guild) === key || routeIdOf({ ...guild, channelId: id }) === key
}

/** 仅当群/用户本身可生成这条标准路由时才补名称；共享会话记录的是首个联系人。 */
export async function resolveConversationSources(ctx: Context, conversationIds: readonly string[]) {
    const sources = new Map<string, string>()
    if (!conversationIds.length) return sources
    const rows = await ctx.database.get('chatluna_conversations', { key: [...new Set(conversationIds)] }, ['key', 'peer'])
    const keys = [...new Set(rows.flatMap(row => row.peer ? [row.peer] : []))]
    if (!keys.length) return sources
    const peers = await ctx.routing.peers.get(keys)
    for (const { key, peer } of rows) {
        const ref = peer && peers.get(peer)
        if (!ref || (ref.kind !== 'guild' && ref.kind !== 'user')) continue
        const { platform, selfId, kind, id } = ref
        const source = { key: ref.key, kind, id, name: ref.name }
        if (!ownsRoute(key, platform, selfId, source)) continue
        const name = await peerName(ctx, source)
        if (name) sources.set(key, formatSource(source, name))
    }
    return sources
}

export async function resolveTranscriptOrigin(ctx: Context, entries: readonly ChatHistoryEntry[]): Promise<MemoryTranscriptOrigin> {
    const peers = new Map<string, SourcePeer>()
    for (const { source } of entries) {
        // 不能证明整批的出处时，不用其中一条已知消息代表整批。
        if (!source) return { header: '以下是本次会话的聊天记录：', sourceLabel: null }
        if (knownName(source.id, source.name) || !peers.has(source.key)) peers.set(source.key, source)
    }
    const stored = await ctx.routing.peers.get([...peers.keys()])
    const labels: string[] = []
    for (const peer of peers.values()) {
        const name = await peerName(ctx, peer, stored.get(peer.key)?.name)
        labels.push(formatSource(peer, name))
    }
    const sourceLabel = labels.join('、')
    return { header: `以下是来自${sourceLabel}的聊天记录：`, sourceLabel }
}
