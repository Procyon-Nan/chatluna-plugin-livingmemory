import assert from 'node:assert/strict'
import type { Context } from 'cordis'
import type { ChatOptions as ChatInvocation } from '@chatluna/ai-runtime/ops'
import { ModelId, ProviderId } from '@chatluna/symbol'
import type { ChatBlock, ChatSpecMessage, ChatToolCallBlock } from '@chatluna/message'
import { deepFreeze } from '@chatluna/utils/kit'
import { LivingMemoryLogger } from '../src/service/logging/logger.ts'
import type {
    LivingMemorySearchInput,
    LivingMemorySearchResult,
    MemoryScope
} from '../src/contracts/memory.ts'
import {
    memoryPassTool,
    memorySearchTool,
    memoryUpdateSnapshotTool
} from '../src/service/prompts/memory_tools.ts'
import { LivingMemoryAgenticRecallExecutor } from '../src/service/workflows/recall/agentic_recall.ts'
import type { LivingMemorySearchEngine } from '../src/service/workflows/recall/memory_search_engine.ts'

interface Fold {
    content: readonly ChatBlock[]
    text: string
    toolCalls: readonly ChatToolCallBlock[]
}

type ScriptedResponse = Fold | Error

interface SearchInvocation {
    presetId: string
    input: LivingMemorySearchInput
}

const config = {
    enableConversationIsolation: false,
    subModel: 'test/model',
    snapshotMaxLines: 5,
    memorySearchToolMaxResults: 30
} as const

const scope: MemoryScope = {
    conversationId: 'conversation-1',
    presetId: 'preset-1',
    presetLabel: '助手<&'
}

const chatHistory = '[2026-07-01 08:00] 助手：之前的答复\n[2026-07-01 08:01] 用户：记忆查询'

const call = (
    id: string,
    name: string,
    input: unknown
): Fold => {
    const block: ChatToolCallBlock = {
        type: 'tool-call',
        toolCallId: id as never,
        toolName: name,
        input: input as never
    }
    return { content: [block], text: '', toolCalls: [block] }
}

const searchCall = (id: string, input: unknown = { searchTexts: ['记忆'] }) =>
    call(id, memorySearchTool.name, input)

const snapshotCall = (id: string, text: string) =>
    call(id, memoryUpdateSnapshotTool.name, {
        operations: [{ type: 'append', text }]
    })

const passCall = (id = 'pass') => call(id, memoryPassTool.name, {})

const multipleCalls = (calls: [string, unknown][]): Fold => {
    const blocks = calls.map(
        ([id, input], index) =>
            ({
                type: 'tool-call',
                toolCallId: id as never,
                toolName: memorySearchTool.name,
                input: input as never,
                index
            }) as ChatToolCallBlock
    )
    return { content: blocks, text: '', toolCalls: blocks }
}

const createSearchResult = (id: string): LivingMemorySearchResult => ({
    id,
    type: 'fact',
    content: `content-${id}`,
    keywords: ['记忆'],
    summary: `summary-${id}`,
    sentiment: '平静',
    importance: 0.8,
    sourceLabel: '来源 · unknown',
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z')
})

interface HarnessOptions {
    responses: ScriptedResponse[]
    search?: (
        invocation: SearchInvocation
    ) => Promise<LivingMemorySearchResult[]>
}

const createHarness = (options: HarnessOptions) => {
    const responses = [...options.responses]
    const invocations: ChatInvocation[] = []
    const searchInvocations: SearchInvocation[] = []
    const debugMessages: string[] = []

    const ctx = {
        chatluna: {
            chat: async (request: ChatInvocation) => {
                invocations.push(deepFreeze(request))
                await request.beforeDispatch?.({
                    system: `框架转换后：${request.system}`,
                    messages: request.messages,
                    ...(request.toolSpecs && { tools: request.toolSpecs })
                }, { provider: ProviderId('test'), model: ModelId('model') }, { degradations: [] })
                const next = responses.shift()
                if (next === undefined) throw new Error('missing fake response')
                if (next instanceof Error) throw next
                return { ...next, finish: { kind: next.toolCalls.length ? 'tool-calls' : 'stop' } }
            }
        }
    } as unknown as Context

    const searchEngine = {
        searchMemories: async (
            presetId: string,
            input: LivingMemorySearchInput
        ) => {
            const invocation = { presetId, input: { ...input } }
            searchInvocations.push(invocation)
            return await (options.search?.(invocation) ?? [])
        }
    } as unknown as LivingMemorySearchEngine

    const executor = new LivingMemoryAgenticRecallExecutor(
        ctx,
        config,
        searchEngine,
        new LivingMemoryLogger(
            {
                info: (message: unknown) => debugMessages.push(String(message)),
                warn: () => {},
                error: () => {}
            } as never,
            () => true
        )
    )
    const saved: string[] = []
    return {
        invocations,
        debugMessages,
        searchInvocations,
        saved,
        run: () =>
            executor.run(
                config,
                scope,
                chatHistory,
                [],
                async (item) => {
                    saved.push(item.finalText)
                }
            )
    }
}

const toolMessages = (invocation: ChatInvocation | undefined) =>
    invocation?.messages.filter((message) => message.role === 'tool') ?? []

const toolResultText = (message: ChatSpecMessage | undefined) =>
    message?.content
        .filter((block) => block.type === 'tool-result')
        .map((block) => (block.output.type === 'text' ? block.output.value : ''))
        .join('')

it('runs one search then commits the snapshot', async () => {
    const search = searchCall('search-1')
    const harness = createHarness({
        responses: [
            { ...search, content: [
                { type: 'reasoning', text: '搜索前的模型思考' },
                { type: 'text', text: '工具之外的旁白' },
                ...search.content
            ] },
            snapshotCall('update', '我记得一段可靠的往事。')
        ],
        search: async () => [createSearchResult('memory-1')]
    })

    const snapshot = await harness.run()

    assert.ok(snapshot)
    assert.equal(snapshot.finalText, '我记得一段可靠的往事。')
    assert.equal(snapshot.matchedMemories.length, 1)
    assert.equal(snapshot.matchedMemories[0]?.content, 'content-memory-1')
    assert.deepEqual(snapshot.toolCallSummary.searchTexts, ['记忆'])
    assert.equal(harness.searchInvocations[0]?.presetId, scope.presetId)
    assert.deepEqual(harness.searchInvocations[0]?.input.memoryTypes, ['all'])
    const input = harness.invocations[0]?.messages[0]?.content.find((block) => block.type === 'text')?.text
    assert.ok(input)
    assert.ok(input.includes('<chat_history>\n' + chatHistory + '\n</chat_history>'))
    assert.equal(input.split('记忆查询').length - 1, 1)
    assert.equal(harness.invocations.length, 2)
    assert.match(JSON.stringify(harness.invocations[1]?.messages), /搜索前的模型思考/u)
    assert.doesNotMatch(harness.debugMessages.join('\n'), /搜索前的模型思考|工具之外的旁白/u)
    assert.ok(harness.debugMessages.some(message => message.startsWith('事件：召回工具结果;') &&
        message.includes(memoryUpdateSnapshotTool.name) && message.includes('执行成功')))
    const calls = harness.debugMessages.filter(message => message.startsWith('事件：召回模型调用;'))
    assert.equal(calls.length, 2)
    assert.match(calls[0]!, /框架转换后：/u)
    assert.doesNotMatch(calls[0]!, /content-memory-1/u)
    assert.doesNotMatch(calls[1]!, /框架转换后：|<chat_history>| · assistant========/u)
    assert.match(calls[1]!, /content-memory-1/u)
    assert.ok(harness.debugMessages.some(message => message.startsWith('事件：召回模型响应;') && message.includes(memorySearchTool.name)))
    assert.equal(harness.invocations[0]?.model, config.subModel)
    assert.match(String(harness.invocations[0]?.system), /你是助手&lt;&amp;/u)
    assert.equal(
        toolResultText(toolMessages(harness.invocations[1])[0]),
        [
            'type=fact',
            'updatedAt=2026-07-01T00:00:00.000Z',
            'sentiment=平静',
            '来源 · unknown',
            'content:',
            'content-memory-1'
        ].join('\n')
    )
})

it('rejects stringified arrays and allows a corrected search', async () => {
    const harness = createHarness({
        responses: [
            searchCall('invalid-1', { searchTexts: '["记忆"]' }),
            searchCall('search-2'),
            snapshotCall('update', '我记得修正查询后找到的内容。')
        ],
        search: async () => [createSearchResult('memory-2')]
    })

    const snapshot = await harness.run()

    assert.ok(snapshot)
    assert.equal(snapshot.matchedMemories.length, 1)
    assert.equal(harness.searchInvocations.length, 1)
    assert.match(
        toolResultText(toolMessages(harness.invocations[1])[0]),
        /参数不合法/u
    )
})

it('passes without updating after invalid search input', async () => {
    const harness = createHarness({
        responses: [
            searchCall('invalid-1', { searchTexts: '["记忆"]' }),
            passCall()
        ]
    })

    const snapshot = await harness.run()

    assert.equal(snapshot, null)
    assert.equal(harness.searchInvocations.length, 0)
    assert.deepEqual(harness.saved, [])
})

it('rejects multiple tool calls and accepts corrected serial calls', async () => {
    const harness = createHarness({
        responses: [
            multipleCalls([
                ['search-1', { searchTexts: ['记忆'] }],
                ['search-2', { searchTexts: ['计划'] }]
            ]),
            searchCall('search-3', { searchTexts: ['记忆'] }),
            searchCall('search-4', { searchTexts: ['计划'] }),
            snapshotCall('update', '我记得两段相关内容。')
        ],
        search: async (invocation) => [
            createSearchResult(invocation.input.searchTexts[0])
        ]
    })

    const snapshot = await harness.run()

    assert.ok(snapshot)
    assert.equal(harness.invocations.length, 4)
    assert.equal(harness.searchInvocations.length, 2)
    assert.match(
        harness.invocations[1]!.messages
            .map((message) => JSON.stringify(message.content))
            .join('\n'),
        /每次只调用一个工具/u
    )
    assert.deepEqual(
        snapshot.matchedMemories.map((memory) => memory.content),
        ['content-记忆', 'content-计划']
    )
})

it('allows the model to recover from an unknown tool call', async () => {
    const harness = createHarness({
        responses: [
            call('unknown-1', 'unknown_memory_tool', {}),
            searchCall('search-2'),
            snapshotCall('update', '我记得纠正工具名称后的结果。')
        ],
        search: async () => [createSearchResult('memory-4')]
    })

    const snapshot = await harness.run()

    assert.ok(snapshot)
    assert.equal(snapshot.matchedMemories.length, 1)
    assert.match(toolResultText(toolMessages(harness.invocations[1])[0]), /未知工具/u)
})

it('reprompts the model when it answers without a tool call', async () => {
    const harness = createHarness({
        responses: [
            { content: [{ type: 'text', text: '好的' }], text: '好的', toolCalls: [] },
            passCall()
        ]
    })

    const snapshot = await harness.run()

    assert.equal(snapshot, null)
    assert.match(
        harness.invocations[1]!.messages
            .map((message) => JSON.stringify(message.content))
            .join('\n'),
        /必须调用任务限定的工具/u
    )
})

it('propagates hard search service failures', async () => {
    const harness = createHarness({
        responses: [searchCall('search-1')],
        search: async () => {
            throw new Error('database unavailable')
        }
    })

    await assert.rejects(harness.run(), /database unavailable/u)
})

it('fails after six invalid tool calls without updating a recall result', async () => {
    const harness = createHarness({
        responses: Array.from({ length: 6 }, (_, index) =>
            searchCall(`invalid-${index + 1}`, { searchTexts: '["记忆"]' })
        )
    })

    await assert.rejects(harness.run(), /召回在 6 次模型调用内未完成/u)
    assert.equal(harness.invocations.length, 6)
    assert.equal(harness.searchInvocations.length, 0)
})

it('accepts a snapshot update on the sixth model call', async () => {
    const harness = createHarness({
        responses: [
            ...['一', '二', '三', '四', '五'].map((text, index) =>
                searchCall(`search-${index + 1}`, {
                    searchTexts: [`查询${text}`]
                })
            ),
            snapshotCall('update', '我记得在多次查询中确认的事实。')
        ],
        search: async (invocation) => [
            createSearchResult(`memory-${invocation.input.searchTexts[0]}`)
        ]
    })

    const snapshot = await harness.run()

    assert.ok(snapshot)
    assert.equal(snapshot.finalText, '我记得在多次查询中确认的事实。')
    assert.equal(snapshot.matchedMemories.length, 5)
    assert.equal(harness.invocations.length, 6)
    assert.deepEqual(snapshot.toolCallSummary.searchTexts, [
        '查询一',
        '查询二',
        '查询三',
        '查询四',
        '查询五'
    ])
})

it('passes after a search returns no memories', async () => {
    const harness = createHarness({
        responses: [searchCall('search-1'), passCall()],
        search: async () => []
    })

    const snapshot = await harness.run()

    assert.equal(snapshot, null)
    assert.equal(
        toolResultText(toolMessages(harness.invocations[1])[0]),
        '没有找到相关记忆。'
    )
})

it('deduplicates a memory returned by repeated searches', async () => {
    const harness = createHarness({
        responses: [
            searchCall('search-1', { searchTexts: ['记忆'] }),
            searchCall('search-2', { searchTexts: ['计划'] }),
            snapshotCall('update', '我记得两次查询返回的同一事实。')
        ],
        search: async () => [createSearchResult('memory-1')]
    })

    const snapshot = await harness.run()

    assert.ok(snapshot)
    assert.equal(harness.searchInvocations.length, 2)
    assert.equal(snapshot.matchedMemories.length, 1)
    assert.equal(snapshot.matchedMemories[0]?.content, 'content-memory-1')
})
