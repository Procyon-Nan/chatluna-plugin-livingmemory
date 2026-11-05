import type { JobRepository } from '../../contracts/workflows.ts'
import { formatErrorDetails } from '../shared/utils.ts'

export type JobTrackerRepository = Pick<JobRepository, 'updateJob'>

export class LivingMemoryJobTracker {
    constructor(private readonly repository: JobTrackerRepository) {}

    async markRunning(id: string) {
        await this.repository.updateJob(id, {
            status: 'running',
            startedAt: new Date(),
            updatedAt: new Date()
        })
    }

    async markCompleted(
        id: string,
        detail: string,
        status: 'completed' | 'partial' = 'completed'
    ) {
        await this.repository.updateJob(id, {
            status,
            finishedAt: new Date(),
            updatedAt: new Date(),
            detail
        })
    }

    async markFailed(id: string, error: unknown, detail: string | null) {
        await this.repository.updateJob(id, {
            status: 'failed',
            finishedAt: new Date(),
            updatedAt: new Date(),
            detail,
            error: formatErrorDetails(error)
        })
    }

    /** 任务被取消：保留已产生的 detail，错误列写明取消原因。 */
    async markCancelled(id: string, reason: string) {
        await this.repository.updateJob(id, {
            status: 'cancelled',
            finishedAt: new Date(),
            updatedAt: new Date(),
            error: reason
        })
    }
}
