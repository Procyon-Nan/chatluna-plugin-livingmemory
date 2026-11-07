import assert from 'node:assert/strict'
import type { Context } from 'cordis'
import { LivingMemoryLogger } from '../src/service/logging/logger.ts'
import type {
    MemoryEntryRecord,
    UserProfileInput,
    UserProfileRecord
} from '../src/contracts/memory.ts'
import type {
    UserProfileMemoryRepository,
    UserProfileRepository
} from '../src/contracts/workflows.ts'
import {
    LivingMemoryUserProfileService,
    normalizeManualUserProfileContent
} from '../src/service/user_profile.ts'

const now = new Date('2026-07-16T00:00:00.000Z')
const memory: MemoryEntryRecord = {
    id: 'memory-1',
    presetId: 'preset-1',
    speakerKeys: ['张三'],
    type: 'fact',
    status: 'active',
    content: '张三正在准备考试。',
    keywords: ['张三', '准备考试'],
    summary: '张三正在准备考试',
    sentiment: '关心',
    importance: 0.7,
    sourceConversationId: 'conversation-1',
    sourceLabel: null,
    sourceOrigins: [],
    createdAt: now,
    updatedAt: now
}

const createHarness = (
    options: {
        debug?: boolean
        presetId?: string
        presets?: Record<string, { name: string }>
        speakerLabel?: string
        speakerAliases?: string[]
        userProfileMinMemoryCount?: number
        existingSourceMemoryIds?: string[]
        existingProfileUpdatedAt?: Date
    } = {}
) => {
    const savedProfiles: UserProfileInput[] = []
    const reviewedProfiles: { profileId: string; sourceMemoryIds: string[] }[] =
        []
    const debugMessages: string[] = []
    const invocations: { system: string; prompt: string }[] = []
    const existingProfiles: UserProfileRecord[] = []
    if (options.existingSourceMemoryIds != null) {
        existingProfiles.push({
            id: 'profile-1',
            presetId: options.presetId ?? 'preset-1',
            speakerKey: '张三',
            speakerLabel: options.speakerLabel ?? '张三',
            content: '旧画像',
            sourceMemoryIds: options.existingSourceMemoryIds,
            createdAt: now,
            updatedAt: options.existingProfileUpdatedAt ?? now
        })
    }
    const repository: UserProfileRepository & UserProfileMemoryRepository = {
        getEntriesByPresetAndIds: async () => [memory],
        listActiveMemorySpeakerLinks: async () => [
            { speakerKey: '张三', memoryId: memory.id }
        ],
        listPresetSpeakers: async () => [
            {
                id: 'speaker-1',
                presetId: 'preset-1',
                speakerKey: '张三',
                speakerLabel: options.speakerLabel ?? '张三',
                speakerAliases: options.speakerAliases ?? ['张三'],
                speakerId: 'user-1',
                platform: 'test',
                createdAt: now,
                updatedAt: now
            }
        ],
        upsertPresetSpeaker: async () => {},
        listUserProfilesByPreset: async () => existingProfiles,
        listUserProfilesBySpeakerKeys: async () => existingProfiles,
        replaceUserProfile: async (_presetId, profile) => {
            savedProfiles.push(profile)
        },
        markUserProfileReviewed: async (profileId, sourceMemoryIds) => {
            reviewedProfiles.push({ profileId, sourceMemoryIds })
        },
        deleteUserProfile: async () => {}
    }
    let pending: unknown[] = []
    // v2 的画像生成经 `chatluna.extract` 直接取结构化结果，不再构造工具调用消息。
    const ctx = {
        ai: { chat: () => ({ bind: async () => ({}) }) },
        presets: { get: (id: string) => options.presets?.[id] },
        chatluna: {
            extract: async (
                _schema: unknown,
                payload: { system: string; prompt: string }
            ) => {
                invocations.push({
                    system: payload.system,
                    prompt: payload.prompt
                })
                if (pending.length === 0) {
                    throw new Error('missing fake model response')
                }
                return pending.shift()
            }
        }
    } as unknown as Context
    const service = new LivingMemoryUserProfileService(
        ctx,
        {
            mainModel: 'test-model',
            userProfileMinMemoryCount: options.userProfileMinMemoryCount ?? 1,
            userProfileMemoryLimit: 20
        },
        repository,
        new LivingMemoryLogger(
            {
                info: (message: unknown) => debugMessages.push(String(message)),
                warn: () => {},
                error: () => {}
            } as never,
            () => options.debug ?? true
        ),
        { resolveOrGenerateCardText: async () => '你是测试角色。' }
    )

    return {
        savedProfiles,
        reviewedProfiles,
        debugMessages,
        invocations,
        run: async (responses: unknown[]) => {
            pending = [...responses]
            const result = await service.regenerate(
                options.presetId ?? 'preset-1',
                [memory.speakerKeys[0]]
            )
            return { result }
        }
    }
}

it('accepts manual user profile content without a length limit', () => {
    assert.equal(normalizeManualUserProfileContent('  手工画像  '), '手工画像')
    assert.throws(() => normalizeManualUserProfileContent('  '), /不能为空/u)
    assert.equal(
        normalizeManualUserProfileContent('甲'.repeat(301)),
        '甲'.repeat(301)
    )
})

it('matches Dream memories through a stable user identity old nickname', async () => {
    const harness = createHarness({
        speakerLabel: '新昵称',
        speakerAliases: ['张三', '新昵称']
    })
    const { result } = await harness.run([
        createProfileCall('我知道该用户正在准备考试。')
    ])

    assert.equal(result.generated, 1)
    assert.equal(harness.savedProfiles[0].speakerLabel, '新昵称')
})

it('skips profile generation below the active memory threshold', async () => {
    const harness = createHarness({ userProfileMinMemoryCount: 2 })
    const { result } = await harness.run([createProfileCall('不应生成。')])

    assert.equal(result.generated, 0)
    assert.equal(harness.invocations.length, 0)
})

it('skips regeneration when the profile input is unchanged', async () => {
    const harness = createHarness({
        existingSourceMemoryIds: [memory.id],
        existingProfileUpdatedAt: new Date(+now + 1)
    })
    const { result } = await harness.run([createProfileCall('不应生成。')])

    assert.equal(result.generated, 0)
    assert.equal(harness.invocations.length, 0)
    assert.equal(harness.savedProfiles.length, 0)
})

it('regenerates when the profile is not newer than its memories', async () => {
    const harness = createHarness({
        existingSourceMemoryIds: [memory.id],
        existingProfileUpdatedAt: now
    })
    const { result } = await harness.run([createProfileCall()])

    assert.equal(result.generated, 1)
    assert.equal(harness.invocations.length, 1)
    assert.match(result.detail, /已是最新：0 人/u)
})

const profileContent = '我知道张三正在准备考试。'

const createProfileCall = (content = profileContent) => ({
    action: 'update',
    content,
    reason: '记忆中有新的事实'
})

const createKeepCall = () => ({
    action: 'keep',
    reason: '旧画像已涵盖这些记忆'
})

it('passes user profile rules and memory data through prompts', async () => {
    const harness = createHarness()

    await harness.run([createProfileCall()])

    assert.equal(harness.invocations.length, 1)
    const { system, prompt } = harness.invocations[0]
    assert.match(system, /<output_contract>/u)
    assert.match(system, /<update_rules>/u)
    assert.match(system, /<preset_context>/u)
    assert.match(system, /你是preset-1，你正在维护张三的人物画像/u)
    assert.match(system, /张三的关系视角，使用第三人称/u)
    assert.doesNotMatch(system, /张三正在准备考试/u)
    assert.match(prompt, /<user_profile_input>/u)
    assert.doesNotMatch(prompt, /<assistant_label>/u)
    assert.doesNotMatch(prompt, /<speaker_label>/u)
    assert.doesNotMatch(prompt, /<preset_context>/u)
    assert.doesNotMatch(prompt, /<existing_source_memory_ids>/u)
    assert.match(prompt, /<memory_entries>/u)
    assert.match(prompt, /张三正在准备考试/u)
})

it('keeps user profile payloads out of logs when debug is disabled', async () => {
    const harness = createHarness({ debug: false })
    await harness.run([createProfileCall()])

    assert.ok(
        harness.debugMessages.every(
            (message) =>
                !message.includes(memory.content) &&
                !message.includes(profileContent)
        )
    )
})

it('uses the preset display name as the user profile assistant label', async () => {
    const harness = createHarness({
        presetId: 'preset-character',
        presets: { 'preset-character': { name: '角色甲' } }
    })

    await harness.run([createProfileCall()])

    const { system, prompt } = harness.invocations[0]
    assert.match(system, /你是角色甲，/u)
    assert.doesNotMatch(system, /角色甲（Character）/u)
    assert.doesNotMatch(prompt, /<assistant_label>/u)
})

it('does not rewrite or truncate generated user profile content', async () => {
    const harness = createHarness({
        existingSourceMemoryIds: ['memory-old']
    })
    const content = `张三的人物画像：${'甲'.repeat(301)}`
    const { result } = await harness.run([createProfileCall(content)])

    assert.equal(result.generated, 1)
    assert.equal(harness.savedProfiles.length, 1)
    assert.equal(harness.savedProfiles[0]?.content, content)
    assert.deepEqual(harness.savedProfiles[0]?.sourceMemoryIds, ['memory-1'])
})

it('records the reviewed input when the model chooses keep', async () => {
    const harness = createHarness({
        existingSourceMemoryIds: ['memory-old']
    })
    const { result } = await harness.run([createKeepCall()])

    assert.equal(result.generated, 0)
    assert.equal(harness.savedProfiles.length, 0)
    assert.deepEqual(harness.reviewedProfiles, [
        { profileId: 'profile-1', sourceMemoryIds: ['memory-1'] }
    ])
    assert.match(result.detail, /保持原样：1 人/u)
    assert.match(result.detail, /失败：0 人/u)
})

it('rejects keep without an existing profile and retries for an update', async () => {
    const harness = createHarness()
    const { result } = await harness.run([
        createKeepCall(),
        createProfileCall(profileContent)
    ])

    assert.equal(result.generated, 1)
    assert.equal(harness.invocations.length, 2)
    assert.equal(harness.savedProfiles[0]?.content, profileContent)
    assert.equal(harness.reviewedProfiles.length, 0)
})
