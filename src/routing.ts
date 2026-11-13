import type { Context } from 'cordis'
import type { AgentOptions } from '@chatluna/agent'
import { Schema, type InferOutput } from '@chatluna/schema'
import { routeIdOf } from '@chatluna/satori'
import type {} from '@chatluna/routing'
import type {} from '@chatluna/chat'
import type {} from '@chatluna/chat-observer'
import type {} from '@chatluna/ui-schema-registry'

export const ROUTE_SCHEMA = Schema.object({
    extractionWindowMessages: Schema.natural().max(360).default(60).label('从聊天中提取记忆的间隔')
        .description('累计多少条消息后从聊天中提取记忆；0 表示关闭记忆提取。'),
    extractionIncludeOverheard: Schema.boolean().default(false).label('允许群友闲聊触发记忆提取')
        .description('开启后，bot 未参与的群友闲聊也会触发记忆提取。'),
    enableAutoDream: Schema.boolean().default(true).label('是否在提取新记忆后进行 Dream 整理'),
    recallIntervalMessages: Schema.natural().max(200).default(20).label('记忆自动召回的间隔')
        .description('bot 发完一轮回复后检查，自上次召回起累计到此条数则自动召回；0 表示关闭记忆召回。'),
    recallHistoryMessages: Schema.natural().min(1).max(200).default(20).label('用于召回记忆的聊天消息数')
        .description('使用多少条聊天信息作为上下文来召回记忆，建议与记忆自动召回的间隔保持一致。'),
    snapshotScope: Schema.union([
        Schema.const('conversation').description('每一个会话拥有独立记忆快照'),
        Schema.const('preset').description('所有会话共享一个记忆快照')
    ]).default('conversation').label('记忆快照的使用范围')
        .description('开启「会话记忆隔离」时所有会话始终拥有一个独立记忆快照。'),
    snapshotMaxLines: Schema.natural().min(5).max(50).default(5).label('记忆快照的最大行数'),
    enableConversationIsolation: Schema.boolean().default(false).label('会话记忆隔离')
        .description('记忆召回与记忆检索工具只检索来源于当前会话的记忆和全局记忆。'),
    enableSnapshotInjection: Schema.boolean().default(true).label('向 bot 注入记忆快照'),
    enableUserProfileInjection: Schema.boolean().default(false).label('向 bot 注入用户画像')
})

export type RouteSettings = InferOutput<typeof ROUTE_SCHEMA>

declare module '@chatluna/routing' {
    interface RuleValueMap {
        livingmemory: RouteSettings
    }
}

export function registerRouteSettings(ctx: Context) {
    return ctx.schemas.section({
        surface: 'routing',
        key: 'livingmemory',
        id: 'livingmemory',
        title: 'LivingMemory',
        order: 31,
        tab: 'rules.capabilities',
        schema: ROUTE_SCHEMA,
        applies: 'live',
        plugin: 'chatluna-plugin-livingmemory'
    })
}

/** 首次通知可以先于任何私聊消息；chat.wake 已将目标地址写入会话环境。 */
function privateWakeAddress(ctx: Context, sessionId?: string) {
    if (sessionId === undefined) return
    const target = ctx.chat.environmentOf(sessionId)
    if (!target?.isDirect || !target.platform || !target.selfId || !target.userId) return
    const { platform, selfId, guildId, channelId, userId } = target
    return { platform, selfId, guildId, channelId, userId, isDirect: true }
}

/** 上游的自定义会话键不含地点，可能同时连接多个群或私聊。 */
export const isCustomConversation = (key?: string) => key?.startsWith('custom:') === true

export function routeSettings(
    ctx: Context, key?: string, location?: AgentOptions['location'], routeId?: string, noticeSessionId?: string
): RouteSettings {
    if (key !== undefined && isCustomConversation(key)) {
        const route = routeId ?? location?.route
        // 同一个 Agent 可以在甲群打开、在乙群收到唤醒。使用本次路由的地点匹配群规则。
        const channel = ctx.chat_observer.channelOf(key)
        if (channel && channel.routeId === route) {
            return ctx.routing.resolve(ctx.routing.matchInput({ ...channel.identity, userId: undefined }, route)).get('livingmemory')
        }
        const values = ctx.routing.valuesAt({ route }, 'livingmemory')
        return ROUTE_SCHEMA.parse(values ?? {})
    }
    // 聊天 Agent 自带群和频道。旁听没有 Agent；私聊通知的地址还需要区分对端。
    if (key !== undefined && (!location || (location.isDirect && !routeId && !location.route))) {
        const address = ctx.chat_observer.identityOfConversation(key) ?? privateWakeAddress(ctx, noticeSessionId)
        if (address && (!routeId || routeId === routeIdOf(address))) {
            const input = ctx.routing.matchInput({ ...address, userId: undefined }, routeId ?? routeIdOf(address))
            return ctx.routing.resolve(input).get('livingmemory')
        }
    }
    let route = routeId ?? location?.route
    if (!route && location?.isDirect === false && location.platform && location.selfId) {
        // 群路由由平台、机器人和群/频道生成，与发言人无关。
        route = routeIdOf({
            platform: location.platform, selfId: location.selfId, guildId: location.guild,
            channelId: location.channel, isDirect: false, userId: ''
        })
    }
    const values = ctx.routing.valuesAt({
        platform: location?.platform, selfId: location?.selfId, isDirect: location?.isDirect,
        guild: location?.guild, channel: location?.channel, route
    }, 'livingmemory')
    return ROUTE_SCHEMA.parse(values ?? {})
}
