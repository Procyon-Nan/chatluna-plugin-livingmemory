import assert from 'node:assert/strict'
import type { MemoryScope } from '@chatluna/memory'
import { LivingMemoryBackend } from '../src/service/backend.ts'
import { withLivingMemoryRepository } from './persistence-test-utils.ts'

const preset = 'preset-1'
const scope: MemoryScope = { presetId: preset, conversationId: 'group:1' }

it('writes the v2-required topic and title when v1 input has neither', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const backend = new LivingMemoryBackend(repository)
        const [entry] = await backend.create({ presetId: preset }, [
            { type: 'preference', content: '喜欢喝乌龙茶', summary: '常喝乌龙茶' }
        ])
        assert.equal(entry.topic, 'preference')
        assert.equal(entry.title, '常喝乌龙茶')

        const [noSummary] = await backend.create({ presetId: preset }, [
            { type: 'fact', content: '第一次见面在图书馆\n后来常在周末见面' }
        ])
        assert.equal(noSummary.title, '第一次见面在图书馆')
    })
})

it('lists by scope and reports facets over the whole preset', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const backend = new LivingMemoryBackend(repository)
        await backend.create(scope, [
            { type: 'fact', topic: 'people', content: 'a' },
            { type: 'preference', topic: 'taste', content: 'b' }
        ])
        await backend.create({ presetId: preset }, [{ type: 'fact', topic: 'people', content: 'c' }])

        const page = await backend.list({ presetId: preset, scope, status: 'all' })
        assert.equal(page.items.length, 2)
        assert.deepEqual(page.facets.topics, { people: 2, taste: 1 })
        assert.equal(page.facets.active, 3)
        assert.equal(page.facets.archived, 0)
    })
})

it('searches only inside the requested scope', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const backend = new LivingMemoryBackend(repository)
        await backend.create(scope, [{ type: 'fact', content: '喜欢在雨天散步', keywords: ['雨天'] }])
        await backend.create({ presetId: preset }, [{ type: 'fact', content: '喜欢在晴天散步' }])

        const hits = await backend.search(scope, { texts: ['雨天'] })
        assert.equal(hits.length, 1)
        assert.match(hits[0]!.entry.content, /雨天/)
    })
})

it('archives and removes through the backend and notifies watchers', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const backend = new LivingMemoryBackend(repository)
        const changes: string[] = []
        backend.watch((change) => changes.push(`${change.kind}:${change.ids.length}`))

        const [entry] = await backend.create({ presetId: preset }, [{ type: 'fact', content: '待归档' }])
        await backend.archive(preset, [entry.id])
        assert.equal((await backend.list({ presetId: preset, status: 'archived' })).items.length, 1)

        await backend.remove(preset, [entry.id])
        assert.equal(await backend.get(entry.id), undefined)
        assert.deepEqual(changes, ['created:1', 'archived:1', 'removed:0'])
    })
})

it('updates a single field without losing the derived title', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const backend = new LivingMemoryBackend(repository)
        const [entry] = await backend.create({ presetId: preset }, [
            { type: 'fact', content: '原文', summary: '原标题' }
        ])
        const updated = await backend.update(entry.id, { keywords: ['新关键词'] })
        assert.equal(updated.title, '原标题')
        assert.deepEqual(updated.keywords, ['新关键词'])

        const retitled = await backend.update(entry.id, { content: '换过的正文' })
        assert.equal(retitled.title, '原标题')
    })
})

it('groups the index by topic and respects the budget', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const backend = new LivingMemoryBackend(repository)
        await backend.create({ presetId: preset }, [
            { type: 'fact', topic: 'people', content: 'a', summary: '甲' },
            { type: 'fact', topic: 'people', content: 'b', summary: '乙' },
            { type: 'fact', topic: 'plans', content: 'c', summary: '丙' }
        ])

        const index = await backend.index({ presetId: preset }, 1500)
        assert.match(index, /^- people \(2\): /m)
        assert.match(index, /^- plans \(1\): 丙$/m)
    })
})

it('round-trips through the v2 export shape', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const backend = new LivingMemoryBackend(repository)
        await backend.create(scope, [{ type: 'fact', topic: 'people', content: '导出内容' }])
        const data = await backend.export(preset)
        assert.equal(data.version, 1)
        assert.equal(data.entries.length, 1)

        await backend.import('preset-2', data)
        const imported = await backend.list({ presetId: 'preset-2', status: 'all' })
        assert.equal(imported.items.length, 1)
        assert.equal(imported.items[0]!.content, '导出内容')
        assert.equal(imported.items[0]!.presetId, 'preset-2')
    })
})