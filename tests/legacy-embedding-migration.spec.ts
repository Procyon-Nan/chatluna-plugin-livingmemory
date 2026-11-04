import assert from 'node:assert/strict'
import { withLivingMemoryRepository } from './persistence-test-utils.ts'

it('clears legacy JSON vectors after the vector index migration completes', async () => {
    await withLivingMemoryRepository(async (ctx, repository) => {
        const memory = await repository.createMemory(
            {
                conversationId: 'conversation-a',
                presetId: 'preset-a'
            },
            {
                type: 'fact',
                content: 'legacy memory'
            }
        )
        await ctx.database.set(
            'living_memory_entry',
            { id: memory.id },
            {
                embedding: [1, 0, 0],
                embeddingModelId: 'model-a'
            }
        )

        assert.equal(await repository.hasMigratedLegacyEmbeddings(), false)
        const beforeMigration = await repository.getEntryById(memory.id)
        assert.equal(Object.hasOwn(beforeMigration ?? {}, 'embedding'), false)
        assert.equal(
            Object.hasOwn(beforeMigration ?? {}, 'embeddingModelId'),
            false
        )
        await repository.completeLegacyEmbeddingMigration()
        assert.equal(await repository.hasMigratedLegacyEmbeddings(), true)

        const [stored] = await ctx.database.get('living_memory_entry', {
            id: memory.id
        })
        assert.equal(stored.embedding, null)
        assert.equal(stored.embeddingModelId, null)

        await repository.completeLegacyEmbeddingMigration()
        assert.equal(
            (
                await ctx.database.get('living_memory_migration', {
                    id: 'legacy-embedding-vector-index-v1'
                })
            ).length,
            1
        )
    })
})