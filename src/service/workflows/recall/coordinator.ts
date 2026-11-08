import type { RouteSettings } from '../../../routing.ts'
import { isModelConfigured } from '../../shared/utils.ts'
import { scopeKey } from '../../memory/helpers.ts'
import { formatLogScope, type LivingMemoryLogger } from '../../logging/logger.ts'
import { renderSnapshotText } from '../../memory/snapshot/snapshot_text.ts'
import { renderLivingMemoryTranscript } from '../../transcript/transcript_renderer.ts'
import type { LivingMemoryAgenticRecallExecutor } from './agentic_recall.ts'
import type {
    JobRepository,
    SnapshotRepository
} from '../../../contracts/workflows.ts'
import type { ChatHistoryScope, LivingMemoryChatHistory } from '../../chat_history.ts'
import type {
    LivingMemoryTranscriptMessage,
    MemoryScope
} from '../../../contracts/memory.ts'

type RecallSettings = Pick<RouteSettings, 'recallIntervalMessages' | 'snapshotMaxLines' | 'enableConversationIsolation'>

/** 召回间隔锚点所需的消息日志读取面。 */
type RecallMessageLog = Pick<LivingMemoryChatHistory, 'after'>

type RecallAgenticExecutor = Pick<LivingMemoryAgenticRecallExecutor, 'run'>
export type RecallWorkflowRepository = Pick<JobRepository, 'createFailedJob'> &
    Pick<SnapshotRepository, 'upsertSnapshot' | 'getLatestSnapshotByScope'>

export class LivingMemoryRecallCoordinator {
    private readonly recallLockByConversation = new Set<string>()
    /**
     * 召回窗口锚点：上次实际执行召回时的聊天历史位置。间隔按此后累计
     * 的聊天条数（含闲聊）计；锚点只在召回实际执行时前移，
     * 召回失败时清除，使下次触发立即重试。
     */
    private readonly anchorPositionByScope = new Map<string, number>()
    private readonly generations = new Map<string, object>()
    /**
     * 卸载时取消在途召回：停止接收新触发、中止模型调用、等待任务收尾。
     * 召回不写任务行（只在失败时记一条），因此取消不产生额外记录。
     */
    private readonly controller = new AbortController()
    private readonly tasks = new Set<Promise<void>>()

    constructor(
        private readonly subModel: string,
        private readonly messageLog: RecallMessageLog,
        private readonly repository: RecallWorkflowRepository,
        private readonly agenticRecall: RecallAgenticExecutor,
        private readonly logger: LivingMemoryLogger
    ) {}

    async queue(
        settings: RecallSettings,
        scope: ChatHistoryScope,
        chatHistory: LivingMemoryTranscriptMessage[],
        currentPosition: number
    ) {
        if (settings.recallIntervalMessages === 0 || !chatHistory.length) return
        if (this.controller.signal.aborted) return
        if (!isModelConfigured(this.subModel)) {
            this.logger.diagnosticSummary(() => ({
                event: '跳过记忆召回',
                detail: `${formatLogScope(scope)}; 原因：召回模型未配置`
            }))
            return
        }

        const lockKey = scopeKey(scope)
        const generation = this.generations.get(scope.conversationId) ?? {}
        this.generations.set(scope.conversationId, generation)
        const anchorPosition = this.anchorPositionByScope.get(lockKey)
        if (anchorPosition !== undefined) {
            const messagesSinceRecall = (await this.messageLog.after(scope, anchorPosition, currentPosition + 1)).length
            if (messagesSinceRecall < settings.recallIntervalMessages) {
                this.logger.diagnosticSummary(() => ({
                    event: '跳过记忆召回',
                    detail: `${formatLogScope(scope)}; 召回消息阈值：${messagesSinceRecall}/${settings.recallIntervalMessages} 条`
                }))
                return
            }
        }

        if (this.controller.signal.aborted || this.generations.get(scope.conversationId) !== generation) return

        if (this.recallLockByConversation.has(lockKey)) {
            // 同一会话同一预设已有召回在跑，本次请求直接丢弃，不做 coalescing。
            // snapshot 由后续请求基于最新历史消息重新触发追上，最多滞后一轮。
            this.logger.diagnosticSummary(() => ({
                event: '跳过记忆召回',
                detail: `${formatLogScope(scope)}; 原因：当前召回任务运行中`
            }))
            return
        }

        const input = renderLivingMemoryTranscript(chatHistory)
        const runLogger = this.logger.with({ ...scope })
        this.recallLockByConversation.add(lockKey)
        this.anchorPositionByScope.set(lockKey, currentPosition)
        const task = this.run(settings, scope, input, runLogger)
            .catch((error) => {
                if (this.generations.get(scope.conversationId) === generation) {
                    this.anchorPositionByScope.delete(lockKey)
                }
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

    /** 停止接收新触发并取消在途召回，等待运行收尾。 */
    async stop() {
        this.controller.abort(new Error('记忆召回服务正在停止。'))
        await Promise.allSettled([...this.tasks])
        this.clearAll()
    }

    clearAll() {
        this.anchorPositionByScope.clear()
        this.generations.clear()
    }

    clearByConversation(conversationId: string) {
        this.generations.delete(conversationId)
        for (const key of this.anchorPositionByScope.keys()) {
            if (key.endsWith(`\n${conversationId}`)) {
                this.anchorPositionByScope.delete(key)
            }
        }
    }

    private async run(
        settings: RecallSettings,
        scope: MemoryScope,
        input: string,
        logger: LivingMemoryLogger
    ) {
        const startedAt = new Date()
        try {
            const snapshot =
                await this.repository.getLatestSnapshotByScope(scope)
            const snapshotText = renderSnapshotText(snapshot?.items ?? [])
            const snapshotLines =
                snapshotText === '' ? [] : snapshotText.split(/\r?\n/)
            const updatedSnapshot = await this.agenticRecall.run(
                settings,
                scope,
                input,
                snapshotLines,
                async (item) => {
                    this.controller.signal.throwIfAborted()
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
