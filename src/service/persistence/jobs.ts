import { randomUUID } from 'node:crypto'
import type { Context } from 'cordis'
import type {
    MemoryJobKind,
    MemoryJobRecord,
    MemoryScope
} from '../../contracts/memory.ts'
import type { JobRepository } from '../../contracts/workflows.ts'
import { formatErrorDetails } from '../shared/utils.ts'

export class LivingMemoryJobRepository implements JobRepository {
    private readonly watchers = new Set<(job: MemoryJobRecord) => void>()

    constructor(private readonly ctx: Context) {}

    /** 驱动就绪后才有 `database` 服务；仓储实例只在驱动加载后创建。 */
    private get database() {
        return this.ctx.get('database')!
    }

    async createJob(
        scope: MemoryScope,
        kind: MemoryJobKind,
        input: string
    ): Promise<MemoryJobRecord> {
        const now = new Date()
        return this.createJobRecord(scope, kind, input, {
            status: 'pending',
            error: null,
            createdAt: now,
            startedAt: null,
            finishedAt: null,
            updatedAt: now
        })
    }

    async createFailedJob(
        scope: MemoryScope,
        kind: MemoryJobKind,
        input: string,
        error: unknown,
        startedAt: Date
    ): Promise<MemoryJobRecord> {
        const finishedAt = new Date()
        return this.createJobRecord(scope, kind, input, {
            status: 'failed',
            error: formatErrorDetails(error),
            createdAt: startedAt,
            startedAt,
            finishedAt,
            updatedAt: finishedAt
        })
    }

    private async createJobRecord(
        scope: MemoryScope,
        kind: MemoryJobKind,
        input: string,
        state: {
            status: MemoryJobRecord['status']
            error: string | null
            createdAt: Date
            startedAt: Date | null
            finishedAt: Date | null
            updatedAt: Date
        }
    ): Promise<MemoryJobRecord> {
        const job: MemoryJobRecord = {
            id: randomUUID(),
            presetId: scope.presetId,
            conversationId: scope.conversationId,
            kind,
            input,
            detail: null,
            ...state
        }

        await this.database.create('living_memory_job', job)
        this.notify(job)
        return job
    }

    async updateJob(
        id: string,
        patch: Partial<MemoryJobRecord>
    ): Promise<void> {
        await this.database.set('living_memory_job', { id }, patch)
        // 进度写入按批发生：没有订阅方时不回读整行。
        if (this.watchers.size === 0) return
        const job = await this.getJob(id)
        if (job !== undefined) this.notify(job)
    }

    async listJobsByPreset(presetId: string): Promise<MemoryJobRecord[]> {
        const jobs = await this.database.get('living_memory_job', {
            presetId
        })

        return jobs.sort((left, right) => +right.createdAt - +left.createdAt)
    }

    private async getJob(id: string): Promise<MemoryJobRecord | undefined> {
        const [job] = await this.database.get('living_memory_job', { id })
        return job
    }

    /** 订阅本插件仓储的任务状态变更。 */
    watchJobs(listener: (job: MemoryJobRecord) => void): () => void {
        this.watchers.add(listener)
        return () => {
            this.watchers.delete(listener)
        }
    }

    private notify(job: MemoryJobRecord) {
        for (const watcher of this.watchers) watcher(job)
    }

    async markStaleRunningJobsAsFailed(
        options: { presetId?: string; kind?: MemoryJobKind } = {},
        reason = '上次任务未完成。'
    ): Promise<MemoryJobRecord[]> {
        // 同时回收 pending 与 running：作业表为审计日志，不参与调度。
        // 若进程在 createJob（写入 pending）之后、markRunning 之前被终止，
        // 该行会永久卡在 pending，仅扫 running 无法清理，遗留幽灵审计记录。
        const query: Record<string, unknown> = {
            status: { $in: ['pending', 'running'] }
        }
        if (options.presetId != null) {
            query.presetId = options.presetId
        }
        if (options.kind != null) {
            query.kind = options.kind
        }

        const stale = await this.database.get('living_memory_job', query)
        if (stale.length === 0) {
            return []
        }

        const now = new Date()
        await this.database.set(
            'living_memory_job',
            { id: { $in: stale.map((job) => job.id) } },
            {
                status: 'failed',
                detail: reason,
                error: reason,
                finishedAt: now,
                updatedAt: now
            }
        )

        return stale
    }

    async removeExpiredJobs(deadline: Date) {
        await this.database.remove('living_memory_job', {
            updatedAt: {
                $lt: deadline
            }
        })
    }
}
