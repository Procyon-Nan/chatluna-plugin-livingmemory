import { randomUUID } from 'node:crypto'
import { isModelConfigured } from '../../shared/utils.ts'
import { normalizeText, scopeKey } from '../../memory/helpers.ts'
import { formatLogScope, type LivingMemoryLogger } from '../../logging/logger.ts'
import { renderSnapshotText } from '../../memory/snapshot/snapshot_text.ts'
import type { LivingMemoryAgenticRecallExecutor } from './agentic_recall.ts'
import type {
    JobRepository,
    LivingMemoryConfig,
    SnapshotRepository
} from '../../../contracts/workflows.ts'
import type { MessageLogRegistry } from '../../transcript/message_log/message_log_registry.ts'
import type {
    LivingMemoryTranscriptMessage,
    MemoryScope
} from '../../../contracts/memory.ts'

type LivingMemoryRecallCoordinatorConfig = Pick<
    LivingMemoryConfig,
    'recallIntervalMessages' | 'subModel'
>

/** 召回间隔锚点所需的消息日志读取面。 */
type RecallMessageLog = Pick<MessageLogRegistry, 'tailSeq'>

type RecallAgenticExecutor = Pick<LivingMemoryAgenticRecallExecutor, 'run'>
export type RecallWorkflowRepository = Pick<JobRepository, 'createFailedJob'> &
    Pick<SnapshotRepository, 'upsertSnapshot' | 'getLatestSnapshotByScope'>

export class LivingMemoryRecallCoordinator {
    private readonly recallLockByConversation = new Set<string>()
    /**
     * 召回窗口锚点：上次实际执行召回时点的日志末序号。间隔按此后累计
     * 进入日志的消息条数（含闲聊）计；锚点只在召回实际执行时前移，
     * 召回失败时清除，使下次触发立即重试。
     */
    private readonly anchorSeqByScope = new Map<string, number>()
    /**
     * 卸载时取消在途召回：停止接收新触发、中止模型调用、等待任务收尾。
     * 召回不写任务行（只在失败时记一条），因此取消不产生额外记录。
     */
    private readonly controller = new AbortController()
    private readonly tasks = new Set<Promise<void>>()

    constructor(
        private readonly config: LivingMemoryRecallCoordinatorConfig,
        private readonly messageLog: RecallMessageLog,
        private readonly repository: RecallWorkflowRepository,
        private readonly agenticRecall: RecallAgenticExecutor,
        private readonly logger: LivingMemoryLogger
    ) {}

    async queue(
        scope: MemoryScope,
        currentMessage: LivingMemoryTranscriptMessage,
        loadHistoryMessages: () => Promise<LivingMemoryTranscriptMessage[]>
    ) {
        if (this.config.recallIntervalMessages === 0) return
        if (this.controller.signal.aborted) return
        if (!isModelConfigured(this.config.subModel)) {
            this.logger.diagnosticSummary(() => ({
                event: '跳过记忆召回',
                detail: `${formatLogScope(scope)}; 原因：召回模型未配置`
            }))
            return
        }

        const lockKey = scopeKey(scope)
        const anchorSeq = this.anchorSeqByScope.get(lockKey)
        if (anchorSeq !== undefined) {
            const tailSeq = this.messageLog.tailSeq(scope.conversationId)
            const messagesSinceRecall =
                tailSeq == null ? 0 : tailSeq - anchorSeq
            if (messagesSinceRecall < this.config.recallIntervalMessages) {
                this.logger.diagnosticSummary(() => ({
                    event: '跳过记忆召回',
                    detail: `${formatLogScope(scope)}; 召回消息阈值：${messagesSinceRecall}/${this.config.recallIntervalMessages} 条`
                }))
                return
            }
        }

        if (this.recallLockByConversation.has(lockKey)) {
            // 同一会话同一预设已有召回在跑，本次请求直接丢弃，不做 coalescing。
            // snapshot 由后续请求基于最新历史消息重新触发追上，最多滞后一轮。
            this.logger.diagnosticSummary(() => ({
                event: '跳过记忆召回',
                detail: `${formatLogScope(scope)}; 原因：当前召回任务运行中`
            }))
            return
        }

        this.anchorSeqByScope.set(
            lockKey,
            this.messageLog.tailSeq(scope.conversationId) ?? 0
        )
        this.recallLockByConversation.add(lockKey)

        const runLogger = this.logger.with({
            ...scope,
            workflow: 'recall',
            runId: randomUUID()
        })
        const task = this.run(
            scope,
            currentMessage,
            loadHistoryMessages,
            runLogger
        )
            .catch((error) => {
                this.anchorSeqByScope.delete(lockKey)
                if (this.controller.signal.aborted) {
                    runLogger.summary(
                        '记忆召回已取消',
                        (fields) => formatLogScope(fields)
                    )
                    return
                }
                runLogger.summary(
                    '记忆召回失败',
                    (fields) => formatLogScope(fields),
                    'warn',
                    error
                )
            })
            .finally(() => {
                this.recallLockByConversation.delete(lockKey)
            })
        this.tasks.add(task)
        void task.finally(() => this.tasks.delete(task))
    }

    /** 停止接收新触发并取消在途召回；卸载时在释放消息池之前等待返回。 */
    async stop() {
        this.controller.abort(new Error('记忆召回服务正在停止。'))
        await Promise.allSettled([...this.tasks])
    }

    clearAll() {
        this.anchorSeqByScope.clear()
    }

    clearByConversation(conversationId: string) {
        for (const key of this.anchorSeqByScope.keys()) {
            if (key.endsWith(`\n${conversationId}`)) {
                this.anchorSeqByScope.delete(key)
            }
        }
    }

    private async run(
        scope: MemoryScope,
        currentMessage: LivingMemoryTranscriptMessage,
        loadHistoryMessages: () => Promise<LivingMemoryTranscriptMessage[]>,
        logger: LivingMemoryLogger
    ) {
        const startedAt = new Date()
        const input = normalizeText(currentMessage.contentLines.join('\n'))
        if (input.length === 0) {
            return
        }

        try {
            const historyMessages = await loadHistoryMessages()
            const snapshot =
                await this.repository.getLatestSnapshotByScope(scope)
            const snapshotText = renderSnapshotText(snapshot?.items ?? [])
            const snapshotLines =
                snapshotText === '' ? [] : snapshotText.split(/\r?\n/)
            const updatedSnapshot = await this.agenticRecall.run(
                scope,
                currentMessage,
                historyMessages,
                snapshotLines,
                async (item) => {
                    await this.repository.upsertSnapshot(
                        scope,
                        JSON.stringify(item.toolCallSummary),
                        [item]
                    )
                },
                logger,
                this.controller.signal
            )
            // 模型已返回但取消已到：快照不再更新，也不记失败任务。
            this.controller.signal.throwIfAborted()
            if (updatedSnapshot == null) {
                logger.summary(
                    '召回结束',
                    `${formatLogScope(scope)}; 结果：沿用当前快照`
                )
                return
            }

            logger.summary(
                '召回快照已更新',
                [
                    `${formatLogScope(scope)}; 命中记忆：${updatedSnapshot.matchedMemories.length} 条`,
                    '========召回快照========',
                    renderSnapshotText([updatedSnapshot])
                ].join('\n')
            )
        } catch (error) {
            // 取消不是召回失败：不写失败任务。
            this.controller.signal.throwIfAborted()
            await this.repository.createFailedJob(
                scope,
                'recall',
                input,
                error,
                startedAt
            )
            throw error
        }
    }
}
