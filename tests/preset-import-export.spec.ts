import assert from 'node:assert/strict'
import { migrateLegacySources } from '../src/service/persistence/source_migration.ts'
import { routeIdOf } from '@chatluna/satori'
import { withLivingMemoryRepository } from './persistence-test-utils.ts'
import type {
    LivingMemoryPresetExport,
    LivingMemoryPresetExportEntry
} from '../src/contracts/memory.ts'
import { createPresetImportId } from '../src/service/persistence/normalizers.ts'
import { createSyntheticSpeakerLabel } from '../src/service/memory/speaker_identity.ts'

const createExportEntry = (
    id: string,
    index: number
): LivingMemoryPresetExportEntry => ({
    id,
    type: 'fact',
    status: 'active',
    content: `memory-${index}`,
    keywords: [`keyword-${index}`],
    summary: null,
    sentiment: null,
    importance: null,
    sourceConversationId: `conversation-${index}`,
    sourceOrigins: [],
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z'
})

it('copies preset data without moving source records', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sourcePresetId = 'preset-source'
        const targetPresetId = 'preset-target'
        const sourceMemory = await repository.createMemory(
            {
                conversationId: 'conversation-source',
                presetId: sourcePresetId,
                platform: 'onebot',
                userId: 'user-1'
            },
            {
                type: 'fact',
                content: 'source memory'
            }
        )
        await repository.replaceUserProfile(sourcePresetId, {
            speakerKey: 'speaker-key',
            speakerLabel: 'Speaker',
            content: 'source profile',
            sourceMemoryIds: [sourceMemory.id]
        })
        await repository.upsertPresetSpeaker({
            presetId: sourcePresetId,
            speakerKey: 'speaker-key',
            speakerLabel: 'Speaker'
        })

        const exported = await repository.exportPresetData(sourcePresetId)
        if (exported.version !== 6) {
            throw new Error('expected version 6 preset export')
        }
        const sourceProfile = exported.userProfiles[0]

        await repository.importPresetData(targetPresetId, exported)

        const retainedSourceMemories =
            await repository.listEntriesByPreset(sourcePresetId)
        const importedTargetMemories =
            await repository.listEntriesByPreset(targetPresetId)
        assert.deepEqual(
            retainedSourceMemories.map((entry) => entry.id),
            [sourceMemory.id]
        )
        assert.equal(importedTargetMemories.length, 1)
        assert.notEqual(importedTargetMemories[0].id, sourceMemory.id)
        assert.equal(importedTargetMemories[0].content, sourceMemory.content)
        assert.deepEqual(
            importedTargetMemories[0].speakerKeys,
            sourceMemory.speakerKeys
        )
        assert.deepEqual(
            await repository.listActiveMemorySpeakerLinks(targetPresetId, [
                sourceMemory.speakerKeys[0]
            ]),
            [
                {
                    speakerKey: sourceMemory.speakerKeys[0],
                    memoryId: importedTargetMemories[0].id
                }
            ]
        )

        const retainedSourceProfiles =
            await repository.listUserProfilesByPreset(sourcePresetId)
        const importedTargetProfiles =
            await repository.listUserProfilesByPreset(targetPresetId)
        assert.deepEqual(
            retainedSourceProfiles.map((profile) => profile.id),
            [sourceProfile.id]
        )
        assert.equal(importedTargetProfiles.length, 1)
        assert.notEqual(importedTargetProfiles[0].id, sourceProfile.id)
        assert.deepEqual(importedTargetProfiles[0].sourceMemoryIds, [
            importedTargetMemories[0].id
        ])

        assert.equal(
            (await repository.listPresetSpeakers(sourcePresetId)).length,
            1
        )
        const targetSpeakers =
            await repository.listPresetSpeakers(targetPresetId)
        assert.equal(targetSpeakers.length, 2)
        // 导出文件的注册行不含记忆实际关联的用户时，导入为该键合成注册行
        assert.equal(
            targetSpeakers.find(
                (speaker) => speaker.speakerKey === sourceMemory.speakerKeys[0]
            )?.speakerLabel,
            createSyntheticSpeakerLabel(sourceMemory.speakerKeys[0])
        )

        await repository.importPresetData(targetPresetId, exported)
        assert.deepEqual(
            (await repository.listEntriesByPreset(targetPresetId)).map(
                (entry) => entry.id
            ),
            [importedTargetMemories[0].id]
        )
        assert.deepEqual(
            (await repository.listUserProfilesByPreset(targetPresetId)).map(
                (profile) => profile.id
            ),
            [importedTargetProfiles[0].id]
        )
    })
})

it('exports v6 and imports historical entries with obsolete metadata', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const presetId = 'preset-import'
        const data = {
            version: 2 as const,
            exportedAt: '2026-10-28T00:00:00.000Z',
            sourcePresetId: presetId,
            entries: [
                { ...createExportEntry('legacy', 1), isConsolidated: true }
            ],
            userProfiles: [],
            presetSpeakers: []
        }
        await repository.importPresetData(presetId, data)
        const exported = await repository.exportPresetData(presetId)
        assert.equal(exported.version, 6)
        assert.equal(exported.entries[0].content, 'memory-1')
        assert.equal(
            Object.hasOwn(exported.entries[0], 'isConsolidated'),
            false
        )
        await repository.importPresetData(presetId, exported)
        assert.equal((await repository.listEntriesByPreset(presetId)).length, 1)
    })
})

it('synthesizes registry rows for keys missing from version 3 imports', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const targetPresetId = 'version-3-speakers'
        // 目标预设已有同键完整行：合成不得覆盖其昵称与身份字段
        await repository.upsertPresetSpeaker({
            presetId: targetPresetId,
            speakerKey: 'known-key',
            speakerLabel: '既有昵称',
            speakerId: 'user-1',
            platform: 'onebot'
        })
        const data: LivingMemoryPresetExport = {
            version: 3,
            exportedAt: '2026-08-06T00:00:00.000Z',
            sourcePresetId: 'preset-legacy',
            entries: [
                {
                    ...createExportEntry('version-3-entry', 1),
                    speakerKeys: ['known-key', 'unknown-key']
                }
            ],
            userProfiles: [],
            presetSpeakers: []
        }

        await repository.importPresetData(targetPresetId, data)

        const speakers = await repository.listPresetSpeakers(targetPresetId)
        const known = speakers.find(
            (speaker) => speaker.speakerKey === 'known-key'
        )
        assert.equal(known?.speakerLabel, '既有昵称')
        assert.equal(known?.speakerId, 'user-1')
        const unknown = speakers.find(
            (speaker) => speaker.speakerKey === 'unknown-key'
        )
        assert.equal(unknown?.speakerLabel, 'user:unknown-')
        assert.equal(unknown?.speakerId, null)
    })
})

it('maps old and native conversation keys to actual target conversations and ignores file labels', async () => {
    await withLivingMemoryRepository(async (ctx, repository) => {
        const route = (platform: string, id: string, direct = false) =>
            routeIdOf({ platform, selfId: 'bot', isDirect: direct, guildId: direct ? undefined : id,
                channelId: id, userId: direct ? id : 'speaker' })
        const qqGroup = route('onebot', '10000')
        const otherGroup = route('other', '10000')
        const dm = route('onebot', '20000', true)
        const personal = qqGroup + ':user:123'
        const custom = 'custom:' + 'a'.repeat(64)
        const uuid = '306c5f1e-1e16-46d5-8916-ba25392b39ac'
        const observedGuild = 'ab.1'
        const observedRoute = route('onebot', observedGuild)
        ctx.provide('chat_observer')
        ctx.set('chat_observer', {
            channelStats: () => [{ cid: `onebot:${observedGuild}`, routeId: observedRoute, conversationKey: custom }],
            channelOf: (key: string) => key === custom ? {
                routeId: observedRoute,
                identity: { platform: 'onebot', selfId: 'bot', isDirect: false, guildId: observedGuild }
            } : undefined
        } as never)
        await ctx.database.upsert('chatluna_conversations', [
            { key: qqGroup, peer: 'onebot:bot:guild:10000' },
            { key: otherGroup, peer: 'other:bot:guild:10000' },
            { key: dm, peer: 'onebot:bot:user:20000' },
            { key: personal, peer: 'onebot:bot:guild:10000' },
            { key: custom, peer: 'onebot:bot:guild:30000' }
        ])
        const samples: [string, string | null][] = [
            ['group:10000', null], ['onebot:guild:10000', qqGroup], ['private:20000', dm],
            ['group:30000', null], ['group:missing', null], [uuid, null],
            [qqGroup, qqGroup], [personal, personal], [custom, custom],
            [`group:${observedGuild}`, observedRoute], [observedRoute, observedRoute]
        ]
        const presetId = 'sources'
        const entries = samples.map(([sourceConversationId], i) => ({
            ...createExportEntry(String(i), i), sourceConversationId, speakerKeys: [],
            sourceLabel: '来源于「不可用于匹配的群」（群聊 ID：10000）的群聊'
        }))
        await repository.importPresetData(presetId, {
            version: 5, sourcePresetId: presetId, exportedAt: new Date().toISOString(),
            entries, presetSpeakers: [], userProfiles: []
        })
        const imported = await repository.listEntriesByPreset(presetId)
        for (const entry of imported) {
            assert.equal(entry.sourceConversationId, samples[Number(entry.id)][1])
        }
        const exported = await repository.exportPresetData(presetId)
        assert.equal(exported.version, 6)
        assert.ok(exported.entries.every(entry => !Object.hasOwn(entry, 'sourceLabel')))

        // 模拟旧版已导入的数据；启动升级只改确定的旧键，不碰原生会话。
        for (const entry of entries) await ctx.database.set('living_memory_entry', { id: entry.id }, {
            sourceConversationId: entry.sourceConversationId, sourceLabel: entry.sourceLabel
        })
        await migrateLegacySources(ctx)
        await migrateLegacySources(ctx)
        const indexSources = await repository.listEntryIndexSourcePageByPreset(presetId, null, samples.length)
        assert.equal(indexSources.length, samples.length)
        for (const source of indexSources) {
            assert.equal(source.sourceConversationId, samples[Number(source.id)][1])
        }
    })
})

it('preserves record ids when restoring the source preset', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const presetId = 'preset-restore'
        const memory = await repository.createMemory(
            {
                conversationId: 'conversation-restore',
                presetId
            },
            {
                type: 'fact',
                content: 'original memory'
            },
            ['original-speaker']
        )
        const exported = await repository.exportPresetData(presetId)

        const retained = await repository.createMemory(
            {
                conversationId: 'conversation-retained',
                presetId
            },
            {
                type: 'fact',
                content: 'retained memory'
            },
            ['retained-speaker']
        )

        await repository.updateMemory(memory.id, {
            content: 'changed memory',
            speakerKeys: ['temporary-speaker']
        })
        await repository.importPresetData(presetId, exported)

        const restored = await repository.listEntriesByPreset(presetId)
        assert.equal(restored.length, 2)
        assert.equal(
            restored.find((entry) => entry.id === memory.id)?.content,
            'original memory'
        )
        assert.deepEqual(
            await repository.listActiveMemorySpeakerLinks(presetId, [
                'original-speaker',
                'temporary-speaker',
                'retained-speaker'
            ]),
            [
                {
                    speakerKey: 'original-speaker',
                    memoryId: memory.id
                },
                {
                    speakerKey: 'retained-speaker',
                    memoryId: retained.id
                }
            ]
        )
    })
})

it('imports large preset exports in bounded batches', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const targetPresetId = 'large-import-target'
        const entries = Array.from({ length: 1001 }, (_, index) =>
            createExportEntry(index.toString(16).padStart(64, '0'), index)
        )
        const data: LivingMemoryPresetExport = {
            version: 1,
            exportedAt: '2026-08-06T00:00:00.000Z',
            sourcePresetId: 'large-import-source',
            entries,
            userProfiles: Array.from({ length: 101 }, (_, index) => ({
                id: `profile-${index}`,
                speakerKey: `speaker-${index}`,
                speakerLabel: `Speaker ${index}`,
                content: `profile-${index}`,
                sourceMemoryIds: [entries[index].id],
                createdAt: '2026-08-06T00:00:00.000Z',
                updatedAt: '2026-08-06T00:00:00.000Z'
            })),
            presetSpeakers: Array.from({ length: 101 }, (_, index) => ({
                speakerKey: `speaker-${index}`,
                speakerLabel: `Speaker ${index}`,
                speakerId: null,
                createdAt: '2026-08-06T00:00:00.000Z',
                updatedAt: '2026-08-06T00:00:00.000Z'
            }))
        }

        const result = await repository.importPresetData(targetPresetId, data)

        assert.deepEqual(result, {
            entries: 1001,
            userProfiles: 101,
            presetSpeakers: 101
        })
        assert.equal(
            (await repository.listEntriesByPreset(targetPresetId)).length,
            1001
        )
        const profiles =
            await repository.listUserProfilesByPreset(targetPresetId)
        assert.equal(profiles.length, 101)
        const firstProfile = profiles.find(
            (profile) => profile.speakerKey === 'speaker-0'
        )
        assert.ok(firstProfile)
        assert.deepEqual(firstProfile.sourceMemoryIds, [
            createPresetImportId('entry', targetPresetId, entries[0].id)
        ])
        assert.equal(
            (await repository.listPresetSpeakers(targetPresetId)).length,
            101
        )
        assert.deepEqual(await repository.listJobsByPreset(targetPresetId), [])
    })
})

it('rolls back all batches when a later import batch fails', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const targetPresetId = 'rollback-import-target'
        const entries = Array.from({ length: 102 }, (_, index) => {
            const id =
                index < 100
                    ? index.toString(16).padStart(64, '0')
                    : 'f'.repeat(64)
            return createExportEntry(id, index)
        })
        const data: LivingMemoryPresetExport = {
            version: 1,
            exportedAt: '2026-08-06T00:00:00.000Z',
            sourcePresetId: 'rollback-import-source',
            entries,
            userProfiles: [],
            presetSpeakers: []
        }

        await assert.rejects(
            repository.importPresetData(targetPresetId, data),
            /preset import failed during entries batch 2\/2/
        )
        assert.deepEqual(
            await repository.listEntriesByPreset(targetPresetId),
            []
        )

        const created = await repository.createMemory(
            {
                conversationId: 'rollback-health-check',
                presetId: targetPresetId
            },
            {
                type: 'fact',
                content: 'database remains writable after rollback'
            }
        )
        assert.equal(
            created.content,
            'database remains writable after rollback'
        )
    })
})
