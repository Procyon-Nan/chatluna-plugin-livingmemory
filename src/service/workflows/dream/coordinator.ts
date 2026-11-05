import type { LivingMemoryDreamJobRunner } from './job_runner.ts'
import type { LivingMemoryLogger } from '../../logging/logger.ts'
import type {
    DreamTriggerResult,
    JobRepository
} from '../../../contracts/workflows.ts'
import type {
    MemoryJobRecord,
    MemoryScope
} from '../../../contracts/memory.ts'
import { SerialTaskQueue } from '../../shared/serial_task_queue.ts'
import {
    DreamJobCancelledError,
    type DreamRunInput
} from './types.ts'

const DREAM_MIN_ACTIVE_MEMORY_COUNT = 30

export type DreamCoordinatorRepository = Pick<
    JobRepository,
    'createJob' | 'getJob' | 'markStaleRunningJobsAsFailed'
> & {
    countActiveEntries(presetId: string): Promise<number>
}

export class LivingMemoryDreamCoordinator {
    private readonly queue = new SerialTaskQueue()
    private readonly pendingByPreset = new Map<string, number>()
    private readonly runningJobs = new Map<string, string>()
    /**
     * 每个任务自己的中止信号：取消只中止该次运行。协调器停止时由
     * `controller` 统一中止全部任务。
     */
    private readonly jobSignals = new Map<string, AbortController>()
    /** 任务收尾完成；取消方据此等待任务行落到终态再返回。 */
    private readonly jobCompletions = new Map<string, Promise<void>>()
    private readonly controller = new AbortController()
    private readonly tasks = new Set<Promise<void>>()

    constructor(
        private readonly jobRunner: Pick<LivingMemoryDreamJobRunner, 'run'>,
        private readonly repository: DreamCoordinatorRepository,
        private readonly logger: LivingMemoryLogger
    ) {}

    start(presetId: string): Promise<DreamTriggerResult> {
        this.controller.signal.throwIfAborted()
        if (this.pendingByPreset.has(presetId)) {
            return Promise.resolve({
                success: true,
                started: false,
                reason: 'preset-locked',
                runningJobId: this.runningJobs.get(presetId)
            })
        }
        let task!: Promise<void>
        const started = new Promise<DreamTriggerResult>((resolve, reject) => {
            task = this.enqueue(presetId, async () => {
                try {
                    this.controller.signal.throwIfAborted()
                    const count =
                        await this.repository.countActiveEntries(presetId)
                    if (count < DREAM_MIN_ACTIVE_MEMORY_COUNT) {
                        resolve({
                            success: true,
                            started: false,
                            reason: 'insufficient-memories'
                        })
                        return
                    }
                    await this.runJob(presetId, { mode: 'full' }, () =>
                        resolve({ success: true, started: true })
                    )
                } catch (error) {
                    reject(error)
                    throw error
                }
            })
        })
        return started.then(
            async (result) => {
                if (!result.started) await task
                return result
            },
            async (error) => {
                await task
                throw error
            }
        )
    }

    queueAfterExtraction(presetId: string, memoryIds: string[]) {
        if (this.controller.signal.aborted) return
        void this.enqueue(presetId, async () => {
            if (this.controller.signal.aborted) return
            await this.runJob(presetId, { mode: 'post-extraction', memoryIds })
        })
    }

    private enqueue(presetId: string, run: () => Promise<void>) {
        this.pendingByPreset.set(
            presetId,
            (this.pendingByPreset.get(presetId) ?? 0) + 1
        )
        const task = this.queue
            .run(presetId, async () => {
                try {
                    await run()
                } finally {
                    // 预设锁覆盖整个运行：任务结算后才允许下一次启动，
                    // 取消方等待任务结算时也能看到锁已释放。
                    const remaining = this.pendingByPreset.get(presetId)! - 1
                    if (remaining === 0) this.pendingByPreset.delete(presetId)
                    else this.pendingByPreset.set(presetId, remaining)
                }
            })
            .catch((error) => {
                this.logger.summary(
                    'Dream 任务执行失败',
                    `预设：${presetId}`,
                    'error',
                    error
                )
            })
            .finally(() => {
                this.tasks.delete(task)
            })
        this.tasks.add(task)
        return task
    }

    private async runJob(
        presetId: string,
        input: DreamRunInput,
        onStarted?: () => void
    ) {
        const signal = this.controller.signal
        signal.throwIfAborted()
        const recovered = await this.repository.markStaleRunningJobsAsFailed(
            { presetId, kind: 'dream' },
            'dream recovered: stale running job'
        )
        if (recovered.length > 0) {
            this.logger.diagnosticSummary(() => ({
                event: 'Dream 中断任务状态恢复完成',
                detail: `预设：${presetId}; 标记失败：${recovered.length} 个任务`
            }))
        }
        signal.throwIfAborted()
        const trigger = input.mode === 'full' ? 'manual' : 'post-extraction'
        const scope: MemoryScope = {
            conversationId: `dream:${trigger}:${presetId}`,
            presetId
        }
        const job = await this.repository.createJob(
            scope,
            'dream',
            `${trigger}:${presetId}`
        )
        this.runningJobs.set(presetId, job.id)
        const jobController = new AbortController()
        this.jobSignals.set(job.id, jobController)
        // 协调器停止时，在途任务随主信号一起中止。
        const stopJob = () =>
            jobController.abort(this.controller.signal.reason)
        this.controller.signal.addEventListener('abort', stopJob, {
            once: true
        })
        onStarted?.()
        const combinedSignal = AbortSignal.any([
            this.controller.signal,
            jobController.signal
        ])
        const completion = this.jobRunner
            .run(scope, job.id, combinedSignal, input)
            .finally(() => {
                this.jobCompletions.delete(job.id)
            })
        this.jobCompletions.set(job.id, completion.then(() => undefined))
        try {
            await completion
        } finally {
            this.controller.signal.removeEventListener('abort', stopJob)
            this.jobSignals.delete(job.id)
            this.runningJobs.delete(presetId)
        }
    }

    /**
     * 取消指定 Dream 任务：中止信号只作用于该任务的运行，不停止协调器本身。
     *
     * 终态由任务运行器的取消分支写入，等在途运行结算后再读取任务行返回。运行
     * 在取消到达前已结束的，返回的是完成态——取消方据此如实报告结果。
     *
     * 返回取消后的任务行；任务不存在、已结束或没有在途执行时返回 undefined。
     */
    async cancelJob(jobId: string): Promise<MemoryJobRecord | undefined> {
        // 先读任务行：运行器结算与信号清理之间仍有窗口，以终态记录为准。
        const job = await this.repository.getJob(jobId)
        if (
            job === undefined ||
            (job.status !== 'pending' && job.status !== 'running')
        ) {
            return undefined
        }
        const controller = this.jobSignals.get(jobId)
        if (controller === undefined) return undefined
        controller.abort(new DreamJobCancelledError('Dream 任务已取消。'))
        await this.jobCompletions.get(jobId)
        // 等该预设的队列释放：取消返回时应能立刻再次启动同一预设的任务。
        await this.queue.wait(job.presetId)
        return await this.repository.getJob(jobId)
    }

    async stop() {
        this.controller.abort(new Error('Dream 服务正在停止。'))
        await Promise.allSettled([...this.tasks])
    }
}
