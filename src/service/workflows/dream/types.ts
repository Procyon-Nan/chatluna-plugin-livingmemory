import type { DreamMemoryEntryRecord } from '../../../contracts/workflows.ts'

export interface DreamBatch {
    id: string
    seedMemoryId?: string
    entries: DreamMemoryEntryRecord[]
}

export type DreamRunInput =
    | { mode: 'full' }
    | { mode: 'post-extraction'; memoryIds: string[] }

/**
 * 用户显式取消一次 Dream 运行的中止原因。
 *
 * 协调器停止也用 `abort` 结束在途任务，但那是服务生命周期中断，任务记录按
 * 失败收尾（与 v1 的停止语义、原生 `interrupted by restart` 一致）；只有带这个
 * 原因的中止才记 `cancelled`。用原因类型区分两种中止，运行器不必猜。
 */
export class DreamJobCancelledError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'DreamJobCancelledError'
    }
}

export interface DreamOperationStats {
    kept: number
    merged: number
    split: number
    updated: number
    archived: number
}

export interface DreamRunResult extends DreamOperationStats {
    untouchedSeedIds: string[]
    skipped: number
    entryCount: number
    batchCount: number
    status: 'completed' | 'partial' | 'failed'
    processedCount: number
    unprocessedMemoryIds: string[]
    skippedBatches: { batchId: string; memoryIds: string[]; reason: string }[]
    error?: string
    detail: string
}
