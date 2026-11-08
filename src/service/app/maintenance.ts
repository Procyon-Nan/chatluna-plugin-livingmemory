import type { Context } from 'cordis'
import type {} from '@cordisjs/plugin-timer'
import type { LivingMemoryRepository } from '../persistence/repository.ts'
import type { LivingMemoryMutationService } from './mutation_service.ts'
import type { LivingMemoryLogger } from '../logging/logger.ts'

const DAY_MS = 86_400_000
const JOB_RETENTION_MS = 7 * DAY_MS

export const LIVING_MEMORY_MAINTENANCE_INTERVAL = DAY_MS

export interface LivingMemoryMaintenanceDeps {
    repository: LivingMemoryRepository
    mutations: LivingMemoryMutationService
    logger: LivingMemoryLogger
}

/** 启动时回收中断任务，定期清理到期任务和归档记忆。 */
export class LivingMemoryMaintenance {
    /** 归档清理串行执行，启动清理与定时清理不会同时扫同一预设。 */
    private cleanup: Promise<void> = Promise.resolve()

    constructor(
        private readonly ctx: Context,
        private readonly deps: LivingMemoryMaintenanceDeps
    ) {}

    /** 每日维护。宿主未装定时器服务时返回的注销函数为空操作。 */
    schedule(): () => void {
        const timer = this.ctx.get('timer')
        if (timer === undefined) return () => {}
        return timer.interval(() => {
            this.pruneExpiredJobs()
            this.queueArchivedCleanup('scheduled')
        }, LIVING_MEMORY_MAINTENANCE_INTERVAL)
    }

    /** 索引就绪后执行的启动清理；调用方需在其后 await `settled()`。 */
    queueStartupArchivedCleanup(): void {
        this.queueArchivedCleanup('startup')
    }

    settled(): Promise<void> {
        return this.cleanup
    }

    /** 清理一周前的任务审计行；定时维护与启动维护共用。 */
    async pruneExpiredJobs() {
        try {
            await this.deps.repository.removeExpiredJobs(
                new Date(Date.now() - JOB_RETENTION_MS)
            )
        } catch (error) {
            this.deps.logger.summary('过期任务清理失败', '触发方式：定时维护', 'warn', error)
        }
    }

    /**
     * 回收进程中断遗留的 `pending`/`running` 任务行。Dream 协调器按预设在
     * 每次运行前回收自己的行，这里覆盖其余类型；任务表是审计日志，不参与调度。
     */
    async recoverInterruptedJobs() {
        try {
            const recovered = await this.deps.repository.markStaleRunningJobsAsFailed(
                {},
                '服务重启时任务尚未完成。'
            )
            if (recovered.length > 0) {
                this.deps.logger.summary(
                    '中断任务状态恢复完成',
                    `标记失败：${recovered.length} 个任务`
                )
            }
        } catch (error) {
            this.deps.logger.summary(
                '中断任务恢复失败',
                '触发方式：启动维护',
                'warn',
                error
            )
        }
    }

    private queueArchivedCleanup(trigger: 'startup' | 'scheduled') {
        this.cleanup = this.cleanup.then(() =>
            this.cleanupExpiredArchivedMemories(trigger)
        )
    }

    private async cleanupExpiredArchivedMemories(
        trigger: 'startup' | 'scheduled'
    ) {
        try {
            const presetIds = await this.deps.repository.listEntryPresetIds()
            const now = new Date()
            let deleted = 0
            for (const presetId of presetIds) {
                const result =
                    await this.deps.mutations.deleteExpiredArchivedMemories(
                        presetId,
                        now
                    )
                deleted += result.deleted
            }
            if (deleted > 0) {
                this.deps.logger.summary(
                    '过期归档记忆清理完成',
                    `删除记忆：${deleted} 条`
                )
            }
        } catch (error) {
            this.deps.logger.summary(
                '过期归档记忆清理失败',
                `触发方式：${trigger === 'startup' ? '启动维护' : '定时维护'}`,
                'warn',
                error
            )
        }
    }
}
