import assert from 'node:assert/strict'
import type {
    AgenticMemorySnapshotItem,
    LivingMemoryTranscriptMessage
} from '../src/contracts/memory.ts'
import {
    LivingMemoryRecallCoordinator,
    type RecallWorkflowRepository
} from '../src/service/workflows/recall/coordinator.ts'
import type { LivingMemoryLogger } from '../src/service/logging/logger.ts'
import {
    createSnapshotItem,
    createCapturedLogger,
    createJobStore,
    logger,
    scope as baseScope,
    waitFor
} from './workflow-test-utils.ts'
import { withLivingMemoryRepository } from './persistence-test-utils.ts'

const scope = { ...baseScope, sessionId: 'session-1' }

const chatHistory: LivingMemoryTranscriptMessage[] = [
    { role: 'assistant', speakerLabel: '助手', contentLines: ['之前的答复'], createdAt: new Date(2026, 6, 1, 8, 0) },
    { role: 'user', speakerLabel: '用户', contentLines: ['记忆查询'], createdAt: new Date(2026, 6, 1, 8, 1) }
]

type AgenticRun = (
    chatHistory: string,
    runLogger: LivingMemoryLogger,
    signal?: AbortSignal
) => Promise<AgenticMemorySnapshotItem | null>

const defaultRun: AgenticRun = async () => createSnapshotItem('记得')

const createCoordinator = (options: {
    repository?: Partial<RecallWorkflowRepository>
    run?: AgenticRun
    positions?: () => number[]
    recallIntervalMessages?: number
    subModel?: string
    logger?: LivingMemoryLogger
}) => {
    const run = options.run ?? defaultRun
    return Object.assign(new LivingMemoryRecallCoordinator(
        options.subModel ?? 'test/sub-model',
        {
            after: async (_scope, after, before = Infinity) => {
                const positions = options.positions?.() ?? Array.from({ length: 120 }, (_, index) => index + 1)
                return positions.filter((position) => position > after && position < before).map((position) => ({
                    position, messageId: String(position), platform: 'onebot', content: 'chat',
                    timestamp: 1_000, role: 'user' as const
                }))
            }
        },
        {
            createFailedJob: createJobStore().createFailedJob,
            upsertSnapshot: async () => {},
            getLatestSnapshotByScope: async () => undefined,
            ...options.repository
        },
        {
            run: async (
                _rules,
                _scope,
                chatHistory,
                _snapshotLines,
                saveSnapshot,
                runLogger: LivingMemoryLogger,
                signal?: AbortSignal
            ) => {
                const snapshot = await run(chatHistory, runLogger, signal)
                if (snapshot !== null) await saveSnapshot(snapshot)
                return snapshot
            }
        },
        options.logger ?? logger
    ), { rules: { recallIntervalMessages: options.recallIntervalMessages ?? 1, snapshotMaxLines: 5, snapshotScope: 'conversation' as const, enableConversationIsolation: false } })
}

it('isolates custom sources for recall without changing which snapshot the conversation owns', async () => {
    const seen: string[] = []
    const snapshots: (string | null)[] = []
    const shared = { ...scope, conversationId: 'custom:test' }
    const rules = { recallIntervalMessages: 20, snapshotMaxLines: 5, enableConversationIsolation: true, snapshotScope: 'conversation' as const }
    const coordinator = new LivingMemoryRecallCoordinator('test/model', { after: async () => [] }, {
        createFailedJob: createJobStore().createFailedJob,
        upsertSnapshot: async () => {},
        getLatestSnapshotByScope: async scope => { snapshots.push(scope.conversationId); return undefined }
    }, { run: async (_rules, source) => { seen.push(source.conversationId); return null } }, logger)
    try {
        await coordinator.queue(rules, shared, chatHistory, 1, 'A')
        await coordinator.queue(rules, shared, chatHistory, 2, 'B')
        await waitFor(() => seen.length === 2, 'recall in both sources')
        assert.deepEqual(seen, ['A', 'B'])
        assert.deepEqual(snapshots, [shared.conversationId, shared.conversationId])
        await assert.rejects(coordinator.queue(rules, shared, chatHistory, 3), /来源路由/u)
    } finally {
        await coordinator.stop()
    }
})

it('edits a shared snapshot in order while retaining the triggering conversation', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const bothSaved = Promise.withResolvers<void>()
        const started: string[] = []
        const gate = Promise.withResolvers<void>()
        const coordinator = new LivingMemoryRecallCoordinator('test/model', { after: async () => [] }, repository, {
            run: async (_settings, origin, _input, previous, save) => {
                started.push(origin.conversationId)
                if (origin.conversationId === 'A') await gate.promise
                const item = createSnapshotItem([...previous, origin.conversationId].join('\n'))
                await save(item)
                if (origin.conversationId === 'B') bothSaved.resolve()
                return item
            }
        }, logger)
        const rules = { recallIntervalMessages: 2, snapshotMaxLines: 5, enableConversationIsolation: false, snapshotScope: 'preset' as const }
        const shared = { presetId: scope.presetId, conversationId: null }
        try {
            await coordinator.queue(rules, { ...scope, conversationId: 'A' }, chatHistory, 1)
            await waitFor(() => started.length === 1, 'A starts')
            await coordinator.queue(rules, { ...scope, conversationId: 'B' }, chatHistory, 1)
            assert.deepEqual(started, ['A'])
            gate.resolve()
            await waitFor(() => started.length === 2, 'B starts')
            await bothSaved.promise
            assert.equal((await repository.getLatestSnapshotByScope(shared))?.items[0]?.finalText, 'A\nB')
            assert.equal((await repository.listSnapshotsByPreset(scope.presetId)).length, 1)
            await repository.deleteSnapshotsByConversation('A')
            assert.equal((await repository.getLatestSnapshotByScope(shared))?.items[0]?.finalText, 'A\nB')
            assert.equal(await repository.getLatestSnapshotByScope({ ...shared, presetId: 'other' }), undefined)
        } finally {
            gate.resolve()
            await coordinator.stop()
        }
    })
})

it('replaces a queued recall with the first turn after a conversation reset', async () => {
    const release = Promise.withResolvers<void>()
    const calls: string[] = []
    const coordinator = createCoordinator({ run: async input => {
        const label = input.split('：').at(-1)!
        calls.push(label)
        if (label === 'A') await release.promise
        return null
    } })
    const rules = { ...coordinator.rules, snapshotScope: 'preset' as const }
    const send = (conversationId: string, text: string) => coordinator.queue(
        rules, { ...scope, conversationId }, [{ ...chatHistory[1], contentLines: [text] }], 1
    )
    try {
        await send('A', 'A')
        await waitFor(() => calls.length === 1, 'A starts')
        await send('B', 'before reset')
        coordinator.clearByConversation('B')
        await send('B', 'after reset')
        release.resolve()
        await waitFor(() => calls.length >= 2, 'B starts')
        assert.deepEqual(calls, ['A', 'after reset'])
    } finally {
        release.resolve()
        await coordinator.stop()
    }
})

it('persists the agentic snapshot without persisting a successful job', async () => {
    const jobStore = createJobStore()
    const snapshots: { query: string; items: AgenticMemorySnapshotItem[] }[] =
        []
    const captured = createCapturedLogger(false)
    const coordinator = createCoordinator({
        repository: {
            createFailedJob: jobStore.createFailedJob,
            upsertSnapshot: async (_scope, query, items) => {
                snapshots.push({ query, items })
            }
        },
        run: async () => createSnapshotItem('  remembered context  '),
        logger: captured.logger
    })

    await coordinator.queue(coordinator.rules, scope, chatHistory, 100)
    await waitFor(
        () =>
            captured.info.some((message) =>
                message.includes('事件：召回快照已更新;')
            ),
        'agentic recall snapshot update'
    )

    assert.equal(jobStore.jobs.length, 0)
    assert.equal(snapshots.length, 1)
    const snapshot = createSnapshotItem('  remembered context  ')
    assert.equal(snapshots[0].query, JSON.stringify(snapshot.toolCallSummary))
    assert.deepEqual(snapshots[0].items, [snapshot])
    assert.ok(
        captured.info.some((message) => message.includes('remembered context'))
    )
})

it('keeps the previous snapshot without persisting a job when the agent passes', async () => {
    const jobStore = createJobStore()
    let snapshotWrites = 0
    const captured = createCapturedLogger()
    const coordinator = createCoordinator({
        repository: {
            createFailedJob: jobStore.createFailedJob,
            upsertSnapshot: async () => {
                snapshotWrites += 1
            }
        },
        run: async () => null,
        logger: captured.logger
    })

    await coordinator.queue(coordinator.rules, scope, chatHistory, 100)
    await waitFor(
        () =>
            captured.info.some((message) =>
                message.includes('事件：召回结束;')
            ),
        'agentic no-memory result'
    )

    assert.equal(snapshotWrites, 0)
    assert.equal(jobStore.jobs.length, 0)
})

it('skips empty chat history without reading a snapshot or consuming the interval', async () => {
    const jobStore = createJobStore()
    let snapshotReads = 0
    let runCalls = 0
    const coordinator = createCoordinator({
        repository: {
            createFailedJob: jobStore.createFailedJob,
            getLatestSnapshotByScope: async () => { snapshotReads++; return undefined }
        },
        run: async () => { runCalls++; return null },
        recallIntervalMessages: 10
    })

    await coordinator.queue(coordinator.rules, scope, [], 100)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(snapshotReads, 0)
    assert.equal(runCalls, 0)
    assert.equal(jobStore.jobs.length, 0)

    await coordinator.queue(coordinator.rules, scope, chatHistory, 101)
    await waitFor(() => runCalls === 1, 'first nonempty chat window')
})

it('skips recall without persisting a job when subModel is not configured', async () => {
    const jobStore = createJobStore()
    let runCalls = 0
    const captured = createCapturedLogger()
    const coordinator = createCoordinator({
        repository: { createFailedJob: jobStore.createFailedJob },
        run: async () => {
            runCalls += 1
            return createSnapshotItem('unused')
        },
        subModel: '无',
        logger: captured.logger
    })

    await coordinator.queue(coordinator.rules, scope, chatHistory, 100)

    assert.equal(runCalls, 0)
    assert.equal(jobStore.jobs.length, 0)
    assert.ok(
        captured.info.some(
            (message) =>
                message.startsWith('事件：跳过记忆召回;') &&
                message.includes('原因：召回模型未配置')
        )
    )
})

it('serializes recall runs for the same scope without persisted running state', async () => {
    const jobStore = createJobStore()
    let resolveRun: ((snapshot: null) => void) | undefined
    let runCalls = 0
    const captured = createCapturedLogger()
    const pendingRun = new Promise<null>((resolve) => {
        resolveRun = resolve
    })
    const coordinator = createCoordinator({
        repository: { createFailedJob: jobStore.createFailedJob },
        run: async () => {
            runCalls += 1
            return await pendingRun
        },
        logger: captured.logger
    })

    await coordinator.queue(coordinator.rules, scope, chatHistory, 100)
    // 间隔已满足：第二次请求越过间隔检查，只能被运行锁拦下
    await coordinator.queue(coordinator.rules, scope, chatHistory, 101)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(runCalls, 1)

    assert.ok(resolveRun)
    resolveRun(null)
    await waitFor(
        () =>
            captured.info.some((message) =>
                message.includes('事件：召回结束;')
            ),
        'serialized recall completion'
    )

    assert.equal(jobStore.jobs.length, 0)
})

it('persists one failed recall job when the agentic executor throws', async () => {
    const jobStore = createJobStore()
    const coordinator = createCoordinator({
        repository: { createFailedJob: jobStore.createFailedJob },
        run: async () => {
            throw new Error('agentic failure')
        }
    })

    await coordinator.queue(coordinator.rules, scope, chatHistory, 100)
    await waitFor(() => jobStore.jobs.length === 1, 'failed agentic recall')

    const job = jobStore.jobs[0]
    assert.equal(job?.status, 'failed')
    assert.equal(job?.input, '[2026-07-01 08:00] 助手：之前的答复\n[2026-07-01 08:01] 用户：记忆查询')
    assert.equal(+job!.createdAt, +job!.startedAt!)
    assert.ok(+job!.finishedAt! >= +job!.startedAt!)
    assert.match(job?.error ?? '', /agentic failure/u)
})

it('persists one failed recall job when snapshot persistence throws', async () => {
    const jobStore = createJobStore()
    const coordinator = createCoordinator({
        repository: {
            createFailedJob: jobStore.createFailedJob,
            upsertSnapshot: async () => {
                throw new Error('snapshot write failure')
            }
        }
    })

    await coordinator.queue(coordinator.rules, scope, chatHistory, 100)
    await waitFor(() => jobStore.jobs.length === 1, 'failed snapshot write')

    assert.match(jobStore.jobs[0]?.error ?? '', /snapshot write failure/u)
})

it('retries immediately after a failed recall instead of waiting out the interval', async () => {
    const jobStore = createJobStore()
    let runCalls = 0
    const coordinator = createCoordinator({
        repository: { createFailedJob: jobStore.createFailedJob },
        run: async () => {
            runCalls += 1
            if (runCalls === 1) {
                throw new Error('agentic failure')
            }
            return createSnapshotItem('记得')
        },
        recallIntervalMessages: 10
    })

    await coordinator.queue(coordinator.rules, scope, chatHistory, 100)
    await waitFor(() => jobStore.jobs.length === 1, 'failed first recall')
    await new Promise((resolve) => setTimeout(resolve, 0))

    // 日志没有新消息：锚点若未清除，这次请求会被间隔拦下
    await coordinator.queue(coordinator.rules, scope, chatHistory, 100)
    await waitFor(() => runCalls === 2, 'immediate retry')
})

it('gates recall by message gap since the last executed recall', async () => {
    const snapshots: number[] = []
    const coordinator = createCoordinator({
        repository: {
            upsertSnapshot: async () => {
                snapshots.push(1)
            }
        },
        recallIntervalMessages: 10
    })

    // 首启无锚点：立即召回
    await coordinator.queue(coordinator.rules, scope, chatHistory, 100)
    await waitFor(() => snapshots.length === 1, 'first immediate recall')

    // 间隔不足：跳过
    await coordinator.queue(coordinator.rules, scope, chatHistory, 105)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(snapshots.length, 1)

    // 达到间隔：再次执行并前移锚点
    await coordinator.queue(coordinator.rules, scope, chatHistory, 110)
    await waitFor(() => snapshots.length === 2, 'second recall after gap')

    // 锚点已前移到 110：新一轮间隔从上次执行点重新计
    await coordinator.queue(coordinator.rules, scope, chatHistory, 115)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(snapshots.length, 2)
})

it('counts chat messages rather than sparse history positions for recall intervals', async () => {
    const positions = [100]
    let snapshots = 0
    const coordinator = createCoordinator({
        positions: () => positions,
        recallIntervalMessages: 2,
        repository: { upsertSnapshot: async () => { snapshots += 1 } }
    })

    await coordinator.queue(coordinator.rules, scope, chatHistory, 100)
    await waitFor(() => snapshots === 1, 'first recall at position 100')
    await new Promise<void>((resolve) => setImmediate(resolve))

    // 中间的 899 个日志位置可以属于工具与标记；这里只多了一条聊天。
    positions.push(1000)
    await coordinator.queue(coordinator.rules, scope, chatHistory, 1000)
    assert.equal(snapshots, 1)

    positions.push(1500)
    await coordinator.queue(coordinator.rules, scope, chatHistory, 1500)
    await waitFor(() => snapshots === 2, 'recall after two actual chats')
    await new Promise<void>((resolve) => setImmediate(resolve))

    positions.push(3000)
    await coordinator.queue(coordinator.rules, scope, chatHistory, 3000)
    assert.equal(snapshots, 2, 'the next interval starts at the last recalled chat')
    await coordinator.stop()
})

it('starts a new recall interval on every preset switch including switching back', async () => {
    let snapshots = 0
    const coordinator = createCoordinator({
        positions: () => [100],
        recallIntervalMessages: 10,
        repository: { upsertSnapshot: async () => { snapshots += 1 } }
    })
    const presetB = { ...scope, presetId: 'preset-b' }

    for (const [index, active] of [scope, presetB, scope].entries()) {
        coordinator.clearByConversation(scope.conversationId)
        await coordinator.queue(coordinator.rules, active, chatHistory, 100)
        await waitFor(() => snapshots === index + 1, 'first recall after preset change')
        await new Promise<void>((resolve) => setImmediate(resolve))
    }

    await coordinator.queue(coordinator.rules, scope, chatHistory, 100)
    assert.equal(snapshots, 3, 'unchanged scope still obeys its current interval')
    await coordinator.stop()
})

it('cancels an in-flight recall without recording a failed job', async () => {
    const jobStore = createJobStore()
    let signalSeen: AbortSignal | undefined
    const coordinator = createCoordinator({
        repository: { createFailedJob: jobStore.createFailedJob },
        run: async (_history, _logger, signal) => {
            signalSeen = signal
            await new Promise((resolve, reject) =>
                signal!.addEventListener('abort', () => reject(signal!.reason), {
                    once: true
                })
            )
            return createSnapshotItem('记得')
        }
    })
    // 先让运行器拿到取消信号：队列在下一轮事件循环才启动运行。
    const queued = coordinator.queue(coordinator.rules, scope, chatHistory, 100)
    await waitFor(() => signalSeen !== undefined, 'recall running')
    void queued

    await coordinator.stop()
    assert.deepEqual(jobStore.jobs, [])

    // 停止后不再接收新触发
    await coordinator.queue(coordinator.rules, scope, chatHistory, 100)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(jobStore.jobs, [])
})
