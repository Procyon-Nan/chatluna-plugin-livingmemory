import type { Context } from 'cordis'
import type { ChatHistoryEntry } from '../chat_history.ts'
import { formatSource, knownName, peerName, type SourcePeer } from '../memory/conversation_sources.ts'

export async function formatTranscriptHeader(ctx: Context, entries: readonly ChatHistoryEntry[]): Promise<string> {
    const peers = new Map<string, SourcePeer>()
    for (const { source } of entries) {
        // 不能证明整批的出处时，不用其中一条已知消息代表整批。
        if (!source) return '以下是本次会话的聊天记录：'
        if (knownName(source.id, source.name) || !peers.has(source.key)) peers.set(source.key, source)
    }
    const stored = await ctx.routing.peers.get([...peers.keys()])
    const labels: string[] = []
    for (const peer of peers.values()) {
        const name = await peerName(ctx, peer, stored.get(peer.key)?.name)
        labels.push(formatSource({ ...peer, name }))
    }
    return `以下是来自${labels.join('、')}的聊天记录：`
}
