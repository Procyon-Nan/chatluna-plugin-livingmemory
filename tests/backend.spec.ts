import assert from 'node:assert/strict'
import type { MemoryScope } from '@chatluna/memory'
import { LivingMemoryMutationService } from '../src/service/app/mutation_service.ts'
import { LivingMemoryBackend } from '../src/service/backend.ts'
import type { LivingMemoryLogger } from '../src/service/logging/logger.ts'
import type {
    MemoryIndexMutationBatch,
    MemoryIndexMutationSink
} from '../src/contracts/vector_index.ts'
import type { LivingMemoryRepository } from '../src/service/persistence/repository.ts'
import { withLivingMemoryRepository } from './persistence-test-utils.ts'

const preset = 'preset-1'
const scope: MemoryScope = { presetId: preset, conversationId: 'group:1' }

/** 索引就绪的替身：写路径预检通过，索引同步只记录批次。 */
class ReadyIndexStub implements MemoryIndexMutationSink {
    readonly batches: MemoryIndexMutationBatch[] = []
    ready = true

    async waitForMaintenance() {}

    assertPresetReady(targetPresetId: string) {
        if (!this.ready) {
            throw new Error(`vector index is not ready: preset=${targetPresetId}`)
        }
    }

    async applyMutation(batch: MemoryIndexMutationBatch) {
        this.batches.push(batch)
    }

    async clearPreset() {}

    async reconcilePreset() {
        throw new Error('unexpected reconcile')
    }
}

const loggerStub = { summary: () => {} } as unknown as LivingMemoryLogger

const createBackend = (repository: LivingMemoryRepository) => {
    const index = new ReadyIndexStub()
    const mutations = new LivingMemoryMutationService(
        repository,
        index,
        loggerStub
    )
    return { backend: new LivingMemoryBackend(repository, mutations, loggerStub), index }
}

it('writes the v2-required topic and title when v1 input has neither', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const { backend } = createBackend(repository)
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
        const { backend } = createBackend(repository)
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
        const { backend } = createBackend(repository)
        await backend.create(scope, [{ type: 'fact', content: '喜欢在雨天散步', keywords: ['雨天'] }])
        await backend.create({ presetId: preset }, [{ type: 'fact', content: '喜欢在晴天散步' }])

        const hits = await backend.search(scope, { texts: ['雨天'] })
        assert.equal(hits.length, 1)
        assert.match(hits[0]!.entry.content, /雨天/)
    })
})

it('archives and removes through the backend and notifies watchers', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const { backend } = createBackend(repository)
        const changes: string[] = []
        backend.watch((change) => changes.push(`${change.kind}:${change.ids.length}`))

        const [entry] = await backend.create({ presetId: preset }, [{ type: 'fact', content: '待归档' }])
        await backend.archive(preset, [entry.id])
        assert.equal((await backend.list({ presetId: preset, status: 'archived' })).items.length, 1)

        await backend.remove(preset, [entry.id])
        assert.equal(await backend.get(entry.id), undefined)
        assert.deepEqual(changes, ['created:1', 'archived:1', 'removed:1'])
    })
})

it('updates a single field without losing the derived title', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const { backend } = createBackend(repository)
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
        const { backend } = createBackend(repository)
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
        const { backend } = createBackend(repository)
        await backend.create(scope, [{ type: 'fact', topic: 'people', content: '导出内容' }])
        const data = await backend.export(preset)
        assert.equal(data.version, 1)
        assert.equal(data.entries.length, 1)

        const count = await backend.import({ presetId: 'preset-2' }, data)
        assert.equal(count, 1)
        const imported = await backend.list({ presetId: 'preset-2', status: 'all' })
        assert.equal(imported.items.length, 1)
        assert.equal(imported.items[0]!.content, '导出内容')
        assert.equal(imported.items[0]!.presetId, 'preset-2')
    })
})

it('declares every automatic workflow so the native scheduler yields', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const { backend } = createBackend(repository)
        assert.deepEqual(backend.scheduling, {
            extract: true,
            dream: true,
            recall: true
        })
    })
})

it('fails every write before committing when the index is not ready', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const { backend, index } = createBackend(repository)
        const [entry] = await backend.create({ presetId: preset }, [
            { type: 'fact', content: '索引就绪时写入' }
        ])
        const before = index.batches.length
        index.ready = false

        await assert.rejects(
            backend.create({ presetId: preset }, [{ type: 'fact', content: '不应落库' }]),
            /not ready/u
        )
        await assert.rejects(
            backend.update(entry.id, { content: '也不应落库' }),
            /not ready/u
        )
        await assert.rejects(backend.archive(preset, [entry.id]), /not ready/u)
        await assert.rejects(backend.remove(preset, [entry.id]), /not ready/u)

        assert.equal(index.batches.length, before)
        const page = await backend.list({ presetId: preset, status: 'all' })
        assert.equal(page.items.length, 1)
        assert.equal(page.items[0]!.content, '索引就绪时写入')
    })
})

it('reports how many entries an import wrote', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const { backend } = createBackend(repository)
        await backend.create(scope, [
            { type: 'fact', content: '第一条' },
            { type: 'fact', content: '第二条' }
        ])
        const data = await backend.export(preset)

        assert.equal(await backend.import({ presetId: 'preset-2' }, data), 2)
        // 重复导入是幂等合并：目标预设内已有同 id 的条目不再写入。
        assert.equal(await backend.import({ presetId: 'preset-2' }, data), 0)
    })
})
