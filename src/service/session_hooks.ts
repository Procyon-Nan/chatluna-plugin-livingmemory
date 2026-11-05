import type { Context } from 'cordis'
import type { Disposable } from 'cordis'
import type { Agent } from '@chatluna/agent'
import type {} from '@chatluna/chat'
import { ChatMessage } from '@chatluna/message'
import type { LivingMemoryLogger } from './logging/logger.ts'
import type { MessageCollector } from './message_collector.ts'
import { formatLogScope } from './logging/logger.ts'
import { buildMemoryTranscriptOrigin } from './transcript/origin_context.ts'
import { toLogTranscriptMessages } from './transcript/message_log/converter.ts'
import { toSessionLogMessages } from './transcript/message_log/session_history.ts'
import { collectUserProfileSpeakerKeys } from './user_profile.ts'
import { renderSnapshotText } from './memory/snapshot/snapshot_text.ts'
import type { LivingMemoryRecallCoordinator } from './workflows/recall/coordinator.ts'
import type { LivingMemoryExtractionCoordinator } from './workflows/extraction/coordinator.ts'
import type { LivingMemoryUserProfileService } from './user_profile.ts'
import type { LivingMemoryConfig, SnapshotRepository } from '../contracts/workflows.ts'
import type { LivingMemoryTranscriptMessage, MemoryScope } from '../contracts/memory.ts'
import type { ConversationLogMessage } from './transcript/message_log/types.ts'

/** 注入用的分节名；同名分节在会话快照里唯一。 */
const SNAPSHOT_PLUGIN = 'chatluna:livingmemory'

/** 排在原生 memory 的提取（890）之前：原生提取读到的池子已含本步消息。 */
const RECALL_STEP_ORDER = 870

type SessionHooksConfig = Pick<
    LivingMemoryConfig,
    | 'enableSnapshotInjection'
    | 'enableUserProfileInjection'
    | 'recallIntervalMessages'
    | 'recallHistoryMessages'
    | 'extractionWindowMessages'
    | 'extractionIncludeOverheard'
>

interface LivingMemorySessionHooksOptions {
    collector: MessageCollector
    recall: LivingMemoryRecallCoordinator
    extraction: LivingMemoryExtractionCoordinator
    userProfiles: LivingMemoryUserProfileService
    repository: Pick<SnapshotRepository, 'getLatestSnapshotByScope'>
    logger: LivingMemoryLogger
    config: SessionHooksConfig
}

/**
 * 会话钩子：把 v1 的 `chatluna/before-chat` 与 `chatluna/after-chat` 接到 v2 的
 * 执行链上。
 *
 * - `chatluna/before-chat` → `ctx.agents.prepareStep`：同步消息池、注入快照与画像、
 *   触发召回。
 * - `chatluna/after-chat` → `chatluna/agent-turn`：记录回复并触发提取。
 * - `chatluna/prompt-submit`：不使用。v2 的入站消息由观察层规范化后进入 agent，
 *   入站改写没有对应的需求。
 */
export class LivingMemorySessionHooks {
    private readonly disposables: (() => void)[] = []

    constructor(
        private readonly ctx: Context,
        private readonly options: LivingMemorySessionHooksOptions
    ) {}

    register(): Disposable {
        this.disposables.push(
            this.ctx.agents.prepareStep(
                async ({ agent, stepNumber }) => {
                    // 每轮只在第一步注入与召回：`contribute` 的结果并进请求，
                    // 后续步再注入会让同一段快照在一条请求里重复出现。
                    if (stepNumber !== 1) return undefined
                    const injection = await this.beforeStep(agent)
                    return injection === undefined
                        ? undefined
                        : { contribute: [injection] }
                },
                { name: 'livingmemory:recall', order: RECALL_STEP_ORDER }
            )
        )
        this.disposables.push(
            this.ctx.on('chatluna/agent-turn', ({ agent, reason }) => {
                if (reason !== 'completed') return
                this.afterTurn(agent)
            })
        )
        return () => {
            for (const dispose of this.disposables.splice(0)) dispose()
        }
    }

    /** 同步消息池并生成注入消息；预设未标注的会话不参与记忆流程。 */
    private async beforeStep(agent: Agent): Promise<ChatMessage | undefined> {
        const scope = this.scopeOf(agent)
        if (scope === undefined) return undefined
        this.options.collector.sync(scope.conversationId, String(agent.session.id))

        const current = lastUserEntry(
            this.options.collector.recent(
                scope.conversationId,
                this.historyLimit()
            )
        )
        // 先召回再读快照：注入的必须是本轮刚更新的那份。
        if (this.options.config.recallIntervalMessages > 0 && current !== undefined) {
            await this.options.recall.queue(
                scope,
                await this.currentMessage(scope, current),
                () => this.windowMessages(scope, agent, current)
            )
        }
        return await this.renderInjection(scope, agent, current)
    }

    private async renderInjection(
        scope: MemoryScope,
        agent: Agent,
        current: ConversationLogMessage | undefined
    ): Promise<ChatMessage | undefined> {
        const sections: string[] = []
        if (this.options.config.enableSnapshotInjection) {
            const snapshot = await this.options.repository.getLatestSnapshotByScope(
                scope
            )
            const text = renderSnapshotText(snapshot?.items ?? [])
            if (text.length > 0) sections.push(`## 短期记忆\n${text}`)
        }
        if (this.options.config.enableUserProfileInjection) {
            // 说话人取自召回窗口本身：窗口是这张画像在对话里出现的范围。
            const speakerKeys = collectUserProfileSpeakerKeys(
                await this.windowMessages(scope, agent, current)
            )
            const profiles = await this.options.userProfiles.renderForSpeakers(
                scope.presetId,
                speakerKeys
            )
            if (profiles.trim().length > 0) {
                sections.push(`## 用户画像\n${profiles.trim()}`)
            }
        }
        if (sections.length === 0) return undefined
        const text = sections.join('\n\n')
        this.options.logger.diagnosticSummary(() => ({
            event: '记忆注入',
            detail: `${formatLogScope(scope)}; 注入长度：${text.length} 字符`
        }))
        return ChatMessage.notice(SNAPSHOT_PLUGIN, text)
    }

    /** 一轮正常结束后记录回复并触发自动提取。 */
    private afterTurn(agent: Agent) {
        const scope = this.scopeOf(agent)
        if (scope === undefined) return
        this.options.collector.recordReplies(agent)
        if (this.options.config.extractionWindowMessages === 0) return
        void this.options.extraction
            .queue(scope, {
                includeOverheard: this.options.config.extractionIncludeOverheard,
                resolveTranscriptOrigin: async () =>
                    this.transcriptOrigin(scope, agent)
            })
            .catch((error) => {
                this.options.logger.summary(
                    '记忆提取调度失败',
                    formatLogScope(scope),
                    'warn',
                    error
                )
            })
    }

    /**
     * 召回窗口：池内实时条目；不足时用会话历史补足。
     *
     * 会话历史含观察层回填的平台消息，是冷启动首轮唯一可用的上下文。
     */
    private async windowMessages(
        scope: MemoryScope,
        agent: Agent,
        current: ConversationLogMessage | undefined
    ): Promise<LivingMemoryTranscriptMessage[]> {
        const history = await this.options.collector.recallWindow(
            scope.conversationId,
            this.options.config.recallHistoryMessages,
            current,
            toSessionLogMessages(agent.session.messages())
        )
        return await toLogTranscriptMessages(
            scope,
            scope.platform ?? 'unknown',
            history
        )
    }

    private async currentMessage(
        scope: MemoryScope,
        entry: ConversationLogMessage
    ): Promise<LivingMemoryTranscriptMessage> {
        const [message] = await toLogTranscriptMessages(
            scope,
            scope.platform ?? 'unknown',
            [entry]
        )
        return (
            message ?? {
                role: 'user',
                speakerLabel: entry.name,
                contentLines: entry.content.split('\n'),
                createdAt: new Date(entry.timestamp ?? Date.now())
            }
        )
    }

    /**
     * 提取的会话语境。群名取 `ctx.chat.environmentOf(sessionId)`——`chat` 打开
     * agent 时把 `session.event.guild.name` 写进该环境的 `guildName`，与提示词
     * 渲染用的是同一份值。取不到时用群号代替展示名。
     */
    private transcriptOrigin(scope: MemoryScope, agent: Agent) {
        const location = agent.options.location
        if (scope.isDirect === true) {
            return buildMemoryTranscriptOrigin({
                isDirect: true,
                speakerLabel: scope.userId ?? location?.user ?? '用户',
                speakerId: scope.userId
            })
        }
        const guildId = scope.guildId ?? location?.guild ?? scope.conversationId
        const guildName =
            this.ctx.chat.environmentOf(String(agent.session.id))?.guildName ??
            guildId
        return buildMemoryTranscriptOrigin({
            isDirect: false,
            guildName,
            guildId
        })
    }

    /** 会话归属：预设 + 会话键；任一缺失时不处理。 */
    private scopeOf(agent: Agent): MemoryScope | undefined {
        const conversationKey = agent.options.conversationKey
        const presetId = agent.options.presetId
        if (conversationKey === undefined || presetId === undefined) {
            return undefined
        }
        return this.options.collector.scopeOf(conversationKey, presetId)
    }

    private historyLimit() {
        return Math.max(
            this.options.config.extractionWindowMessages,
            this.options.config.recallHistoryMessages
        )
    }
}

/** 最近一条用户消息；池里末尾可能是助手自己的回声。 */
const lastUserEntry = (history: readonly ConversationLogMessage[]) => {
    for (let index = history.length - 1; index >= 0; index -= 1) {
        if (history[index].role === 'user') return history[index]
    }
    return undefined
}