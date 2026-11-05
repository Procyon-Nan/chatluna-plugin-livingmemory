import type { MemoryJob } from '@chatluna/memory'
import type { MemoryJobRecord } from '../../contracts/memory.ts'
import type { JobRepository } from '../../contracts/workflows.ts'
import type { LivingMemoryLogger } from '../logging/logger.ts'
import { toNativeJob } from './job_view.ts'

export interface LivingMemoryJobSurfaceOptions {
    repository: Pick<JobRepository, 'listJobsByPreset' | 'getJob' | 'watchJobs'>
    /**
     * 取消任务并返回终态记录。Dream 由协调器中止在途运行；其余任务没有逐任务
     * 信号，直接把审计行置为取消态。
     */
    cancelJob(jobId: string): Promise<MemoryJobRecord | undefined>
    logger: LivingMemoryLogger
}

/**
 * 后端任务面（M01-C2、M01-C3）。
 *
 * 框架把后端任务并入原生任务视图需要三件事：按预设列出、按 ID 取消、状态变化
 * 通知。形状见 `doc/framework-requirements.md` 第 5、6 项；落地后由框架在
 * `listJobs` 与 `chatluna/memory-job` 上合并。任务状态仍由迁移保留的审计表持有，
 * 这里只做投影与路由，不引入第二份状态。
 */
export class LivingMemoryJobSurface {
    constructor(private readonly options: LivingMemoryJobSurfaceOptions) {}

    /** 按预设列出任务，形状为原生 `MemoryJob`。 */
    async list(presetId: string): Promise<MemoryJob[]> {
        const records = await this.options.repository.listJobsByPreset(presetId)
        return records.map(toNativeJob)
    }

    async get(jobId: string): Promise<MemoryJob | undefined> {
        const record = await this.options.repository.getJob(jobId)
        return record === undefined ? undefined : toNativeJob(record)
    }

    /** 取消任务；不存在或已结束时返回 undefined。 */
    async cancel(jobId: string): Promise<MemoryJob | undefined> {
        const cancelled = await this.options.cancelJob(jobId)
        if (cancelled === undefined) return undefined
        this.options.logger.diagnosticSummary(() => ({
            event: '任务已取消',
            detail: `预设：${cancelled.presetId}; 任务：${jobId}`
        }))
        return toNativeJob(cancelled)
    }

    /** 订阅任务行变化；服务启动时把它接成 `chatluna/memory-job`。 */
    watch(listener: (job: MemoryJob) => void): () => void {
        return this.options.repository.watchJobs((record) =>
            listener(toNativeJob(record))
        )
    }
}