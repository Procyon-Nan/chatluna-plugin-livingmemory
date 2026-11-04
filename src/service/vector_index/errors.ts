import type { MemoryVectorIndexState } from '../../contracts/vector_index.ts'

export type LivingMemoryVectorIndexErrorCode =
    | 'embedding-unavailable'
    | 'extension-migration-failed'
    | 'lock-conflict'
    | 'lock-unavailable'
    | 'mutation-failed'
    | 'not-ready'
    | 'rebuild-failed'
    | 'reconcile-failed'
    | 'vector-missing'
    | 'worker-unavailable'

export class LivingMemoryVectorIndexError extends Error {
    constructor(
        public readonly code: LivingMemoryVectorIndexErrorCode,
        public readonly state: MemoryVectorIndexState,
        message: string,
        options?: ErrorOptions
    ) {
        super(message, options)
        this.name = 'LivingMemoryVectorIndexError'
    }
}

/**
 * 事实已落库、仅索引同步失败。调用方按「已保存并附带警告」处理，
 * 不重试主数据写入，避免产生重复记忆行。
 */
export class LivingMemoryFactsCommittedError extends Error {
    readonly factsCommitted = true

    constructor(message: string, options: ErrorOptions) {
        super(message, options)
        this.name = 'LivingMemoryFactsCommittedError'
    }
}

