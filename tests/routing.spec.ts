import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from 'cordis'
import Routing from '@chatluna/routing'
import SchemaRegistry from '@chatluna/ui-schema-registry'
import { Schema } from '@chatluna/schema'
import { inject } from '../src/index.ts'
import { registerRouteSettings, routeSettings } from '../src/routing.ts'

test('LivingMemory rules load independently, inherit global settings and apply edits live', async (t) => {
    const ctx = new Context()
    t.after(() => ctx.fiber.dispose())
    await ctx.plugin(SchemaRegistry)
    await ctx.plugin(Routing)
    ctx.provide('chat_observer')
    ctx.set('chat_observer', {
        identityOfConversation: () => ({ platform: 'test', selfId: 'bot', guildId: 'g', channelId: 'c', userId: 'bob', isDirect: false })
    } as never)
    registerRouteSettings(ctx)
    assert.ok(!inject.some(key => String(key) === 'memory'))
    const section = (await ctx.schemas.sections('routing')).find(section => section.id === 'livingmemory')
    assert.equal(section?.tab, 'rules.capabilities')
    assert.equal(routeSettings(ctx, 'c').extractionWindowMessages, 60)
    await ctx.routing.save({ id: 'global', values: { livingmemory: { extractionWindowMessages: 15 } } })
    assert.equal(routeSettings(ctx).extractionWindowMessages, 15)
    await ctx.routing.save({
        id: 'alice', filter: { kind: 'scope', field: 'user', values: ['alice'] },
        values: { livingmemory: { enableUserProfileInjection: true } }
    })
    assert.equal(routeSettings(ctx, 'c', 'alice').enableUserProfileInjection, true)
    assert.equal(routeSettings(ctx, 'c', 'alice').extractionWindowMessages, 15)
    assert.equal(routeSettings(ctx, 'c').enableUserProfileInjection, false)
    // A second capability owns its own namespace, even with both enabled on the same rule.
    const unregister = ctx.schemas.section({
        surface: 'routing', id: 'memory', key: 'memory', title: 'Memory', order: 30,
        tab: 'rules.capabilities', schema: Schema.object({ enabled: Schema.boolean().default(false) })
    })
    await ctx.routing.save({ id: 'global', values: { memory: { enabled: true }, livingmemory: { extractionWindowMessages: 0 } } })
    assert.equal(routeSettings(ctx, 'c', 'alice').extractionWindowMessages, 0)
    unregister()
    assert.equal(routeSettings(ctx, 'c', 'alice').enableUserProfileInjection, true)
})
