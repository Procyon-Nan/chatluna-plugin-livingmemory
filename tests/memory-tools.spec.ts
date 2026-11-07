import assert from 'node:assert/strict'
import { Schema } from '@chatluna/schema'
import { schemasteryToJsonSchemaNode } from '@chatluna/schema'
import type {
    LivingMemoryArchiveProvider,
    LivingMemoryCreationProvider,
    LivingMemoryMergeProvider,
    LivingMemorySearchProvider,
    LivingMemorySourceProvider,
    LivingMemorySplitProvider,
    LivingMemoryUpdateProvider
} from '../src/contracts/workflows.ts'
import type { LivingMemorySearchInput, MemoryEntryRecord } from '../src/contracts/memory.ts'
import {
    createCreateMemoryTool,
    createDeleteMemoryTool,
    createGetMessagesTool,
    createMergeMemoriesTool,
    createSplitMemoryTool,
    createUpdateMemoryTool
} from '../src/service/memory/tools/memory_tools.ts'
import { createSearchMemoryTool } from '../src/service/memory/tools/search_memory_tool.ts'
import {
    describeLivingMemoryToolScopeFailure,
    resolveToolMemoryPresetId,
    resolveToolMemoryScope,
    type LivingMemoryToolAgent
} from '../src/service/memory/tools/tool_runtime.ts'
import { memoryFieldDocs, requiredText } from '../src/service/prompts/schema.ts'
import {
    LivingMemoryFactsCommittedError,
    LivingMemoryVectorIndexError
} from '../src/service/vector_index/errors.ts'
import { runTool } from './tool-test-utils.ts'

const agent = (options: LivingMemoryToolAgent['options']): LivingMemoryToolAgent => ({ options })

const record = (id: string, type = 'fact'): MemoryEntryRecord =>
    ({
        id,
        presetId: 'default',
        speakerKeys: [],
        type,
        status: 'active',
        content: 'content',
        keywords: [],
        summary: null,
        sentiment: null,
        importance: null,
        sourceConversationId: null,
        sourceLabel: null,
        sourceOrigins: [],
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        updatedAt: new Date('2026-07-01T00:00:00.000Z')
    }) as MemoryEntryRecord

it('reads the preset from the agent options', () => {
    assert.deepEqual(resolveToolMemoryPresetId(agent({ presetId: 'default' })), {
        ok: true,
        presetId: 'default'
    })
    assert.deepEqual(resolveToolMemoryPresetId(agent({ presetId: '   ' })), {
        ok: false,
        reason: 'missing-preset'
    })
    assert.deepEqual(resolveToolMemoryPresetId(undefined), { ok: false, reason: 'missing-preset' })
    assert.match(describeLivingMemoryToolScopeFailure('missing-preset'), /Missing preset/u)
})

it('uses the resolved preset id for character sessions', () => {
    // v2 的 Character 引擎把预设记录自身的 id 写进 Agent options，
    // 不再需要 v1 的「（Character）」后缀拼接。
    assert.deepEqual(resolveToolMemoryPresetId(agent({ presetId: 'surtur' })), {
        ok: true,
        presetId: 'surtur'
    })
})

it('rebuilds the whole scope from the agent options', () => {
    assert.deepEqual(
        resolveToolMemoryScope(
            agent({
                presetId: 'default',
                conversationKey: 'route-1:user:user-1',
                location: { platform: 'onebot', user: 'user-1', guild: 'guild-1', channel: 'channel-1' }
            })
        ),
        {
            ok: true,
            scope: {
                conversationId: 'route-1:user:user-1',
                presetId: 'default',
                platform: 'onebot',
                userId: 'user-1',
                speakerId: 'user-1',
                guildId: 'guild-1',
                channelId: 'channel-1'
            }
        }
    )
})

it('rejects sub-agent calls and calls without a conversation', () => {
    assert.deepEqual(
        resolveToolMemoryScope(
            agent({
                presetId: 'default',
                conversationKey: 'subagent:task-1',
                permissions: { origin: ['parent-agent'] }
            })
        ),
        { ok: false, reason: 'subagent-tool-call' }
    )
    assert.match(describeLivingMemoryToolScopeFailure('subagent-tool-call'), /Sub-agent tool calls/u)

    assert.deepEqual(resolveToolMemoryScope(agent({ presetId: 'default' })), {
        ok: false,
        reason: 'missing-conversation-id'
    })
    assert.match(describeLivingMemoryToolScopeFailure('missing-conversation-id'), /conversation id/u)
})

it('always searches active memories and keeps the tool schema stable', async () => {
    const inputs: LivingMemorySearchInput[] = []
    const provider: LivingMemorySearchProvider = {
        searchMemories: async (_presetId, input) => {
            inputs.push(input)
            return []
        }
    }
    const tool = createSearchMemoryTool(provider, true)

    assert.deepEqual(Object.keys(tool.args.dict ?? {}), ['searchTexts', 'searchKeywords'])
    assert.equal(
        await runTool(tool, { searchTexts: ['我们聊过的事情'], memoryStatus: 'archived' }, { presetId: 'default' }),
        '没有找到相关记忆。'
    )
    assert.equal(inputs[0]?.memoryStatus, 'active')
    assert.deepEqual(inputs[0]?.memoryTypes, ['all'])
})

it('scopes the search to the conversation when isolation is enabled', async () => {
    const calls: (string | undefined)[] = []
    const provider: LivingMemorySearchProvider = {
        searchMemories: async (_presetId, _input, conversationId) => {
            calls.push(conversationId)
            return []
        }
    }
    const tool = createSearchMemoryTool(provider, true, () => true)

    await runTool(
        tool,
        { searchTexts: ['我们一起聊过的事情'] },
        { presetId: 'default', conversationKey: 'conversation-1' }
    )
    await runTool(
        createSearchMemoryTool(provider, true, () => false),
        { searchTexts: ['我们一起聊过的事情'] },
        { presetId: 'default', conversationKey: 'conversation-1' }
    )

    assert.deepEqual(calls, ['conversation-1', undefined])
})

it('renders search results with ids only when memory ids are included', async () => {
    const provider: LivingMemorySearchProvider = {
        searchMemories: async () => [
            {
                id: 'memory-1',
                type: 'fact',
                content: '我们在上周一起去看了展览。',
                keywords: ['展览'],
                summary: '看展览',
                sentiment: '愉快',
                importance: 0.8,
                sourceLabel: '来源于「摸鱼群」（群聊 ID：10001）的群聊',
                createdAt: new Date('2026-07-01T00:00:00.000Z'),
                updatedAt: new Date('2026-07-02T00:00:00.000Z')
            }
        ]
    }

    const expected = [
        'id=memory-1',
        'type=fact',
        'updatedAt=2026-07-02T00:00:00.000Z',
        'sentiment=愉快',
        'source=来源于「摸鱼群」（群聊 ID：10001）的群聊',
        'content:',
        '我们在上周一起去看了展览。'
    ].join('\n')
    for (const includeIds of [true, false]) {
        const output = await runTool(
            createSearchMemoryTool(provider, includeIds),
            { searchTexts: ['我们一起聊过的事情'] },
            { presetId: 'default' }
        )
        assert.equal(output, includeIds ? expected : expected.replace('id=memory-1\n', ''))
    }
})

it('renders source messages as the original transcript of one memory', async () => {
    const service: LivingMemorySourceProvider = {
        getMemorySourceMessages: async (_presetId, memoryId) => {
            if (memoryId !== 'memory-1') return null
            return {
                id: 'memory-1',
                sourceLabel: '来源于「摸鱼群」（群聊 ID：10001）的群聊',
                sourceOrigins: [
                    {
                        messages: [
                            {
                                role: 'user',
                                content: '展览你去看了吗',
                                transcriptLines: ['[2026-07-01 12:00] Alice说：展览你去看了吗']
                            }
                        ]
                    },
                    {
                        messages: [
                            {
                                role: 'assistant',
                                content: '下周再一起去',
                                transcriptLines: ['[2026-07-03 15:00] Alice说：下周再一起去']
                            }
                        ]
                    }
                ]
            }
        }
    }
    const tool = createGetMessagesTool(service)

    assert.equal(
        await runTool(tool, { memoryId: 'memory-1' }, { presetId: 'default' }),
        [
            'id=memory-1',
            'source=来源于「摸鱼群」（群聊 ID：10001）的群聊',
            '来源对话 1/2：',
            '[2026-07-01 12:00] Alice说：展览你去看了吗',
            '',
            '来源对话 2/2：',
            '[2026-07-03 15:00] Alice说：下周再一起去'
        ].join('\n')
    )
    await assert.rejects(
        runTool(tool, { memoryId: 'missing' }, { presetId: 'default' }),
        /不存在 ID 为 missing 的记忆，请重新查明记忆 ID 后再调用。/
    )
})

it('resolves speaker labels through the preset speakers', async () => {
    const created: { presetId: string; speakerKeys: string[]; scope: string }[] = []
    const speakers = [
        {
            id: 'speaker-1',
            presetId: 'default',
            speakerKey: 'key-alice',
            speakerLabel: 'Alice',
            speakerAliases: ['小A'],
            speakerId: 'user-1',
            platform: 'onebot',
            createdAt: new Date(),
            updatedAt: new Date()
        }
    ]
    const creation: LivingMemoryCreationProvider = {
        listPresetSpeakers: async () => speakers,
        createMemory: async (scope, input, speakerKeys) => {
            assert.deepEqual(input, {
                type: 'fact', content: '一起看了展览', summary: '看展览',
                keywords: ['展览'], sentiment: '愉快', importance: 0.6
            })
            created.push({ presetId: scope.presetId, speakerKeys, scope: scope.conversationId })
            return record('memory-1', input.type)
        }
    }

    const tool = createCreateMemoryTool(creation, 3)
    const result = await runTool<{ createdMemories: { id: string }[]; warnings: string[] }>(
        tool,
        {
            memories: [
                {
                    type: 'fact',
                    content: '一起看了展览',
                    summary: '看展览',
                    keywords: ['展览'],
                    speakerLabels: ['小A'],
                    status: 'archived',
                    sentiment: '愉快',
                    importance: 0.6
                }
            ]
        },
        { presetId: 'default', conversationKey: 'conversation-1' }
    )

    assert.deepEqual(result.createdMemories, [{ id: 'memory-1', type: 'fact' }])
    assert.deepEqual(result.warnings, [])
    assert.equal(created[0]?.presetId, 'default')
    assert.equal(created[0]?.scope, 'conversation-1')
    assert.deepEqual(created[0]?.speakerKeys, ['key-alice'])
})

it('reports a missing memory when updating', async () => {
    const updates: LivingMemoryUpdateProvider = {
        listPresetSpeakers: async () => [],
        updateActiveMemory: async () => null
    }

    await assert.rejects(
        runTool(
            createUpdateMemoryTool(updates),
            {
                memoryId: 'missing',
                memory: {
                    type: 'fact',
                    content: 'c',
                    summary: 's',
                    keywords: ['k'],
                    speakerLabels: [],
                    sentiment: '平静',
                    importance: 0.5
                }
            },
            { presetId: 'default' }
        ),
        /不存在 ID 为 missing 的记忆/
    )
})

it('merges and splits with attributed speaker keys', async () => {
    const merged: unknown[] = []
    const merges: LivingMemoryMergeProvider = {
        listPresetSpeakers: async () => [],
        mergeActiveMemories: async (_presetId, sourceMemoryIds, memory) => {
            merged.push({ sourceMemoryIds, speakerKeys: memory.speakerKeys })
            return { memory: record('merged-1'), warnings: [] }
        }
    }
    const split: LivingMemorySplitProvider = {
        listPresetSpeakers: async () => [],
        splitActiveMemory: async (_presetId, sourceMemoryId, memories) => ({
            memories: memories.map((_memory, index) => record(`split-${index}`)),
            warnings: []
        })
    }

    const mergeResult = await runTool<{ memoryId: string; merged: boolean }>(
        createMergeMemoriesTool(merges),
        {
            sourceMemoryIds: ['a', 'b'],
            memory: {
                type: 'fact',
                content: 'c',
                summary: 's',
                keywords: ['k'],
                speakerLabels: [],
                sentiment: '平静',
                importance: 0.5
            }
        },
        { presetId: 'default' }
    )
    assert.equal(mergeResult.memoryId, 'merged-1')
    assert.equal(mergeResult.merged, true)
    assert.deepEqual(merged[0], { sourceMemoryIds: ['a', 'b'], speakerKeys: [] })

    const splitResult = await runTool<{ memoryIds: string[]; split: boolean }>(
        createSplitMemoryTool(split),
        {
            sourceMemoryId: 'a',
            memories: [
                { type: 'fact', content: 'c1', summary: 's1', keywords: ['k'], speakerLabels: [], sentiment: '平静', importance: 0.5 },
                { type: 'fact', content: 'c2', summary: 's2', keywords: ['k'], speakerLabels: [], sentiment: '平静', importance: 0.5 }
            ]
        },
        { presetId: 'default' }
    )
    assert.deepEqual(splitResult.memoryIds, ['split-0', 'split-1'])
    assert.equal(splitResult.split, true)
})

it('reports a missing memory when deleting', async () => {
    const archives: LivingMemoryArchiveProvider = {
        archiveActiveMemories: async () => ({ archived: 0 })
    }

    await assert.rejects(
        runTool(createDeleteMemoryTool(archives), { memoryId: 'missing' }, { presetId: 'default' }),
        /不存在 ID 为 missing 的记忆/
    )
})

it('keeps field constraints in the tool schema even though descriptions are dropped', () => {
    const tool = createCreateMemoryTool(
        { listPresetSpeakers: async () => [], createMemory: async () => record('m') },
        3
    )
    const json = schemasteryToJsonSchemaNode(tool.args) as {
        properties: { memories: { minItems?: number; maxItems?: number; items: { required: string[] } } }
    }

    assert.equal(json.properties.memories.minItems, 1)
    assert.equal(json.properties.memories.maxItems, 3)
    assert.deepEqual(json.properties.memories.items.required, [
        'type',
        'content',
        'summary',
        'keywords',
        'speakerLabels',
        'sentiment',
        'importance'
    ])
})

it('carries the field documentation in the tool description', () => {
    const tool = createCreateMemoryTool(
        { listPresetSpeakers: async () => [], createMemory: async () => record('m') },
        2
    )

    for (const doc of Object.values(memoryFieldDocs)) {
        assert.ok(tool.description?.includes(doc), `missing field doc: ${doc}`)
    }
})

it('trims text fields and rejects empty values', () => {
    const schema = Schema.object({ text: requiredText('文本') })

    assert.deepEqual(schema({ text: '  hi  ' }), { text: 'hi' })
    assert.throws(() => schema({ text: '   ' }), /expected a non-empty string/u)
})
it('reports committed memories as saved with a warning when index synchronization fails', async () => {
    let invoked = 0
    const creation: LivingMemoryCreationProvider = {
        listPresetSpeakers: async () => [],
        createMemory: async (_scope, input) => {
            invoked += 1
            if (invoked === 2) {
                throw new LivingMemoryFactsCommittedError('injected index failure', {})
            }
            return record(`memory-${invoked}`, input.type)
        }
    }
    const memory = {
        type: 'fact' as const,
        content: 'c',
        summary: 's',
        keywords: ['k'],
        speakerLabels: [] as string[],
        sentiment: '平静',
        importance: 0.5
    }

    const output = await runTool<{ createdMemories: unknown[]; warnings: string[] }>(
        createCreateMemoryTool(creation, 10),
        { memories: [memory, memory] },
        { presetId: 'default', conversationKey: 'conversation-1' }
    )

    assert.equal(invoked, 2)
    assert.equal(output.createdMemories.length, 1)
    assert.equal(output.warnings.length, 1)
    assert.match(output.warnings[0] ?? '', /已调度后台自动对账/u)
})

it('propagates not-ready failures before any memory is committed', async () => {
    const notReady = new LivingMemoryVectorIndexError('not-ready', 'building', 'vector index is not ready')
    const creation: LivingMemoryCreationProvider = {
        listPresetSpeakers: async () => [],
        createMemory: async () => {
            throw notReady
        }
    }
    const memory = {
        type: 'fact' as const,
        content: 'c',
        summary: 's',
        keywords: ['k'],
        speakerLabels: [] as string[],
        sentiment: '平静',
        importance: 0.5
    }

    await assert.rejects(
        runTool(createCreateMemoryTool(creation, 10), { memories: [memory] }, {
            presetId: 'default',
            conversationKey: 'conversation-1'
        }),
        (error: unknown) => error === notReady
    )
})

it('rejects tool calls without a resolvable scope', async () => {
    const creation: LivingMemoryCreationProvider = {
        listPresetSpeakers: async () => [],
        createMemory: async () => record('m')
    }
    const memory = {
        type: 'fact' as const,
        content: 'c',
        summary: 's',
        keywords: ['k'],
        speakerLabels: [] as string[],
        sentiment: '平静',
        importance: 0.5
    }

    await assert.rejects(
        runTool(createCreateMemoryTool(creation, 10), { memories: [memory] }, {}),
        /Missing preset/u
    )
})
