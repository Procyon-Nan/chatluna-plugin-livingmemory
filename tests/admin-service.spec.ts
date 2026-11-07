import assert from 'node:assert/strict'
import { withLivingMemoryRepository } from './persistence-test-utils.ts'
import { LivingMemoryAdminService } from '../src/service/app/admin_service.ts'
import type { LivingMemoryAdminDeps } from '../src/service/app/admin_service.ts'
import type { LivingMemoryRepository } from '../src/service/persistence/repository.ts'
import { createSpeakerKey } from '../src/service/memory/speaker_identity.ts'
import { DEFAULT_CONFIG } from '../src/service.ts'
import type { MemoryVectorIndexStatus } from '../src/contracts/vector_index.ts'

const cleanups: string[] = []

const adminOf = (
    repository: LivingMemoryRepository,
    listPresetIds: () => Promise<string[]> = async () => []
) => {
    const deps = {
        config: DEFAULT_CONFIG,
        repository,
        cleanupConversation: async (conversationId: string) => {
            cleanups.push(conversationId)
        },
        listPresetIds,
        vectorIndex: {
            getStatus: (): MemoryVectorIndexStatus => ({
                state: 'idle',
                manifest: null,
                presets: [],
                currentJobId: null,
                lastError: null
            })
        }
    } as unknown as LivingMemoryAdminDeps
    return new LivingMemoryAdminService(deps)
}

const seed = (
    repository: LivingMemoryRepository,
    presetId: string,
    content: string,
    keywords: string[] = []
) =>
    repository.createMemory(
        { presetId, conversationId: '' },
        { type: 'fact', content, keywords },
        []
    )

it('merges the preset catalog with the presets that still hold data', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        await seed(repository, 'zeta', '一条记忆')
        await seed(repository, 'alpha', '另一条记忆')

        const admin = adminOf(repository, async () => ['catalog-only', 'zeta'])
        assert.deepEqual(await admin.listPresetIds(), [
            'alpha',
            'catalog-only',
            'zeta'
        ])
    })
})

it('lists a preset that only kept speaker rows', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        await repository.upsertPresetSpeaker({
            presetId: 'speakers-only',
            speakerKey: 'speaker-1',
            speakerLabel: '某个用户'
        })
        const admin = adminOf(repository)
        assert.deepEqual(await admin.listPresetIds(), ['speakers-only'])
    })
})

it('matches an entry by its keyword or content when the command searches text', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const coffee = await seed(repository, 'preset-1', '用户喜欢喝咖啡', ['饮品'])
        const hangzhou = await seed(repository, 'preset-1', '用户住在杭州', ['地点'])
        await seed(repository, 'preset-2', '其他预设的咖啡记忆', ['饮品'])

        const admin = adminOf(repository)
        assert.deepEqual(
            await admin.findActiveMemoryIdsByText('preset-1', '饮品'),
            [coffee.id]
        )
        assert.deepEqual(
            await admin.findActiveMemoryIdsByText('preset-1', '杭州'),
            [hangzhou.id]
        )
        assert.deepEqual(
            await admin.findActiveMemoryIdsByText('preset-1', '不存在'),
            []
        )
    })
})

it('ignores archived entries and other presets when matching a user', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const speakerKey = createSpeakerKey('discord', 'alice')
        const kept = await repository.createMemory(
            { presetId: 'preset-1', conversationId: '' },
            { type: 'fact', content: '保持活跃' },
            [speakerKey]
        )
        await repository.createMemory(
            { presetId: 'preset-1', conversationId: '' },
            { type: 'fact', content: '已归档', status: 'archived' },
            [speakerKey]
        )
        await repository.createMemory(
            { presetId: 'preset-2', conversationId: '' },
            { type: 'fact', content: '其他预设' },
            [speakerKey]
        )

        const admin = adminOf(repository)
        assert.deepEqual(
            await admin.findActiveMemoryIdsByUser('preset-1', 'discord', 'alice'),
            [kept.id]
        )
    })
})

it('finds the profile of one platform user inside a preset', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        await repository.replaceUserProfile('preset-1', {
            speakerKey: createSpeakerKey('discord', 'alice'),
            speakerLabel: 'alice',
            content: '资料内容',
            sourceMemoryIds: []
        })

        const admin = adminOf(repository)
        const profileId = await admin.findUserProfileIdByUser(
            'preset-1',
            'discord',
            'alice'
        )
        assert.ok(profileId !== undefined)
        assert.equal(
            await admin.findUserProfileIdByUser('preset-1', 'discord', 'bob'),
            undefined
        )
    })
})

it('forwards conversation cleanup to the owning service', async () => {
    cleanups.length = 0
    await withLivingMemoryRepository(async (_ctx, repository) => {
        await adminOf(repository).cleanupConversation('conversation-9')
        assert.deepEqual(cleanups, ['conversation-9'])
    })
})

it('reports the status of the configured models together with the index', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const status = adminOf(repository).status
        assert.deepEqual(
            status.warnings.map((warning) => warning.code),
            [
                'recall-model-missing',
                'embedding-model-missing',
                'extract-model-missing'
            ]
        )
        assert.equal(status.vectorIndex.state, 'idle')
    })
})