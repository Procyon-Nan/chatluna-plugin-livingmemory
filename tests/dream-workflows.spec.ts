import assert from 'node:assert/strict'
import type { Context } from 'cordis'
import type { ChatBlock, ChatSpecMessage, ChatToolCallBlock } from '@chatluna/message'
import type { DreamRunResult } from '../src/service/workflows/dream/types.ts'
import { LivingMemoryDreamService } from '../src/service/workflows/dream/service.ts'
import { LivingMemoryDreamCoordinator } from '../src/service/workflows/dream/coordinator.ts'
import { LivingMemoryDreamJobRunner } from '../src/service/workflows/dream/job_runner.ts'
import { LivingMemoryJobTracker } from '../src/service/workflows/job_tracker.ts'
import { LivingMemoryMutationService } from '../src/service/app/mutation_service.ts'
import { bisectDreamMemories } from '../src/service/workflows/dream/semantic/bisect.ts'
import { createMemoryContentHash } from '../src/service/vector_index/hashes.ts'
import { withLivingMemoryRepository } from './persistence-test-utils.ts'
import {
    createDreamRunResult,
    createJobStore,
    logger,
    scope,
    waitFor
} from './workflow-test-utils.ts'

interface ChatRequest {
    model?: string
    system?: string
    messages: readonly ChatSpecMessage[]
    toolSpecs?: readonly { name?: string }[]
}

interface ChatFold {
    content: readonly ChatBlock[]
    text: string
    toolCalls: readonly ChatToolCallBlock[]
}

const toolCallFold = (name: string, input: unknown): ChatFold => {
    const block: ChatToolCallBlock = {
        type: 'tool-call',
        toolCallId: `call-${name}-${Math.random().toString(36).slice(2, 8)}` as never,
        toolName: name,
        input: input as never
    }
    return { content: [block], text: '', toolCalls: [block] }
}

const textFold = (text: string): ChatFold => ({
    content: [{ type: 'text', text }],
    text,
    toolCalls: []
})

const runService = async (
    respond: (request: ChatRequest, round: number) => ChatFold,
    options: {
        mainModel?: string
        signal?: AbortSignal
        postExtraction?: boolean
        profileUsers?: string[]
    } = {}
) => {
    let outcome!: {
        result: DreamRunResult
        rounds: number
        profileCalls: string[][]
    }
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const entries = await Promise.all(
            Array.from({ length: 31 }, (_, i) =>
                repository.createMemory(
                    scope,
                    {
                        type: 'fact' as const,
                        content: `正文 ${i}`,
                        summary: `摘要 ${i}`,
                        keywords: ['共同主题'],
                        sentiment: '平静',
                        importance: 0.5
                    },
                    []
                )
            )
        )
        const profileCalls: string[][] = []
        if (options.profileUsers) {
            await repository.updateMemory(entries[0].id, {
                speakerKeys: options.profileUsers
            })
        }
        let rounds = 0
        const ctx = {
            chatluna: {
                chat: async (request: ChatRequest) => respond(request, ++rounds)
            },
            ai: {
                caps: async () => ({ contextWindow: 1_000_000 })
            }
        } as unknown as Context
        const mutations = new LivingMemoryMutationService(
            repository,
            {
                assertPresetReady: () => {},
                waitForMaintenance: async () => {},
                applyMutation: async () => {},
                clearPreset: async () => {},
                reconcilePreset: async () => {
                    throw new Error('unexpected reconcile')
                }
            },
            logger
        )
        const persona = { resolveOrGenerateCardText: async () => '测试人设' }
        const service = new LivingMemoryDreamService(
            ctx,
            { mainModel: options.mainModel ?? 'test' },
            repository as never,
            mutations,
            {
                queryDreamNeighbors: async () => ({
                    generation: 'test',
                    available: false,
                    completed: 0,
                    reason: 'index-absent',
                    rows: []
                }),
                readVectorSnapshot: async (_presetId, ids) => ({
                    embeddingModelId: 'test',
                    dimension: 2,
                    generation: 'test',
                    missingMemoryIds: [],
                    items: ids.map((id) => ({
                        memoryId: id,
                        status: 'active',
                        contentHash: createMemoryContentHash(
                            entries.find((entry) => entry.id === id)!.content
                        ),
                        vector: new Float32Array([1, 0])
                    }))
                })
            },
            {
                refine: async () => {
                    throw new Error('initial batching uses bisect')
                },
                bisect: async (input) => bisectDreamMemories(input)
            },
            (_presetId, _mode, keys) => {
                if (options.profileUsers) profileCalls.push(keys!)
            },
            persona,
            { searchMemoriesDetailed: async () => [] }
        )
        const result = await service.run(
            scope.presetId,
            'job-test',
            logger,
            options.signal,
            options.postExtraction
                ? { mode: 'post-extraction', memoryIds: [entries[0].id] }
                : { mode: 'full' }
        )
        outcome = { result, rounds, profileCalls }
    })
    return outcome
}

/** 当前批次里的记忆 ID：取最后一条 `<dream_input>` 用户消息。 */
const currentIds = (request: ChatRequest) => {
    const batch = [...request.messages].reverse().find(
        (message) =>
            message.role === 'user' &&
            message.content.some(
                (block) =>
                    block.type === 'text' &&
                    block.text.startsWith('<dream_input>')
            )
    )!
    const text = batch.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('')
    return [...text.matchAll(/^id=(.+)$/gm)].map((match) => match[1])
}

const checked = (ids: string[]) =>
    toolCallFold('living_memory_checked_memory', {
        memoryIds: ids,
        reason: '内容准确且无需改动'
    })

it('runs the production Dream service through real tools across batches and records coverage', async () => {
    const batchSizes: number[] = []
    const { result } = await runService((request) => {
        const ids = currentIds(request)
        batchSizes.push(ids.length)
        assert.equal(request.model, 'test')
        return checked(ids)
    })
    assert.equal(result.status, 'completed')
    assert.equal(result.entryCount, 31)
    assert.equal(result.processedCount, 31)
    assert.equal(batchSizes.length, 2)
    assert.ok(batchSizes.every((size) => size <= 30))
})

it('keeps successful operations and proceeds past an ineffective batch as partial', async () => {
    let firstId = ''
    const { result } = await runService((request, round) => {
        if (round === 1) {
            firstId = currentIds(request)[0]
            return checked([firstId])
        }
        return textFold('没有工具操作')
    })
    assert.equal(result.status, 'partial')
    assert.equal(result.processedCount, 1)
    assert.equal(result.unprocessedMemoryIds.length, 30)
    assert.equal(result.skippedBatches.length, 2)
    assert.match(result.detail, /连续 3 轮/)
})

it('retains completed operations and missing IDs when the session fatally fails', async () => {
    const controller = new AbortController()
    const { result } = await runService(
        (request, round) => {
            if (round === 1) return checked([currentIds(request)[0]])
            controller.abort(new Error('session aborted'))
            return textFold('')
        },
        { signal: controller.signal }
    )
    assert.equal(result.status, 'failed')
    assert.equal(result.processedCount, 1)
    assert.equal(result.unprocessedMemoryIds.length, 30)
    assert.match(result.detail, /session aborted/)
})

it('reports missing model configuration as failed with the entire target set', async () => {
    const { result, rounds } = await runService(() => checked([]), {
        mainModel: ''
    })
    assert.equal(result.status, 'failed')
    assert.equal(result.unprocessedMemoryIds.length, 31)
    assert.equal(rounds, 0)
})

it.each(['completed', 'partial', 'failed'] as const)(
    'persists %s outcome and successful-operation details',
    async (status) => {
        const store = createJobStore()
        const job = await store.createJob(scope, 'dream', '')
        const runner = new LivingMemoryDreamJobRunner(
            {
                run: async () => ({
                    ...createDreamRunResult(),
                    status,
                    processedCount: 1,
                    detail: 'checked 1; unprocessed: memory-2'
                })
            },
            new LivingMemoryJobTracker(store),
            logger
        )
        await runner.run(scope, job.id)
        assert.equal(job.status, status)
        assert.match(job.detail!, /checked 1/)
        assert.ok(job.finishedAt)
    }
)

it('serializes starts, recovers stale jobs and aborts and drains running jobs on stop', async () => {
    const store = createJobStore()
    let calls = 0
    let recoveries = 0
    const runner = new LivingMemoryDreamJobRunner(
        {
            run: async (_preset, _id, _logger, signal) => {
                calls++
                await new Promise<void>((resolve) =>
                    signal!.addEventListener('abort', () => resolve(), {
                        once: true
                    })
                )
                signal!.throwIfAborted()
                return createDreamRunResult()
            }
        },
        new LivingMemoryJobTracker(store),
        logger
    )
    const coordinator = new LivingMemoryDreamCoordinator(
        runner,
        {
            ...store,
            countActiveEntries: async () => 30,
            markStaleRunningJobsAsFailed: async () => {
                recoveries++
                return []
            }
        },
        logger
    )
    const [first, second] = await Promise.all([
        coordinator.start(scope.presetId),
        coordinator.start(scope.presetId)
    ])
    assert.equal(first.started, true)
    assert.equal(second.reason, 'preset-locked')
    await waitFor(() => calls === 1, 'running dream')
    assert.equal(recoveries, 1)
    await coordinator.stop()
    assert.equal(store.jobs[0].status, 'failed')
    assert.throws(() => coordinator.start(scope.presetId), /正在停止/)
})

it('cancels one running dream job without stopping the coordinator', async () => {
    const store = createJobStore()
    const runner = new LivingMemoryDreamJobRunner(
        {
            run: async (_preset, _id, _logger, signal) => {
                await new Promise<void>((resolve) =>
                    signal!.addEventListener('abort', () => resolve(), {
                        once: true
                    })
                )
                signal!.throwIfAborted()
                return createDreamRunResult()
            }
        },
        new LivingMemoryJobTracker(store),
        logger
    )
    const coordinator = new LivingMemoryDreamCoordinator(
        runner,
        { ...store, countActiveEntries: async () => 30 },
        logger
    )
    assert.equal((await coordinator.start(scope.presetId)).started, true)
    await waitFor(() => store.jobs[0]?.status === 'running', 'running dream')

    const cancelled = await coordinator.cancelJob(store.jobs[0].id)
    assert.equal(cancelled?.status, 'cancelled')
    assert.match(cancelled?.error ?? '', /Dream 已取消/u)
    assert.ok(cancelled?.finishedAt)

    // 协调器仍在运行：取消只作用于被取消的任务。
    assert.equal((await coordinator.start(scope.presetId)).started, true)
    await coordinator.stop()
})

it('records a dream interrupted by coordinator stop as failed, not cancelled', async () => {
    const store = createJobStore()
    const runner = new LivingMemoryDreamJobRunner(
        {
            run: async (_preset, _id, _logger, signal) => {
                await new Promise<void>((resolve) =>
                    signal!.addEventListener('abort', () => resolve(), {
                        once: true
                    })
                )
                signal!.throwIfAborted()
                return createDreamRunResult()
            }
        },
        new LivingMemoryJobTracker(store),
        logger
    )
    const coordinator = new LivingMemoryDreamCoordinator(
        runner,
        { ...store, countActiveEntries: async () => 30 },
        logger
    )
    await coordinator.start(scope.presetId)
    await waitFor(() => store.jobs[0]?.status === 'running', 'running dream')

    await coordinator.stop()
    assert.equal(store.jobs[0].status, 'failed')
    assert.match(store.jobs[0].error ?? '', /Dream 服务正在停止/u)
})

it('refuses to cancel a dream job it does not own or that already finished', async () => {
    const store = createJobStore()
    const coordinator = new LivingMemoryDreamCoordinator(
        new LivingMemoryDreamJobRunner(
            { run: async () => createDreamRunResult() },
            new LivingMemoryJobTracker(store),
            logger
        ),
        { ...store, countActiveEntries: async () => 30 },
        logger
    )
    assert.equal(await coordinator.cancelJob('missing'), undefined)

    await coordinator.start(scope.presetId)
    await waitFor(
        () => store.jobs[0]?.status === 'completed',
        'finished dream'
    )
    assert.equal(await coordinator.cancelJob(store.jobs[0].id), undefined)
    await coordinator.stop()
})

it('does not start below 30 active memories and releases the starting lock after skipping', async () => {
    const store = createJobStore()
    let count = 29
    const coordinator = new LivingMemoryDreamCoordinator(
        { run: async () => {} },
        {
            ...store,
            countActiveEntries: async () => count
        },
        logger
    )
    assert.equal(
        (await coordinator.start(scope.presetId)).reason,
        'insufficient-memories'
    )
    assert.equal(store.jobs.length, 0)
    count = 30
    assert.equal((await coordinator.start(scope.presetId)).started, true)
    await coordinator.stop()
})

it('skips the model session for a singleton post-extraction group', async () => {
    const outcome = await runService(
        () => {
            throw new Error('singleton should not request a decision')
        },
        { postExtraction: true }
    )
    assert.equal(outcome.rounds, 0)
    assert.equal(outcome.result.status, 'completed')
    assert.equal(outcome.result.batchCount, 0)
    assert.equal(outcome.result.untouchedSeedIds.length, 1)
})

it('triggers singleton seed profiles after skipping the Dream decision session', async () => {
    const outcome = await runService(
        () => {
            throw new Error('singleton should not request a decision')
        },
        { postExtraction: true, profileUsers: ['seed-user'] }
    )
    assert.equal(outcome.rounds, 0)
    assert.equal(outcome.result.status, 'completed')
    assert.deepEqual(outcome.profileCalls, [['seed-user']])
})