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
    ctx.set('chat_observer', { channelOf: () => undefined } as never)
    const room = { platform: 'test', selfId: 'bot', guild: 'g', channel: 'c', isDirect: false }
    registerRouteSettings(ctx)
    assert.ok(!inject.some(key => String(key) === 'memory'))
    const section = (await ctx.schemas.sections('routing')).find(section => section.id === 'livingmemory')
    assert.equal(section?.tab, 'rules.capabilities')
    assert.equal(section?.schema.dict?.extractionIncludeOverheard.meta.chat, 'group')
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
    // 私聊地点不携带对端时仍应命中私聊规则。
    await ctx.routing.save({ id: 'all-dms', filter: { kind: 'direct' },
        values: { livingmemory: { snapshotMaxLines: 12 } } })
    const privateLocation = { platform: 'test', selfId: 'bot', isDirect: true }
    const dmRoute = routeIdOf({ ...privateLocation, userId: 'alice' })
    assert.equal(routeSettings(ctx, 'dm', privateLocation, dmRoute).snapshotMaxLines, 12)
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
    await ctx.routing.save({ id: 'group', filter: { kind: 'scope', field: 'guild', values: ['g'] },
        values: { livingmemory: { enableUserProfileInjection: true, extractionWindowMessages: 30 } } })
    assert.equal(routeSettings(ctx, 'c', room).extractionWindowMessages, 30)
    assert.equal(routeSettings(ctx, 'another', { ...room, guild: 'g2' }).extractionWindowMessages, 0)
    unregister()
    assert.equal(routeSettings(ctx, 'c', room).enableUserProfileInjection, true)
})

test('only the private peer can match a user rule, including on a shared conversation', async (t) => {
    const ctx = new Context()
    t.after(() => ctx.fiber.dispose())
    await ctx.plugin(SchemaRegistry)
    await ctx.plugin(Routing)
    const dm = { platform: 'test', selfId: 'bot', userId: 'bob', isDirect: true }
    const other = { ...dm, userId: 'alice' }
    const group = { ...dm, isDirect: false, guildId: 'group', channelId: 'room' }
    let identity = dm
    ctx.provide('chat_observer')
    ctx.set('chat_observer', { channelOf: () => ({ identity, routeId: routeIdOf(identity) }) } as never)
    registerRouteSettings(ctx)
    await ctx.routing.save({ id: 'global', values: { livingmemory: { extractionIncludeOverheard: true } } })
    await ctx.routing.save({ id: 'bob', filter: { kind: 'scope', field: 'user', values: ['bob'] },
        values: { livingmemory: { enableUserProfileInjection: true } } })
    for (const peer of [dm, other, group]) {
        identity = peer
        for (const key of ['conversation', 'custom:shared']) {
            const settings = routeSettings(ctx, key, undefined, routeIdOf(peer))
            assert.equal(settings.enableUserProfileInjection, peer === dm)
            assert.equal(settings.extractionIncludeOverheard, peer === group)
        }
    }
    identity = dm
    assert.equal(routeSettings(ctx, 'custom:shared', undefined, routeIdOf(other)).enableUserProfileInjection, false)
    assert.equal(routeSettings(ctx, 'custom:shared').enableUserProfileInjection, false)
})
