import type { MemoryVectorIndexState } from '../../contracts/vector_index.ts'

export type LivingMemoryVectorIndexErrorCode =
    | 'embedding-unavailable'
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

/** 写入已提交而索引同步失败时，工具应返回成功和警告，避免模型重复写入。 */
export async function withIndexWarning<T>(write: Promise<T>, warnings: string[], action: string) {
    try {
        return await write
    } catch (error) {
        if (!(error instanceof LivingMemoryFactsCommittedError)) throw error
        warnings.push(`记忆已${action}，但向量索引同步失败，已调度后台自动对账：${error.message}`)
    }
}
