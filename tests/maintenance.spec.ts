import assert from 'node:assert/strict'
import { withLivingMemoryRepository } from './persistence-test-utils.ts'
import { LivingMemoryMaintenance } from '../src/service/app/maintenance.ts'
import { LivingMemoryMutationService } from '../src/service/app/mutation_service.ts'
import type { LivingMemoryRepository } from '../src/service/persistence/repository.ts'
import type { LivingMemoryMutationService as MutationService } from '../src/service/app/mutation_service.ts'
import { createCapturedLogger } from './workflow-test-utils.ts'
import type { MemoryEntryRecord } from '../src/contracts/memory.ts'

const DAY = 86_400_000

const silentIndex = {
    applyMutation: async () => {},
    clearPreset: async () => {},
    reconcilePreset: async () => {},
    waitForMaintenance: async () => {},
    startRebuild: () => {}
}

const maintenanceOf = (
    ctx: Parameters<Parameters<typeof withLivingMemoryRepository>[0]>[0],
    repository: LivingMemoryRepository
) => {
    const captured = createCapturedLogger()
    const mutations = new LivingMemoryMutationService(
        repository,
        silentIndex as never,
        captured.logger
    ) as LivingMemoryMutationService & MutationService
    return {
        maintenance: new LivingMemoryMaintenance(ctx, {
            repository,
            mutations,
            logger: captured.logger
        }),
        info: captured.info,
        warnings: captured.warnings
    }
}

const seedLegacyOrigins = async (
    ctx: Parameters<Parameters<typeof withLivingMemoryRepository>[0]>[0]
) => {
    const now = new Date('2026-11-05T00:00:00.000Z')
    await ctx.database.create('living_memory_entry', {
        id: 'legacy-origins',
        presetId: 'preset-1',
        speakerKeys: [],
        type: 'fact',
        status: 'active',
        topic: 'fact',
        title: null,
        content: '旧格式来源',
        keywords: [],
        fields: null,
        summary: null,
        sentiment: null,
        importance: null,
        sourceConversationId: null,
        sourceLabel: null,
        sourceOrigins: { messages: [] } as never,
        embedding: null,
        embeddingModelId: null,
        createdAt: now,
        updatedAt: now
    })
}

it('repairs legacy source origins before the index starts', async () => {
    await withLivingMemoryRepository(async (ctx, repository) => {
        await seedLegacyOrigins(ctx)
        const { maintenance, info } = maintenanceOf(ctx, repository)

        await maintenance.runStartup()

        const [entry] = await ctx.database.get('living_memory_entry', {
            id: 'legacy-origins'
        })
        assert.deepEqual(entry.sourceOrigins, [])
        assert.ok(info.some((line) => line.includes('记忆来源迁移完成')))
    })
})

it('recovers job rows left running by an interrupted process', async () => {
    await withLivingMemoryRepository(async (ctx, repository) => {
        await repository.createJob(
            { conversationId: 'conversation-1', presetId: 'preset-1' },
            'recall',
            'query'
        )
        const { maintenance, info } = maintenanceOf(ctx, repository)

        await maintenance.runStartup()

        const [job] = await ctx.database.get('living_memory_job', {})
        assert.equal(job.status, 'failed')
        assert.match(job.error ?? '', /service restarted while job was running/)
        assert.ok(info.some((line) => line.includes('中断任务状态恢复完成')))
    })
})

it('keeps the startup maintenance silent when there is nothing to repair', async () => {
    await withLivingMemoryRepository(async (ctx, repository) => {
        const { maintenance, info } = maintenanceOf(ctx, repository)
        await maintenance.runStartup()
        assert.deepEqual(info, [])
    })
})

it('deletes an archived entry only after its importance-weighted decay', async () => {
    await withLivingMemoryRepository(async (ctx, repository) => {
        const now = new Date('2026-11-05T00:00:00.000Z')
        const create = (
            id: string,
            status: MemoryEntryRecord['status'],
            age: number,
            importance: number
        ) =>
            ctx.database.create('living_memory_entry', {
                id,
                presetId: 'preset-1',
                speakerKeys: [],
                type: 'fact',
                status,
                topic: 'fact',
                title: null,
                content: id,
                keywords: [],
                fields: null,
                summary: null,
                sentiment: null,
                importance,
                sourceConversationId: null,
                sourceLabel: null,
                sourceOrigins: [],
                embedding: null,
                embeddingModelId: null,
                createdAt: new Date(now.getTime() - age),
                updatedAt: new Date(now.getTime() - age)
            })

        await create('expired', 'archived', 400 * DAY, 1)
        // 重要度为 0 时衰减期为 0：过了 7 天宽限期才删除，宽限期内保留。
        await create('inside-grace', 'archived', 3 * DAY, 0)
        await create('active', 'active', 400 * DAY, 1)

        const { maintenance } = maintenanceOf(ctx, repository)
        maintenance.queueStartupArchivedCleanup()
        await maintenance.settled()

        const remaining = (
            await ctx.database.get('living_memory_entry', {}, ['id'])
        ).map((entry) => entry.id)
        assert.deepEqual(remaining.sort(), ['active', 'inside-grace'])
    })
})

it('removes job audit rows older than a week', async () => {
    await withLivingMemoryRepository(async (ctx, repository) => {
        const old = new Date(Date.now() - 8 * DAY)
        await ctx.database.create('living_memory_job', {
            id: 'old-job',
            presetId: 'preset-1',
            conversationId: 'conversation-1',
            kind: 'recall',
            status: 'completed',
            input: 'query',
            detail: null,
            error: null,
            createdAt: old,
            startedAt: old,
            finishedAt: old,
            updatedAt: old
        })
        await repository.createJob(
            { conversationId: 'conversation-1', presetId: 'preset-1' },
            'recall',
            'recent'
        )

        const { maintenance } = maintenanceOf(ctx, repository)
        await maintenance.pruneExpiredJobs()

        const remaining = await ctx.database.get('living_memory_job', {}, ['id'])
        assert.equal(remaining.length, 1)
        assert.notEqual(remaining[0].id, 'old-job')
    })
})