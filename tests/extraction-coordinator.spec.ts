import assert from 'node:assert/strict'
import type {
    AttributedMemoryItem,
    ExtractionMemoryWriter,
    ExtractionPayload
} from '../src/contracts/workflows.ts'
import type { MemoryScope, MemorySourceMessage } from '../src/contracts/memory.ts'
import {
    type ExtractionJobRepository,
    LivingMemoryExtractionCoordinator,
    planExtractionChunks
} from '../src/service/workflows/extraction/coordinator.ts'
import { LivingMemoryChatHistory, type ChatHistoryEntry, type ChatHistoryScope } from '../src/service/chat_history.ts'
import { FrameworkHistoryFixture, historyMessage } from './chat-history-test-utils.ts'
import type { LivingMemoryExtractionResult } from '../src/service/workflows/extraction/extractor.ts'
import {
    createCapturedLogger,
    createJobStore,
    createMemoryEntry,
    scope as baseScope,
    waitFor
} from './workflow-test-utils.ts'

const scope: ChatHistoryScope = { ...baseScope, platform: 'onebot', sessionId: 'session-1' }

const createExtractionResult = (
    overrides: Partial<LivingMemoryExtractionResult> = {}
): LivingMemoryExtractionResult => ({
    extracted: [],
    skippedReason: null,
    parseError: null,
    ...overrides
})

const createExtractedMemory = (): AttributedMemoryItem => ({
    type: 'fact',
    content: 'memory',
    summary: 'memory summary',
    keywords: ['memory'],
    sentiment: 'neutral',
    importance: 0.5,
    speakerKeys: ['speaker-key']
})

interface CoordinatorHarnessOptions {
    window?: number
    includeOverheard?: boolean
    framework?: FrameworkHistoryFixture
    head?: () => Promise<number>
    extract?: () => Promise<LivingMemoryExtractionResult>
    createFailedJob?: ExtractionJobRepository['createFailedJob']
    appendExtractedMemories?: ExtractionMemoryWriter['appendExtractedMemories']
}

interface CoordinatorHarness {
    windowMessages: number
    includeOverheard: boolean
    coordinator: LivingMemoryExtractionCoordinator
    messageLog: TestHistory
    jobStore: ReturnType<typeof createJobStore>
    appended: {
        scope: MemoryScope
        sourceOriginMessages: MemorySourceMessage[]
        extracted: AttributedMemoryItem[]
        windowSpeakers?: ExtractionPayload['speakers']
    }[]
    getExtractorCalls: () => number
    getExtractorInputs: () => string[]
    /** 协调器传给提取器的取消信号；最后一次调用为准。 */
    getExtractorSignal: () => AbortSignal | undefined
    queued: string[][]
    dreamFlags: boolean[]
    warnings: unknown[][]
}

const createHarness = (
    options: CoordinatorHarnessOptions = {}
): CoordinatorHarness => {
    const extract = options.extract
    const jobStore = createJobStore()
    const appended: CoordinatorHarness['appended'] = []
    const queued: string[][] = []
    const dreamFlags: boolean[] = []
    const captured = createCapturedLogger(false)
    let extractorCalls = 0
    const extractorInputs: string[] = []
    let extractorSignal: AbortSignal | undefined

    const formatter = {
        toExtractionPayload: ((
            messages: {
                role: 'user' | 'assistant'
                speakerKey?: string
                contentLines: string[]
                speakerLabel: string
            }[]
        ): ExtractionPayload => {
            const speakerByLabel = new Map<string, string>()
            for (const message of messages) {
                if (message.role !== 'user') {
                    continue
                }
                if (!speakerByLabel.has(message.speakerLabel)) {
                    speakerByLabel.set(
                        message.speakerLabel,
                        message.speakerKey ?? `key-${message.speakerLabel}`
                    )
                }
            }
            return {
                input: messages
                    .map(
                        (message) =>
                            `${message.speakerLabel}: ${message.contentLines.join('|')}`
                    )
                    .join('\n'),
                sourceOriginMessages: messages.map((message) => ({
                    role: 'user' as const,
                    speakerLabel: message.speakerLabel,
                    content: message.contentLines.join('|'),
                    transcriptLines: [
                        `${message.speakerLabel}说：${message.contentLines.join('|')}`
                    ]
                })),
                speakers: [...speakerByLabel].map(
                    ([speakerLabel, speakerKey]) => ({
                        speakerLabel,
                        speakerKey
                    })
                )
            }
        }) as never
    }
    const extractor = {
        extract: async (input: string, _context: unknown, _logger: unknown, signal?: AbortSignal) => {
            extractorCalls += 1
            extractorInputs.push(input)
            extractorSignal = signal
            return await (extract?.() ??
                Promise.resolve(createExtractionResult()))
        }
    }
    const repository: ExtractionJobRepository & ExtractionMemoryWriter = {
        createFailedJob: options.createFailedJob ?? jobStore.createFailedJob,
        appendExtractedMemories:
            options.appendExtractedMemories ??
            (async (
                entryScope,
                sourceOriginMessages,
                extracted,
                windowSpeakers
            ) => {
                appended.push({
                    scope: entryScope,
                    sourceOriginMessages,
                    extracted,
                    windowSpeakers
                })
                return {
                    memories: extracted.map((_entry, index) =>
                        createMemoryEntry(`extracted-${index}`)
                    ),
                    warnings: []
                }
            })
    }
    const messageLog = new TestHistory()
    if (options.head !== undefined) messageLog.head = options.head

    const coordinator = new LivingMemoryExtractionCoordinator(
        options.framework ? new LivingMemoryChatHistory(options.framework) : messageLog,
        repository,
        repository,
        formatter,
        extractor,
        { resolveOrGenerateCardText: async () => '你是测试助手。' },
        captured.logger,
        (_preset, ids, _speakers, dream) => {
            dreamFlags.push(dream)
            queued.push(ids)
        }
    )
    return {
        windowMessages: options.window ?? 4,
        includeOverheard: options.includeOverheard ?? false,
        coordinator,
        messageLog,
        jobStore,
        appended,
        queued,
        dreamFlags,
        getExtractorCalls: () => extractorCalls,
        getExtractorInputs: () => extractorInputs,
        getExtractorSignal: () => extractorSignal,
        warnings: captured.warnings
    }
}

/** 测试用框架读取面，稀疏 position 刻意夹入非聊天历史位置。 */
class TestHistory {
    readonly entries: ChatHistoryEntry[] = []
    async head() { return this.entries.at(-1)?.position ?? -1 }
    async after(_scope: ChatHistoryScope, position: number, before = Infinity) {
        return this.entries.filter((entry) => entry.position > position && entry.position < before)
    }
    captureCursor() { return this.entries.at(-1)?.position ?? -1 }
    append(_conversationId: string, messages: Omit<ChatHistoryEntry, 'position'>[]) {
        for (const message of messages) {
            this.entries.push({ ...message, position: (this.entries.at(-1)?.position ?? -1) + 7 })
        }
    }
}

const entry = (role: 'user' | 'assistant', content: string): Omit<ChatHistoryEntry, 'position'> => ({
    messageId: content,
    platform: 'onebot',
    userId: role === 'assistant' ? 'bot-self' : 'user-1',
    name: role === 'assistant' ? 'bot' : '用户A',
    content: [{ type: 'text', text: content }],
    timestamp: Date.now(),
    role
})

const queueExtraction = async (
    harness: CoordinatorHarness,
    initialCursor?: number,
    eligiblePosition?: number,
    enableAutoDream = true
) => {
    await harness.coordinator.queue(
        scope,
        {
            includeOverheard: harness.includeOverheard,
            windowMessages: harness.windowMessages,
            enableAutoDream,
            formatTranscriptHeader: async () => '以下是聊天记录：'
        },
        initialCursor,
        eligiblePosition
    )
}

/**
 * 排干在 queue 返回之后才调用提取器，断言「没有提取」前须先让出，
 * 否则本不该发生的提取尚未开始，断言恒成立。
 */
const settleDrain = () => new Promise((resolve) => setTimeout(resolve, 20))

it('extracts each source independently when two channels use one custom conversation', async () => {
    const shared = { ...scope, conversationId: 'custom:test' }
    const framework = new FrameworkHistoryFixture(shared.conversationId)
    const h = createHarness({ framework, extract: async () => createExtractionResult({ extracted: [createExtractedMemory()] }) })
    const queue = (routeId: string, boundary = -1) => h.coordinator.queue(shared, {
        routeId, windowMessages: 2, includeOverheard: true, enableAutoDream: false,
        formatTranscriptHeader: async () => '会话记录'
    }, boundary)
    const push = (n: number, routeId: string) => framework.messages.push(historyMessage(n, routeId + n, { routeId, cid: 'onebot:' + routeId }))
    try {
        push(1, 'A')
        push(2, 'B')
        await Promise.all([queue('A'), queue('B')])
        await settleDrain()
        assert.equal(h.getExtractorCalls(), 0)
        push(3, 'A')
        push(4, 'B')
        await Promise.all([queue('A'), queue('B')])
        await waitFor(() => h.appended.length === 2, 'two source-specific memories')
        const batches = Object.fromEntries(h.appended.map(({ scope, sourceOriginMessages }) => [
            scope.conversationId, sourceOriginMessages.map(message => message.content)
        ]))
        assert.deepEqual(batches, { A: ['A1', 'A3'], B: ['B2', 'B4'] })
        h.coordinator.clearByConversation(shared.conversationId)
        const resetAt = 3
        push(5, 'A')
        await queue('A', resetAt)
        await settleDrain()
        assert.equal(h.getExtractorCalls(), 2)
    } finally {
        await h.coordinator.stop()
    }
})

describe('planExtractionChunks', () => {
    const log = (roles: ('user' | 'assistant')[]): ChatHistoryEntry[] =>
        roles.map((role, index) => ({ ...entry(role, `${role}-${index}`), position: index + 1 }))

    it('closes segments at the last assistant of each run and leaves the unclosed tail', () => {
        // u u a a u a u（末尾无 assistant 收尾）
        const chunks = planExtractionChunks(
            log([
                'user',
                'user',
                'assistant',
                'assistant',
                'user',
                'assistant',
                'user'
            ]),
            10,
            false
        )
        assert.deepEqual(chunks.map((chunk) => chunk.length), [6])
    })

    it('treats an assistant-only leading segment as one exchange', () => {
        // 游标后紧跟孤儿回复（触发消息未被记录）：首段纯 assistant，整段视为交流
        const chunks = planExtractionChunks(
            log(['assistant', 'assistant', 'user', 'assistant']),
            10,
            false
        )
        assert.deepEqual(chunks.map((chunk) => chunk.length), [4])
    })

    it('keeps an orphan assistant run beyond the window as an exchange', () => {
        // 窗口 2：最新交流＋前 2 条构成核心，孤儿回复 run 在核心外仍整段保留
        const chunks = planExtractionChunks(
            log([
                'assistant',
                'assistant',
                'user',
                'user',
                'user',
                'user',
                'user',
                'assistant'
            ]),
            2,
            false
        )
        assert.deepEqual(chunks.map((chunk) => chunk.length), [2, 4])
        assert.deepEqual(chunks[0].map((e) => e.messageId), [
            'assistant-0',
            'assistant-1'
        ])
        assert.equal(chunks[1][0].messageId, 'user-4')
        assert.ok(!chunks.flat().map((e) => e.messageId).includes('user-2'))
    })

    it('merges the exchange containing the window cut into one fuzzy chunk', () => {
        const chunks = planExtractionChunks(
            log(['user', 'assistant', 'user', 'assistant']),
            3,
            false
        )
        assert.deepEqual(chunks.map((chunk) => chunk.length), [4])
        assert.deepEqual(chunks[0].map((e) => e.messageId), [
            'user-0',
            'assistant-1',
            'user-2',
            'assistant-3'
        ])
    })

    it('drops far chitchat beyond one window from the newest exchange', () => {
        const roles: ('user' | 'assistant')[] = Array(50).fill('user')
        roles.push('assistant')
        const chunks = planExtractionChunks(log(roles), 30, false)
        // 段长 51、交流 2 条：核心＝交流＋窗口＝32，其余闲聊丢弃
        assert.equal(chunks.length, 1)
        assert.equal(chunks[0].length, 32)
        assert.equal(chunks[0][0].messageId, 'user-19')
        assert.equal(chunks[0][31].role, 'assistant')
    })

    it('keeps an exchange plus one window of context beyond the absorb budget', () => {
        // 40 条闲聊＋交流（1 user＋40 assistant＝41 条）：保留 max(45, 41+30)=71
        const roles: ('user' | 'assistant')[] = Array(41).fill('user')
        for (let index = 0; index < 40; index += 1) {
            roles.push('assistant')
        }
        const chunks = planExtractionChunks(log(roles), 30, false)
        assert.equal(chunks.length, 1)
        assert.equal(chunks[0].length, 71)
        assert.equal(chunks[0][0].messageId, 'user-10')
        assert.equal(chunks[0][70].role, 'assistant')
    })

    it('keeps beyond-window exchanges but drops their chitchat in anchored mode', () => {
        // 三段各＝10 闲聊＋交流(2)｜10 闲聊＋交流(2)｜4 闲聊＋交流(2)；窗口 6、预算 9
        // 核心＝2+6=8：最新段整段(6)＋次新段核心内 2 条；核心外只留交流
        const roles: ('user' | 'assistant')[] = []
        for (let round = 0; round < 2; round += 1) {
            for (let index = 0; index < 11; index += 1) {
                roles.push('user')
            }
            roles.push('assistant')
        }
        for (let index = 0; index < 5; index += 1) {
            roles.push('user')
        }
        roles.push('assistant')
        const chunks = planExtractionChunks(log(roles), 6, false)
        assert.deepEqual(chunks.map((chunk) => chunk.length), [2, 8])
        assert.deepEqual(chunks[0].map((e) => e.messageId), [
            'user-10',
            'assistant-11'
        ])
        assert.equal(chunks[1][0].messageId, 'user-22')
        assert.ok(chunks[1].map((e) => e.messageId).includes('user-24'))
        assert.equal(chunks[1][7].messageId, 'assistant-29')
        assert.ok(!chunks.flat().map((e) => e.messageId).includes('user-0'))
        assert.ok(!chunks.flat().map((e) => e.messageId).includes('user-12'))
    })

    it('keeps a segment within the absorb budget whole in overheard mode', () => {
        // 单段：4 用户 + 2 连续 assistant（段长 6，窗口 5、预算 7：不切）
        const chunks = planExtractionChunks(
            log(['user', 'user', 'user', 'user', 'assistant', 'assistant']),
            5,
            true
        )
        assert.deepEqual(chunks.map((chunk) => chunk.length), [6])
    })

    it('splits an over-budget segment preferring assistant boundaries in overheard mode', () => {
        // 单段：5 用户 + 2 连续 assistant（段长 7 > 预算 6，切在预算内最后一个 assistant 后）
        const chunks = planExtractionChunks(
            log([
                'user',
                'user',
                'user',
                'user',
                'user',
                'assistant',
                'assistant'
            ]),
            4,
            true
        )
        assert.deepEqual(chunks.map((chunk) => chunk.length), [6, 1])
        assert.equal(chunks[0][chunks[0].length - 1].role, 'assistant')
    })

    it('splits pure-chatter stretches at the absorb budget in overheard mode', () => {
        // 单段：7 用户 + 1 assistant（预算切片内无 assistant 时按预算硬切）
        const chunks = planExtractionChunks(
            log([
                'user',
                'user',
                'user',
                'user',
                'user',
                'user',
                'user',
                'assistant'
            ]),
            3,
            true
        )
        assert.deepEqual(chunks.map((chunk) => chunk.length), [4, 4])
        assert.equal(chunks[chunks.length - 1][3].role, 'assistant')
    })

    it('absorbs whole segments tail-anchored in overheard mode', () => {
        // 三轮交换各 2 条：合计 6 ≤ 预算 6，从最新向旧并入同块，不孤立最新一轮
        const chunks = planExtractionChunks(
            log([
                'user',
                'assistant',
                'user',
                'assistant',
                'user',
                'assistant'
            ]),
            4,
            true
        )
        assert.deepEqual(chunks.map((chunk) => chunk.length), [6])
        assert.equal(chunks[0][0].messageId, 'user-0')
        assert.equal(chunks[0][5].messageId, 'assistant-5')
    })
})

describe('LivingMemoryExtractionCoordinator', () => {
    for (const includeOverheard of [false, true]) {
        it(`extracts at the threshold with overheard=${includeOverheard}`, async () => {
            const harness = createHarness({ window: 4, includeOverheard })
            const initialCursor = includeOverheard
                ? harness.messageLog.captureCursor()
                : undefined
            if (!includeOverheard) await queueExtraction(harness, initialCursor)
            const role = includeOverheard ? 'user' : 'assistant'
            harness.messageLog.append(scope.conversationId, [
                entry('user', '问题'),
                entry(role, '回答')
            ])
            await queueExtraction(harness, initialCursor)
            assert.equal(harness.getExtractorCalls(), 0)

            harness.messageLog.append(scope.conversationId, [
                entry('user', '追问'),
                entry(role, '补充')
            ])
            await queueExtraction(harness, initialCursor)
            await waitFor(
                () => harness.getExtractorCalls() === 1,
                'drain settle'
            )
            assert.ok(harness.getExtractorInputs()[0].includes('问题'))
            assert.ok(harness.getExtractorInputs()[0].includes('补充'))
        })
    }

    it('skips extraction entirely when the window is zero', async () => {
        const harness = createHarness({ window: 0 })
        await queueExtraction(harness)
        harness.messageLog.append(scope.conversationId, [
            entry('user', 'a'),
            entry('assistant', 'b')
        ])
        await queueExtraction(harness)
        await settleDrain()
        assert.equal(harness.getExtractorCalls(), 0)
    })

    it('initializes the cold cursor at the current tail without dumping history', async () => {
        const harness = createHarness({ window: 2 })
        harness.messageLog.append(scope.conversationId, [
            entry('user', '旧消息'),
            entry('assistant', '旧回答')
        ])
        // 首个 after-chat：游标落在当时末尾，不回溯提取
        await queueExtraction(harness)
        assert.equal(harness.getExtractorCalls(), 0)

        harness.messageLog.append(scope.conversationId, [
            entry('user', '新消息'),
            entry('assistant', '新回答')
        ])
        await queueExtraction(harness)
        await waitFor(
            () => harness.getExtractorCalls() === 1,
            'post-init drain'
        )
        assert.ok(!harness.getExtractorInputs()[0].includes('旧消息'))
    })

    it('leaves an assistant-less tail unconsumed for the next drain', async () => {
        const harness = createHarness({ window: 2 })
        await queueExtraction(harness)
        harness.messageLog.append(scope.conversationId, [
            entry('user', '问题'),
            entry('assistant', '回答'),
            entry('user', '只有闲聊')
        ])
        await queueExtraction(harness)
        await waitFor(() => harness.getExtractorCalls() === 1, 'drain segment')
        assert.ok(harness.getExtractorInputs()[0].includes('问题'))
        assert.ok(!harness.getExtractorInputs()[0].includes('只有闲聊'))

        // 追加闲聊不闭合段：不消费
        harness.messageLog.append(scope.conversationId, [
            entry('user', '更多闲聊')
        ])
        await queueExtraction(harness)
        await settleDrain()
        assert.equal(harness.getExtractorCalls(), 1)
    })

    it('absorbs a sub-half-window overshoot into one fuzzy chunk', async () => {
        const harness = createHarness({ window: 4 })
        await queueExtraction(harness)
        harness.messageLog.append(scope.conversationId, [
            entry('user', 'q1'),
            entry('assistant', 'a1'),
            entry('user', 'q2'),
            entry('assistant', 'a2'),
            entry('user', 'q3'),
            entry('assistant', 'a3')
        ])
        await queueExtraction(harness)
        await waitFor(() => harness.getExtractorCalls() === 1, 'fuzzy chunk')
        // 三段共 6 条 > 窗口 4，但盈余 2 ≤ 半窗 2：并入同块，最新交换带上下文
        assert.ok(harness.getExtractorInputs()[0].includes('q1'))
        assert.ok(harness.getExtractorInputs()[0].includes('q3'))
    })

    it('splits whole-exchange chunks only when the remainder exceeds half the window', async () => {
        const harness = createHarness({ window: 2 })
        await queueExtraction(harness)
        harness.messageLog.append(scope.conversationId, [
            entry('user', 'q1'),
            entry('assistant', 'a1'),
            entry('user', 'q2'),
            entry('assistant', 'a2'),
            entry('user', 'q3'),
            entry('assistant', 'a3')
        ])
        await queueExtraction(harness)
        await waitFor(() => harness.getExtractorCalls() === 3, 'three chunks')
        // 窗口 2、半窗 1：每段 2 条，盈余 2 > 1 才允许独立成块，段不腰斩
        assert.ok(harness.getExtractorInputs()[0].includes('q1'))
        assert.ok(harness.getExtractorInputs()[2].includes('q3'))
    })

    it('retries a failing chunk and abandons it after three failures', async () => {
        let modelCalls = 0
        const harness = createHarness({
            window: 2,
            extract: () => {
                modelCalls += 1
                if (modelCalls <= 3) {
                    return Promise.reject(new Error('model down'))
                }
                return Promise.resolve(createExtractionResult())
            }
        })
        await queueExtraction(harness)
        harness.messageLog.append(scope.conversationId, [
            entry('user', 'q1'),
            entry('assistant', 'a1'),
            entry('user', 'q2'),
            entry('assistant', 'a2')
        ])

        // 连续两次失败：游标不动，不记任务
        await queueExtraction(harness)
        await waitFor(() => harness.warnings.length === 1, 'first failure')
        await queueExtraction(harness)
        await waitFor(() => harness.warnings.length === 2, 'second failure')
        assert.equal(harness.jobStore.jobs.length, 0)

        // 第三次失败达到上限：块 1 记任务放弃，同次排干继续块 2 并成功
        await queueExtraction(harness)
        await waitFor(
            () => harness.getExtractorCalls() === 4,
            'abandon and next'
        )
        assert.equal(harness.jobStore.jobs.length, 1)
        assert.ok(harness.getExtractorInputs()[0].includes('q1'))
        assert.ok(harness.getExtractorInputs()[3].includes('q2'))
    })

    it('retries exactly the failed batch when new messages arrive before retry', async () => {
        let calls = 0
        const harness = createHarness({ window: 2, extract: async () => {
            calls += 1
            if (calls === 1) throw new Error('temporary model failure')
            return createExtractionResult()
        } })
        await queueExtraction(harness)
        harness.messageLog.append(scope.conversationId, [entry('user', 'fixed-q'), entry('assistant', 'fixed-a')])
        await queueExtraction(harness)
        await waitFor(() => harness.warnings.length > 0, 'first failed batch')
        await settleDrain()
        harness.messageLog.append(scope.conversationId, [entry('user', 'later-q'), entry('assistant', 'later-a')])
        await queueExtraction(harness)
        await waitFor(() => harness.getExtractorCalls() === 3, 'retry and later batch')
        assert.equal(harness.getExtractorInputs()[0], harness.getExtractorInputs()[1])
        assert.doesNotMatch(harness.getExtractorInputs()[1], /later-q/)
        assert.match(harness.getExtractorInputs()[2], /later-q/)
    })

    it('does not read a later partially sent turn beyond the completed delivery head', async () => {
        let release!: () => void
        let calls = 0
        const gate = new Promise<void>((resolve) => { release = resolve })
        const harness = createHarness({ window: 2, extract: async () => {
            calls += 1
            if (calls === 1) await gate
            return createExtractionResult()
        } })
        await queueExtraction(harness)
        harness.messageLog.append(scope.conversationId, [
            entry('user', 'q1'), entry('assistant', 'a1'), entry('user', 'q2'), entry('assistant', 'a2')
        ])
        const completedHead = harness.messageLog.captureCursor()
        await queueExtraction(harness, undefined, completedHead)
        await waitFor(() => calls === 1, 'first extraction running')
        harness.messageLog.append(scope.conversationId, [entry('user', 'q3'), entry('assistant', 'partial-a3')])
        release()
        await waitFor(() => calls === 2, 'drain completed exchanges')
        await settleDrain()
        assert.equal(calls, 2)
        assert.ok(harness.getExtractorInputs().every((input) => !input.includes('q3')))
        harness.messageLog.append(scope.conversationId, [entry('assistant', 'final-a3')])
        await queueExtraction(harness, undefined, harness.messageLog.captureCursor())
        await waitFor(() => calls === 3, 'next fully sent exchange')
        assert.match(harness.getExtractorInputs()[2], /partial-a3/)
        assert.match(harness.getExtractorInputs()[2], /final-a3/)
    })

    it('retains the fixed batch when the extraction model is unavailable', async () => {
        let calls = 0
        const harness = createHarness({ window: 2, extract: async () => {
            calls += 1
            return createExtractionResult({ skippedReason: calls === 1 ? 'model-not-configured' : null })
        } })
        await queueExtraction(harness)
        harness.messageLog.append(scope.conversationId, [entry('user', 'q'), entry('assistant', 'a')])
        await queueExtraction(harness)
        await waitFor(() => calls === 1, 'unavailable model')
        await settleDrain()
        await queueExtraction(harness)
        await waitFor(() => calls === 2, 'configured model retry')
        assert.equal(harness.getExtractorInputs()[0], harness.getExtractorInputs()[1])
        assert.equal(harness.jobStore.jobs.length, 0)
    })

    it('writes extracted memories without creating jobs', async () => {
        const result = createExtractionResult({
            extracted: [createExtractedMemory()]
        })
        const harness = createHarness({
            window: 2,
            extract: () => Promise.resolve(result)
        })
        await queueExtraction(harness)
        harness.messageLog.append(scope.conversationId, [
            entry('user', 'q'),
            entry('assistant', 'a')
        ])
        await queueExtraction(harness)

        await waitFor(() => harness.appended.length === 1, 'memory written')
        assert.equal(harness.appended[0].extracted.length, 1)
        await waitFor(
            () => harness.queued.length === 1,
            'post-extraction task queued'
        )
        assert.deepEqual(harness.queued, [['extracted-0']])
        assert.equal(harness.jobStore.jobs.length, 0)
    })

    it('submits window speakers with extracted memories for registry coverage', async () => {
        const harness = createHarness({
            window: 2,
            extract: () =>
                Promise.resolve(
                    createExtractionResult({
                        extracted: [createExtractedMemory()]
                    })
                )
        })
        await queueExtraction(harness)
        harness.messageLog.append(scope.conversationId, [
            entry('user', 'q'),
            entry('assistant', 'a')
        ])
        await queueExtraction(harness)

        await waitFor(() => harness.appended.length === 1, 'memory written')
        assert.equal(harness.appended[0].scope.presetId, scope.presetId)
        assert.deepEqual(harness.appended[0].windowSpeakers.map((speaker) => speaker.speakerLabel), ['用户A'])
    })

    it('skips speaker registration when no memories are extracted', async () => {
        let call = 0
        const harness = createHarness({
            window: 2,
            extract: () => {
                call += 1
                return Promise.resolve(
                    call === 1
                        ? createExtractionResult()
                        : createExtractionResult({
                              extracted: [createExtractedMemory()]
                          })
                )
            }
        })
        await queueExtraction(harness)
        harness.messageLog.append(scope.conversationId, [
            entry('user', 'q'),
            entry('assistant', 'a')
        ])
        await queueExtraction(harness)
        await new Promise((resolve) => setTimeout(resolve, 25))

        harness.messageLog.append(scope.conversationId, [
            { ...entry('user', 'q2'), userId: 'user-2', name: '用户B' },
            entry('assistant', 'a2')
        ])
        await queueExtraction(harness)
        await waitFor(() => harness.appended.length === 1, 'memory written')

        assert.equal(harness.getExtractorCalls(), 2)
        assert.equal(harness.appended.length, 1)
        assert.deepEqual(harness.appended[0].windowSpeakers.map((speaker) => speaker.speakerLabel), ['用户B'])
    })

    it('records a failed job and consumes the chunk on parse errors', async () => {
        const harness = createHarness({
            window: 2,
            extract: () =>
                Promise.resolve(
                    createExtractionResult({ parseError: 'bad output' })
                )
        })
        await queueExtraction(harness)
        harness.messageLog.append(scope.conversationId, [
            entry('user', 'q'),
            entry('assistant', 'a')
        ])
        await queueExtraction(harness)
        await waitFor(() => harness.jobStore.jobs.length === 1, 'parse job')
        assert.equal(harness.getExtractorCalls(), 1)

        // 解析失败视为该块已消费，不重试
        await queueExtraction(harness)
        await settleDrain()
        assert.equal(harness.getExtractorCalls(), 1)
    })

    it('clears scope state by conversation', async () => {
        const harness = createHarness({ window: 2 })
        harness.messageLog.append(scope.conversationId, [
            entry('user', 'q'),
            entry('assistant', 'a')
        ])
        await queueExtraction(harness)
        assert.equal(harness.getExtractorCalls(), 0)

        harness.coordinator.clearByConversation(scope.conversationId)
        harness.messageLog.append(scope.conversationId, [
            entry('user', 'q2'),
            entry('assistant', 'a2')
        ])
        await queueExtraction(harness)
        // 清空后游标重置为当前末尾，重新起算
        await settleDrain()
        assert.equal(harness.getExtractorCalls(), 0)
    })

    it('retries an unavailable history head without keeping a rejected initializer', async () => {
        let fail = true
        const harness = createHarness({ window: 2, head: async () => {
            if (fail) throw new Error('history unavailable')
            return harness.messageLog.captureCursor()
        } })
        await assert.rejects(queueExtraction(harness), /history unavailable/)
        harness.messageLog.append(scope.conversationId, [entry('user', 'old-q'), entry('assistant', 'old-a')])
        fail = false
        await queueExtraction(harness)
        await settleDrain()
        assert.equal(harness.getExtractorCalls(), 0)
        harness.messageLog.append(scope.conversationId, [entry('user', 'new-q'), entry('assistant', 'new-a')])
        await queueExtraction(harness)
        await waitFor(() => harness.getExtractorCalls() === 1, 'history retry')
        assert.ok(harness.getExtractorInputs()[0].includes('new-q'))
        assert.ok(!harness.getExtractorInputs()[0].includes('old-q'))
    })

    it('stops a running drain whose scope state was cleared mid-run', async () => {
        let releaseExtractor!: () => void
        const extractorGate = new Promise<void>((resolve) => {
            releaseExtractor = resolve
        })
        const harness = createHarness({
            window: 2,
            extract: async () => {
                await extractorGate
                return createExtractionResult()
            }
        })
        await queueExtraction(harness)
        harness.messageLog.append(scope.conversationId, [
            entry('user', 'q'),
            entry('assistant', 'a')
        ])
        await queueExtraction(harness)
        await waitFor(() => harness.getExtractorCalls() === 1, 'drain gated')

        // 模型请求等待期间清空会话，随后新消息到达并由新状态接管
        harness.coordinator.clearByConversation(scope.conversationId)
        harness.messageLog.append(scope.conversationId, [
            entry('user', 'new-q'),
            entry('assistant', 'new-a')
        ])
        releaseExtractor()
        await new Promise((resolve) => setTimeout(resolve, 20))

        // 旧排干只完成在途块，不再消费新纪元消息
        assert.equal(harness.getExtractorCalls(), 1)
        assert.ok(harness.getExtractorInputs()[0].includes('q'))
        assert.ok(!harness.getExtractorInputs()[0].includes('new-q'))
    })

    it('cancels an in-flight drain without recording a failed job or committing memories', async () => {
        const harness = createHarness({
            window: 2,
            extract: async () => {
                const signal = harness.getExtractorSignal()!
                await new Promise((resolve, reject) =>
                    signal.addEventListener('abort', () => reject(signal.reason), {
                        once: true
                    })
                )
                return createExtractionResult({
                    extracted: [createExtractedMemory()]
                })
            }
        })
        // 首次入队建立游标，随后累积到窗口以上触发排干。
        await queueExtraction(harness)
        harness.messageLog.append(scope.conversationId, [
            entry('user', 'q1'),
            entry('assistant', 'a1'),
            entry('user', 'q2'),
            entry('assistant', 'a2')
        ])
        await queueExtraction(harness)
        await waitFor(() => harness.getExtractorCalls() === 1, 'drain started')
        assert.equal(harness.getExtractorSignal()?.aborted, false)

        await harness.coordinator.stop()

        // 取消不写失败任务、不提交记忆
        assert.deepEqual(harness.jobStore.jobs, [])
        assert.deepEqual(harness.appended, [])

        // 停止后不再接收新触发
        harness.messageLog.append(scope.conversationId, [
            entry('user', 'q3'),
            entry('assistant', 'a3'),
            entry('user', 'q4'),
            entry('assistant', 'a4')
        ])
        await queueExtraction(harness)
        await new Promise((resolve) => setTimeout(resolve, 20))
        assert.equal(harness.getExtractorCalls(), 1)
    })
})

it('keeps in-flight Dream settings and applies a new rule to the next extraction', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const h = createHarness({ window: 2, extract: async () => {
        await gate
        return createExtractionResult({ extracted: [createExtractedMemory()] })
    } })
    await queueExtraction(h)
    h.messageLog.append(scope.conversationId, [entry('user', 'q1'), entry('assistant', 'a1')])
    await queueExtraction(h)
    await waitFor(() => h.getExtractorCalls() === 1, 'first extraction started')
    h.messageLog.append(scope.conversationId, [entry('user', 'q2'), entry('assistant', 'a2')])
    await queueExtraction(h, undefined, undefined, false)
    release()
    await waitFor(() => h.dreamFlags.length === 2, 'both extractions saved')
    assert.deepEqual(h.dreamFlags, [true, false])
})
