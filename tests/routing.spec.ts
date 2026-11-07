import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from 'cordis'
import Routing from '@chatluna/routing'
import SchemaRegistry from '@chatluna/ui-schema-registry'
import { Schema } from '@chatluna/schema'
import { routeIdOf } from '@chatluna/satori'
import { inject } from '../src/index.ts'
import { registerRouteSettings, routeSettings } from '../src/routing.ts'

test('LivingMemory rules load independently, inherit global settings and apply edits live', async (t) => {
    const ctx = new Context()
    t.after(() => ctx.fiber.dispose())
    await ctx.plugin(SchemaRegistry)
    await ctx.plugin(Routing)
    ctx.provide('chat_observer')
    // 群地址已由 Agent 提供；即使 observer 没有任何消息也应匹配群规则。
    ctx.set('chat_observer', { identityOfConversation: () => undefined } as never)
    const room = { platform: 'test', selfId: 'bot', guild: 'g', channel: 'c', isDirect: false }
    registerRouteSettings(ctx)
    assert.ok(!inject.some(key => String(key) === 'memory'))
    const section = (await ctx.schemas.sections('routing')).find(section => section.id === 'livingmemory')
    assert.equal(section?.tab, 'rules.capabilities')
    assert.equal(routeSettings(ctx, 'c').extractionWindowMessages, 60)
    await ctx.routing.save({ id: 'global', values: { livingmemory: { extractionWindowMessages: 15 } } })
    assert.equal(routeSettings(ctx).extractionWindowMessages, 15)
    await ctx.routing.save({
        id: 'alice', filter: { kind: 'scope', field: 'user', values: ['alice'] },
        values: { livingmemory: { extractionWindowMessages: 99 } }
    })
    await ctx.routing.save({
        id: 'group', filter: { kind: 'scope', field: 'guild', values: ['g'] },
        values: { livingmemory: { enableUserProfileInjection: true } }
    })
    for (const user of ['alice', 'bob']) {
        const settings = routeSettings(ctx, 'c', { ...room, user })
        assert.equal(settings.enableUserProfileInjection, true)
        assert.equal(settings.extractionWindowMessages, 15)
    }
    assert.equal(routeSettings(ctx, 'another', { ...room, guild: 'g2' }).enableUserProfileInjection, false)
    const route = routeIdOf({ platform: room.platform, selfId: room.selfId, guildId: room.guild,
        channelId: room.channel, isDirect: false, userId: 'bob' })
    await ctx.routing.save({ id: 'channel-route', filter: { kind: 'scope', field: 'route', values: [route] },
        values: { livingmemory: { enableConversationIsolation: true } } })
    assert.equal(routeSettings(ctx, 'c', room, route).enableConversationIsolation, true)
    assert.equal(routeSettings(ctx, 'c', room).enableConversationIsolation, true)
    // A second capability owns its own namespace, even with both enabled on the same rule.
    const unregister = ctx.schemas.section({
        surface: 'routing', id: 'memory', key: 'memory', title: 'Memory', order: 30,
        tab: 'rules.capabilities', schema: Schema.object({ enabled: Schema.boolean().default(false) })
    })
    await ctx.routing.save({ id: 'global', values: { memory: { enabled: true }, livingmemory: { extractionWindowMessages: 0 } } })
    assert.equal(routeSettings(ctx, 'c', room).extractionWindowMessages, 0)
    unregister()
    assert.equal(routeSettings(ctx, 'c', room).enableUserProfileInjection, true)
})

test('a scheduled wake in a DM keeps its route rule without matching the last speaker’s user rule', async (t) => {
    const ctx = new Context()
    t.after(() => ctx.fiber.dispose())
    await ctx.plugin(SchemaRegistry)
    await ctx.plugin(Routing)
    const dm = { platform: 'test', selfId: 'bot', userId: 'bob', isDirect: true }
    ctx.provide('chat_observer')
    ctx.set('chat_observer', { identityOfConversation: () => dm } as never)
    registerRouteSettings(ctx)
    await ctx.routing.save({ id: 'dm', filter: { kind: 'scope', field: 'route', values: [routeIdOf(dm)] },
        values: { livingmemory: { enableConversationIsolation: true } } })
    await ctx.routing.save({ id: 'bob', filter: { kind: 'scope', field: 'user', values: ['bob'] },
        values: { livingmemory: { enableUserProfileInjection: true } } })
    const settings = routeSettings(ctx, 'conversation', { platform: 'test', selfId: 'bot', isDirect: true })
    assert.equal(settings.enableConversationIsolation, true)
    assert.equal(settings.enableUserProfileInjection, false)
    const other = routeIdOf({ ...dm, userId: 'alice' })
    assert.equal(routeSettings(ctx, 'other', { platform: 'test', selfId: 'bot', isDirect: true }, other).enableConversationIsolation, false)
})
