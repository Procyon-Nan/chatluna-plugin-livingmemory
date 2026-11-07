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
    currentMessage,
    logger,
    scope as baseScope,
    waitFor
} from './workflow-test-utils.ts'

const scope = { ...baseScope, sessionId: 'session-1' }

type AgenticRun = (
    historyMessages: LivingMemoryTranscriptMessage[],
    runLogger: LivingMemoryLogger,
    signal?: AbortSignal
) => Promise<AgenticMemorySnapshotItem | null>

const defaultRun: AgenticRun = async () => createSnapshotItem('记得')

const createCoordinator = (options: {
    repository?: Partial<RecallWorkflowRepository>
    run?: AgenticRun
    tailSeq?: () => number
    positions?: () => number[]
    recallIntervalMessages?: number
    subModel?: string
    logger?: LivingMemoryLogger
}) => {
    const run = options.run ?? defaultRun
    return Object.assign(new LivingMemoryRecallCoordinator(
        options.subModel ?? 'test/sub-model',
        {
            head: async () => options.tailSeq?.() ?? 100,
            after: async (_scope, after, before = Infinity) => {
                const positions = options.positions?.() ?? Array.from({ length: options.tailSeq?.() ?? 100 }, (_, index) => index + 1)
                return positions.filter((position) => position > after && position < before).map((position) => ({
                    position, messageId: String(position), platform: 'onebot', content: 'chat',
                    timestamp: 1_000, role: 'user' as const, backfilled: false
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
                _message,
                historyMessages,
                _snapshotLines,
                saveSnapshot,
                runLogger: LivingMemoryLogger,
                signal?: AbortSignal
            ) => {
                const snapshot = await run(historyMessages, runLogger, signal)
                if (snapshot !== null) await saveSnapshot(snapshot)
                return snapshot
            }
        },
        options.logger ?? logger
    ), { rules: { recallIntervalMessages: options.recallIntervalMessages ?? 1, snapshotMaxLines: 5, enableConversationIsolation: false } })
}

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

    await coordinator.queue(coordinator.rules, scope, currentMessage, async () => [])
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

    await coordinator.queue(coordinator.rules, scope, currentMessage, async () => [])
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

it('skips recall without persisting a job when the current message is empty', async () => {
    const jobStore = createJobStore()
    let runCalls = 0
    const coordinator = createCoordinator({
        repository: { createFailedJob: jobStore.createFailedJob },
        run: async () => {
            runCalls += 1
            return createSnapshotItem('unused')
        }
    })

    await coordinator.queue(coordinator.rules,
        scope,
        { ...currentMessage, contentLines: ['  '] },
        async () => []
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(runCalls, 0)
    assert.equal(jobStore.jobs.length, 0)
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

    await coordinator.queue(coordinator.rules, scope, currentMessage, async () => [])

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
    let tail = 100
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
        tailSeq: () => tail,
        logger: captured.logger
    })

    await coordinator.queue(coordinator.rules, scope, currentMessage, async () => [])
    // 间隔已满足：第二次请求越过间隔检查，只能被运行锁拦下
    tail = 101
    await coordinator.queue(coordinator.rules, scope, currentMessage, async () => [])
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

    await coordinator.queue(coordinator.rules, scope, currentMessage, async () => [])
    await waitFor(() => jobStore.jobs.length === 1, 'failed agentic recall')

    const job = jobStore.jobs[0]
    assert.equal(job?.status, 'failed')
    assert.equal(job?.input, '记忆查询')
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

    await coordinator.queue(coordinator.rules, scope, currentMessage, async () => [])
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

    await coordinator.queue(coordinator.rules, scope, currentMessage, async () => [])
    await waitFor(() => jobStore.jobs.length === 1, 'failed first recall')
    await new Promise((resolve) => setTimeout(resolve, 0))

    // 日志没有新消息：锚点若未清除，这次请求会被间隔拦下
    await coordinator.queue(coordinator.rules, scope, currentMessage, async () => [])
    await waitFor(() => runCalls === 2, 'immediate retry')
})

it('records history loading failure without invoking recall or updating the snapshot', async () => {
    const jobStore = createJobStore()
    let receivedHistory: LivingMemoryTranscriptMessage[] | undefined
    let snapshotWrites = 0
    const captured = createCapturedLogger()
    const coordinator = createCoordinator({
        repository: {
            createFailedJob: jobStore.createFailedJob,
            upsertSnapshot: async () => {
                snapshotWrites += 1
            }
        },
        run: async (historyMessages) => {
            receivedHistory = historyMessages
            return createSnapshotItem('remembered context')
        },
        logger: captured.logger
    })

    await coordinator.queue(coordinator.rules, scope, currentMessage, async () => {
        throw new Error('private history failure detail')
    })
    await waitFor(() => jobStore.jobs.length === 1, 'failed history loading')

    assert.equal(receivedHistory, undefined)
    assert.equal(snapshotWrites, 0)
    assert.equal(jobStore.jobs[0]?.status, 'failed')
})

it('gates recall by message gap since the last executed recall', async () => {
    const snapshots: number[] = []
    let tail = 100
    const coordinator = createCoordinator({
        repository: {
            upsertSnapshot: async () => {
                snapshots.push(1)
            }
        },
        tailSeq: () => tail,
        recallIntervalMessages: 10
    })

    // 首启无锚点：立即召回
    await coordinator.queue(coordinator.rules, scope, currentMessage, async () => [])
    await waitFor(() => snapshots.length === 1, 'first immediate recall')

    // 间隔不足：跳过
    tail = 105
    await coordinator.queue(coordinator.rules, scope, currentMessage, async () => [])
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(snapshots.length, 1)

    // 达到间隔：再次执行并前移锚点
    tail = 110
    await coordinator.queue(coordinator.rules, scope, currentMessage, async () => [])
    await waitFor(() => snapshots.length === 2, 'second recall after gap')

    // 锚点已前移到 110：新一轮间隔从上次执行点重新计
    tail = 115
    await coordinator.queue(coordinator.rules, scope, currentMessage, async () => [])
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(snapshots.length, 2)
})

it('counts chat messages rather than sparse history positions for recall intervals', async () => {
    const positions = [100]
    let snapshots = 0
    const coordinator = createCoordinator({
        tailSeq: () => positions.at(-1)!,
        positions: () => positions,
        recallIntervalMessages: 2,
        repository: { upsertSnapshot: async () => { snapshots += 1 } }
    })

    await coordinator.queue(coordinator.rules, scope, currentMessage, async () => [], 100)
    await waitFor(() => snapshots === 1, 'first recall at position 100')
    await new Promise<void>((resolve) => setImmediate(resolve))

    // 中间的 899 个日志位置可以属于工具与标记；这里只多了一条聊天。
    positions.push(1000)
    await coordinator.queue(coordinator.rules, scope, currentMessage, async () => [], 1000)
    assert.equal(snapshots, 1)

    positions.push(1500)
    await coordinator.queue(coordinator.rules, scope, currentMessage, async () => [], 1500)
    await waitFor(() => snapshots === 2, 'recall after two actual chats')
    await new Promise<void>((resolve) => setImmediate(resolve))

    positions.push(3000)
    await coordinator.queue(coordinator.rules, scope, currentMessage, async () => [], 3000)
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
        await coordinator.queue(coordinator.rules, active, currentMessage, async () => [], 100)
        await waitFor(() => snapshots === index + 1, 'first recall after preset change')
        await new Promise<void>((resolve) => setImmediate(resolve))
    }

    await coordinator.queue(coordinator.rules, scope, currentMessage, async () => [], 100)
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
    const queued = coordinator.queue(coordinator.rules, scope, currentMessage, async () => [])
    await waitFor(() => signalSeen !== undefined, 'recall running')
    void queued

    await coordinator.stop()
    assert.deepEqual(jobStore.jobs, [])

    // 停止后不再接收新触发
    await coordinator.queue(coordinator.rules, scope, currentMessage, async () => [])
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(jobStore.jobs, [])
})
