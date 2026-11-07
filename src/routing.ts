import type { Context } from 'cordis'
import { Schema, type InferOutput } from '@chatluna/schema'
import { routeIdOf } from '@chatluna/satori'
import type {} from '@chatluna/routing'
import type {} from '@chatluna/chat-observer'
import type {} from '@chatluna/ui-schema-registry'

export const ROUTE_SCHEMA = Schema.object({
    extractionWindowMessages: Schema.natural().max(360).default(60).label('自动提取间隔')
        .description('累计多少条聊天后提取；0 表示关闭。'),
    extractionIncludeOverheard: Schema.boolean().default(false).label('提取旁听消息')
        .description('允许单独提取机器人未参与的闲聊。'),
    enableAutoDream: Schema.boolean().default(true).label('提取后整理新记忆'),
    recallIntervalMessages: Schema.natural().max(200).default(20).label('自动召回间隔')
        .description('首次对话立即召回，之后按新聊天条数触发；0 表示关闭。'),
    recallHistoryMessages: Schema.natural().min(1).max(200).default(20).label('召回上下文条数'),
    snapshotMaxLines: Schema.natural().min(5).max(50).default(5).label('快照最大行数'),
    enableConversationIsolation: Schema.boolean().default(false).label('隔离会话检索')
        .description('自动召回与记忆检索工具只检索当前会话和全局记忆。'),
    enableSnapshotInjection: Schema.boolean().default(true).label('注入记忆快照'),
    enableUserProfileInjection: Schema.boolean().default(false).label('注入用户画像')
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

export function routeSettings(ctx: Context, conversationId?: string, userId?: string): RouteSettings {
    const identity = conversationId === undefined ? undefined : ctx.chat_observer.identityOfConversation(conversationId)
    if (identity !== undefined) {
        const speaker = userId === undefined ? identity : { ...identity, userId }
        const input = ctx.routing.matchInput(speaker, routeIdOf(speaker))
        return ctx.routing.resolve(input).get('livingmemory')
    }
    return ROUTE_SCHEMA.parse(ctx.routing.valuesAt(undefined, 'livingmemory') ?? {})
}
