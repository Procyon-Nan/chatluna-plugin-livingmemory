import type { RouteSettings } from '../../../routing.ts'
import { isModelConfigured } from '../../shared/utils.ts'
import { SerialTaskQueue } from '../../shared/serial_task_queue.ts'
import { scopeKey, snapshotScopeOf } from '../../memory/helpers.ts'
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
    MemoryScope,
    SnapshotScope
} from '../../../contracts/memory.ts'

type RecallSettings = Pick<RouteSettings, 'recallIntervalMessages' | 'snapshotMaxLines' | 'enableConversationIsolation' | 'snapshotScope'>

/** 召回间隔锚点所需的消息日志读取面。 */
type RecallMessageLog = Pick<LivingMemoryChatHistory, 'after'>

type RecallAgenticExecutor = Pick<LivingMemoryAgenticRecallExecutor, 'run'>
export type RecallWorkflowRepository = Pick<JobRepository, 'createFailedJob'> &
    Pick<SnapshotRepository, 'upsertSnapshot' | 'getLatestSnapshotByScope'>

interface RecallWindow {
    /** 上次召回的聊天位置；下一次只统计此后的真实聊天条数。 */
    anchor?: number
    pending: boolean
}

export class LivingMemoryRecallCoordinator {
    private readonly snapshotUpdates = new SerialTaskQueue()
    private readonly windows = new Map<string, RecallWindow>()
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

        const key = scopeKey(scope)
        let window = this.windows.get(key)
        if (!window) {
            window = { pending: false }
            this.windows.set(key, window)
        }
        if (window.anchor !== undefined) {
            const messagesSinceRecall = (await this.messageLog.after(scope, window.anchor, currentPosition + 1)).length
            if (messagesSinceRecall < settings.recallIntervalMessages) {
                this.logger.diagnosticSummary(() => ({
                    event: '跳过记忆召回',
                    detail: `${formatLogScope(scope)}; 召回消息阈值：${messagesSinceRecall}/${settings.recallIntervalMessages} 条`
                }))
                return
            }
        }

        if (this.controller.signal.aborted || this.windows.get(key) !== window) return

        if (window.pending) {
            this.logger.diagnosticSummary(() => ({
                event: '跳过记忆召回',
                detail: `${formatLogScope(scope)}; 原因：当前召回任务运行中`
            }))
            return
        }

        const input = renderLivingMemoryTranscript(chatHistory)
        const runLogger = this.logger.with({ ...scope })
        window.pending = true
        window.anchor = currentPosition
        const snapshotScope = snapshotScopeOf(scope, settings)
        const snapshotKey = JSON.stringify([snapshotScope.presetId, snapshotScope.conversationId])
        const task = this.snapshotUpdates.run(snapshotKey, async () => {
            // 等待同一份快照时会话已重置，旧聊天不再启动召回。
            if (this.windows.get(key) !== window) return
            await this.run(settings, scope, snapshotScope, input, runLogger)
        })
            .catch((error) => {
                delete window.anchor
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
                window.pending = false
            })
        this.tasks.add(task)
        void task.finally(() => this.tasks.delete(task))
    }

    /** 停止接收新触发并取消在途召回，等待运行收尾。 */
    async stop() {
        this.controller.abort(new Error('记忆召回服务正在停止。'))
        await Promise.allSettled([...this.tasks])
        this.windows.clear()
    }

    clearByConversation(conversationId: string) {
        for (const key of this.windows.keys()) {
            if (key.endsWith(`\n${conversationId}`)) {
                this.windows.delete(key)
            }
        }
    }

    private async run(
        settings: RecallSettings,
        scope: MemoryScope,
        snapshotScope: SnapshotScope,
        input: string,
        logger: LivingMemoryLogger
    ) {
        this.controller.signal.throwIfAborted()
        const startedAt = new Date()
        try {
            const snapshot =
                await this.repository.getLatestSnapshotByScope(snapshotScope)
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
                        snapshotScope,
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
