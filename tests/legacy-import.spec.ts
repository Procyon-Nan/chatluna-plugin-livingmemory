import assert from 'node:assert/strict'
import { withLivingMemoryRepository } from './persistence-test-utils.ts'
import { LivingMemoryMutationService } from '../src/service/app/mutation_service.ts'
import type { LivingMemoryPresetExport } from '../src/contracts/memory.ts'
import { createCapturedLogger } from './workflow-test-utils.ts'

const indexSink = {
    applyMutation: async () => {},
    clearPreset: async () => {},
    reconcilePreset: async () => ({ id: 'index-job' }),
    waitForMaintenance: async () => {},
    assertPresetReady: () => {},
    startRebuild: () => {}
}

const v1Export = (sourcePresetId: string): LivingMemoryPresetExport =>
    ({
        version: 5,
        exportedAt: '2026-11-01T00:00:00.000Z',
        sourcePresetId,
        entries: [
            {
                id: 'memory-1',
                speakerKeys: ['speaker-a'],
                type: 'preference',
                status: 'active',
                content: '用户喜欢喝美式咖啡，不加糖。',
                keywords: ['咖啡', '口味'],
                summary: '喜欢美式咖啡',
                sentiment: '正面',
                importance: 0.8,
                sourceConversationId: 'conversation-1',
                sourceLabel: '群聊',
                sourceOrigins: [
                    {
                        messages: [
                            {
                                role: 'user',
                                content: '我喝美式，不加糖',
                                transcriptLines: ['小明说：我喝美式，不加糖']
                            }
                        ]
                    }
                ],
                createdAt: '2026-10-01T00:00:00.000Z',
                updatedAt: '2026-10-02T00:00:00.000Z'
            },
            {
                id: 'memory-2',
                speakerKeys: [],
                type: 'fact',
                status: 'archived',
                content: '旧的一条归档记忆',
                keywords: [],
                summary: null,
                sentiment: null,
                importance: null,
                sourceConversationId: null,
                sourceLabel: null,
                sourceOrigins: [],
                createdAt: '2026-09-01T00:00:00.000Z',
                updatedAt: '2026-09-01T00:00:00.000Z'
            }
        ],
        userProfiles: [
            {
                id: 'profile-1',
                speakerKey: 'speaker-a',
                speakerLabel: '小明',
                content: '喜欢美式咖啡',
                sourceMemoryIds: ['memory-1'],
                createdAt: '2026-10-03T00:00:00.000Z',
                updatedAt: '2026-10-03T00:00:00.000Z'
            }
        ],
        presetSpeakers: [
            {
                speakerKey: 'speaker-a',
                speakerLabel: '小明',
                speakerAliases: ['小明', '明明'],
                speakerId: 'user-1',
                platform: 'onebot',
                createdAt: '2026-10-01T00:00:00.000Z',
                updatedAt: '2026-10-01T00:00:00.000Z'
            }
        ]
    }) as LivingMemoryPresetExport

const mutationsOf = (repository: never) =>
    new LivingMemoryMutationService(
        repository,
        indexSink as never,
        createCapturedLogger().logger
    )

it('round-trips the memory entries in a v1 preset file', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const mutations = mutationsOf(repository as never)
        const file = v1Export('preset-1')
        const result = await mutations.importPreset('preset-1', file)

        assert.deepEqual(
            { entries: result.entries, userProfiles: result.userProfiles, presetSpeakers: result.presetSpeakers },
            { entries: 2, userProfiles: 1, presetSpeakers: 1 }
        )

        const exported = await repository.exportPresetData('preset-1')
        assert.deepEqual(exported.entries, file.entries)
    })
})

it('keeps archived entries out of the active speaker index', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const mutations = mutationsOf(repository as never)
        await mutations.importPreset('preset-1', v1Export('preset-1'))

        const links = await repository.listActiveMemorySpeakerLinks('preset-1', [
            'speaker-a'
        ])
        assert.deepEqual(links, [{ speakerKey: 'speaker-a', memoryId: 'memory-1' }])
    })
})

it('rewrites ids when the export comes from another preset', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const mutations = mutationsOf(repository as never)
        await mutations.importPreset('preset-2', v1Export('preset-1'))

        const entries = await repository.listEntriesByPreset('preset-2')
        assert.equal(entries.length, 2)
        assert.equal(
            entries.some((entry) => entry.id === 'memory-1'),
            false
        )
        const [profile] = await repository.listUserProfilesByPreset('preset-2')
        assert.equal(profile?.sourceMemoryIds.length, 1)
        assert.ok(entries.some((entry) => entry.id === profile?.sourceMemoryIds[0]))
    })
})
