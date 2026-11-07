import type { Context, Disposable } from 'cordis'
import type { Agent } from '@chatluna/agent'
import type { ObservedEvent } from '@chatluna/chat-observer'
import type {} from '@chatluna/chat'
import type {} from '@chatluna/conversations'
import { ChatMessage } from '@chatluna/message'
import type { ChatBlock } from '@chatluna/message'
import type { LivingMemoryLogger } from './logging/logger.ts'
import { formatLogScope } from './logging/logger.ts'
import { buildMemoryTranscriptOrigin } from './transcript/origin_context.ts'
import { toHistoryTranscriptMessages } from './chat_history.ts'
import type { ChatHistoryEntry, ChatHistoryScope, LivingMemoryChatHistory } from './chat_history.ts'
import { collectUserProfileSpeakerKeys } from './user_profile.ts'
import { renderSnapshotText } from './memory/snapshot/snapshot_text.ts'
import type { LivingMemoryRecallCoordinator } from './workflows/recall/coordinator.ts'
import type { LivingMemoryExtractionCoordinator } from './workflows/extraction/coordinator.ts'
import type { LivingMemoryUserProfileService } from './user_profile.ts'
import type { LivingMemoryConfig, SnapshotRepository } from '../contracts/workflows.ts'

const SNAPSHOT_PLUGIN = 'chatluna:livingmemory'
const RECALL_STEP_ORDER = 870

type SessionHooksConfig = Pick<LivingMemoryConfig,
    | 'enableSnapshotInjection'
    | 'enableUserProfileInjection'
    | 'recallIntervalMessages'
    | 'recallHistoryMessages'
    | 'extractionWindowMessages'
    | 'extractionIncludeOverheard'
>

interface LivingMemorySessionHooksOptions {
    history: LivingMemoryChatHistory
    recall: LivingMemoryRecallCoordinator
    extraction: LivingMemoryExtractionCoordinator
    userProfiles: LivingMemoryUserProfileService
    repository: Pick<SnapshotRepository, 'getLatestSnapshotByScope'>
    logger: LivingMemoryLogger
    config: SessionHooksConfig
}

/** 只保存消费边界；聊天正文始终从框架读取。 */
interface ConversationState {
    scope: ChatHistoryScope
    boundary: number
    deliveries: Map<number, Delivery>
}

interface Delivery {
    pending: Set<string>
    last: number
    drained: boolean
}

export class LivingMemorySessionHooks {
    private readonly disposables: (() => void)[] = []
    private readonly conversations = new Map<string, ConversationState>()
    private readonly revisions = new Map<string, { contextStart: number }>()
    private readonly turns = new WeakMap<Agent, { state: ConversationState; turn?: number }>()
    private active = false

    constructor(
        private readonly ctx: Context,
        private readonly options: LivingMemorySessionHooksOptions
    ) {}

    register(): Disposable {
        this.active = true
        this.disposables.push(this.ctx.agents.prepareStep(
            async ({ agent, stepNumber, messages }) => {
                if (stepNumber !== 1) return undefined
                const injection = await this.beforeStep(agent, messages)
                return injection === undefined ? undefined : { contribute: [injection] }
            },
            { name: 'livingmemory:recall', order: RECALL_STEP_ORDER }
        ))
        this.disposables.push(this.ctx.on('chatluna/engine-preset', ({ agent, presetId }) => {
            const key = agent.options.conversationKey
            if (key !== undefined) this.changeScope(key, String(agent.session.id), presetId, false)
        }))
        this.disposables.push(this.ctx.on('chatluna/conversation-change', (event) => {
            if (event.reason === 'create' && !this.conversations.has(event.conversationKey)) return
            this.changeScope(event.conversationKey, String(event.current.sessionId), event.current.presetId,
                event.previous !== undefined && event.current.sessionId !== event.previous.sessionId)
        }))
        this.disposables.push(this.ctx.on('chatluna/observed', (event) => {
            void this.onObserved(event).catch((error) => this.logScheduleError(event.conversationKey, error))
        }))
        // 引擎可以直接发送回复而不运行模型步骤。用轮次开始事件绑定它的原作用域。
        this.disposables.push(this.ctx.on('chatluna/engine-turn', async ({ agent, turn, input }) => {
            this.turns.delete(agent)
            const key = agent.options.conversationKey
            if (key === undefined) return
            const existing = this.conversations.get(key)
            const preset = this.ctx.get('engines')?.presetOf(agent) ?? agent.options.presetId
            if (existing?.scope.sessionId === String(agent.session.id) && existing.scope.presetId === preset) {
                this.bindTurn(agent, existing, turn)
                return
            }
            const resolved = await this.resolveInput(agent, input)
            if (resolved && this.conversations.get(key) === resolved.state) this.bindTurn(agent, resolved.state, turn)
        }))
        this.disposables.push(this.ctx.on('chatluna/agent-output', ({ agent, turn }) => {
            const running = this.turns.get(agent)
            if (running && running.turn === undefined) this.bindTurn(agent, running.state, turn)
        }))
        this.disposables.push(this.ctx.on('send', (session) => {
            const sent = session.chatSent
            const reply = sent?.reply
            if (!reply || !sent?.own || !sent.messageIds.length) return
            const state = this.conversations.get(reply.conversationKey)
            if (state?.scope.sessionId !== reply.sessionId || state.scope.presetId !== reply.presetId) return
            // 同一次发送的多个平台 ID 共用正文；渲染器主动拆段则分别产生 send。
            state.deliveries.get(reply.turn)?.pending.add(sent.messageIds[0])
        }))
        this.disposables.push(this.ctx.on('chatluna/agent-turn', ({ agent, reason }) => {
            const running = this.turns.get(agent)
            this.turns.delete(agent)
            if (running?.turn === undefined) return
            const { state, turn } = running
            void this.finishTurn(state, turn, reason === 'completed').catch((error) =>
                this.logScheduleError(state.scope.conversationId, error))
        }))
        return () => {
            this.active = false
            for (const dispose of this.disposables.splice(0)) dispose()
            this.conversations.clear()
            this.revisions.clear()
        }
    }

    private changeScope(key: string, sessionId: string, presetId: string | undefined, sessionChanged: boolean) {
        const existing = this.conversations.get(key)
        if (!sessionChanged && existing?.scope.sessionId === sessionId && existing.scope.presetId === presetId) return
        const boundary = this.options.history.lastPosition(key)
        this.reset(key, sessionChanged ? boundary : this.revisions.get(key)?.contextStart)
        if (presetId !== undefined) this.stateOf(this.options.history.scopeOf(key, sessionId, presetId), boundary)
    }

    reset(conversationId: string, contextStart = this.revisions.get(conversationId)?.contextStart ?? -1) {
        this.revisions.set(conversationId, { contextStart })
        this.conversations.delete(conversationId)
        this.options.recall.clearByConversation(conversationId)
        this.options.extraction.clearByConversation(conversationId)
    }

    private async onObserved(event: ObservedEvent) {
        if (!this.active || event.message.backfilled) return
        const key = event.conversationKey
        if (event.message.self) {
            const state = this.conversations.get(key)
            const id = event.message.platformMessageId
            if (!state || id === undefined) return
            for (const [turn, delivery] of state.deliveries) {
                if (!delivery.pending.delete(id)) continue
                const position = this.options.history.locate(key, event.message, state.scope)
                if (position !== undefined) delivery.last = Math.max(delivery.last, position)
                if (this.options.config.extractionIncludeOverheard && position !== undefined) {
                    await this.queueExtraction(state, position)
                }
                if (delivery.drained) await this.flushDelivery(state, turn, delivery)
                return
            }
            return
        }
        const position = this.options.history.locate(key, event.message)
        if (position === undefined) return
        const revision = this.revisions.get(key)
        const current = await this.ctx.conversations.current(key)
        if (!this.active || this.revisions.get(key) !== revision || !current?.presetId ||
            (event.sessionId !== undefined && current.sessionId !== event.sessionId)) return
        const existing = this.conversations.get(key)
        const state = existing?.scope.sessionId === String(current.sessionId) ? existing
            : this.stateOf(this.options.history.scopeOf(key, String(current.sessionId), current.presetId), position - 1)
        if (position > state.boundary && this.options.config.extractionIncludeOverheard) await this.queueExtraction(state, position)
    }

    private bindTurn(agent: Agent, state: ConversationState, turn: number) {
        this.turns.set(agent, { state, turn })
        state.deliveries.set(turn, { pending: new Set(), last: -1, drained: false })
    }

    private async resolveInput(agent: Agent, messages: readonly ChatMessage[]) {
        const conversationId = agent.options.conversationKey
        if (conversationId === undefined) return undefined
        const revision = this.revisions.get(conversationId)
        const currentHead = await this.ctx.conversations.current(conversationId)
        if (!currentHead || String(currentHead.sessionId) !== String(agent.session.id)) return undefined
        const actualPreset = this.ctx.get('engines')?.presetOf(agent) ?? agent.options.presetId ?? currentHead.presetId
        if (actualPreset === undefined) return undefined
        const active = this.conversations.get(conversationId)
        if (actualPreset !== currentHead.presetId && active?.scope.presetId !== actualPreset) return undefined
        const candidateScope = this.options.history.scopeOf(conversationId, String(currentHead.sessionId), actualPreset)
        if (!this.active || this.revisions.get(conversationId) !== revision) return undefined
        const trigger = this.options.history.trigger(candidateScope, triggeringMessageIds(messages))
        const state = this.stateOf(candidateScope, trigger === undefined
            ? this.options.history.lastPosition(conversationId) : trigger.position - 1)
        const current = trigger !== undefined && trigger.position > (revision?.contextStart ?? -1) ? trigger : undefined
        return { state, current }
    }

    private async beforeStep(agent: Agent, messages: readonly ChatMessage[]): Promise<ChatMessage | undefined> {
        const resolved = await this.resolveInput(agent, messages)
        if (!resolved || this.conversations.get(resolved.state.scope.conversationId) !== resolved.state) return
        const { state, current } = resolved
        const scope = state.scope
        const conversationId = scope.conversationId
        if (!this.turns.has(agent)) this.turns.set(agent, { state })
        if (this.options.config.recallIntervalMessages > 0 && current !== undefined) {
            const [message] = toHistoryTranscriptMessages(scope, [current])
            if (message === undefined) throw new Error(`触发消息无法转写：${current.messageId}`)
            await this.options.recall.queue(scope, message, () => this.windowMessages(scope, current), current.position)
        }
        if (this.conversations.get(conversationId) !== state || !this.active) return undefined
        const injection = await this.renderInjection(scope, current)
        if (this.conversations.get(conversationId) !== state || !this.active) return undefined
        return injection
    }

    private stateOf(scope: ChatHistoryScope, boundary: number): ConversationState {
        const existing = this.conversations.get(scope.conversationId)
        if (existing?.scope.sessionId === scope.sessionId && existing.scope.presetId === scope.presetId) {
            if (existing.scope.platform === undefined) Object.assign(existing.scope, scope)
            return existing
        }
        if (existing !== undefined) this.reset(scope.conversationId)
        const state: ConversationState = { scope, boundary, deliveries: new Map() }
        this.conversations.set(scope.conversationId, state)
        return state
    }

    private async finishTurn(state: ConversationState, turn: number, completed: boolean) {
        const delivery = state.deliveries.get(turn)
        if (!delivery) return
        await this.ctx.chat.drain(state.scope.sessionId)
        if (!this.active || this.conversations.get(state.scope.conversationId) !== state) return
        // 未进入 observer 的发送不生成正文。下一轮交付完成后释放旧轮未匹配的 ID。
        for (const [previous, item] of state.deliveries) {
            if (previous < turn && item.drained) state.deliveries.delete(previous)
        }
        if (!completed) {
            state.deliveries.delete(turn)
            return
        }
        delivery.drained = true
        await this.flushDelivery(state, turn, delivery)
    }

    private async flushDelivery(state: ConversationState, turn: number, delivery: Delivery) {
        if (delivery.pending.size) return
        state.deliveries.delete(turn)
        if (!this.options.config.extractionIncludeOverheard && delivery.last > state.boundary) {
            await this.queueExtraction(state, delivery.last)
        }
    }

    private async queueExtraction(state: ConversationState, eligiblePosition?: number) {
        if (this.options.config.extractionWindowMessages === 0) return
        await this.options.extraction.queue(state.scope, {
            includeOverheard: this.options.config.extractionIncludeOverheard,
            resolveTranscriptOrigin: async () => this.transcriptOrigin(state.scope)
        }, state.boundary, eligiblePosition)
    }

    private async windowMessages(scope: ChatHistoryScope, current: ChatHistoryEntry | undefined) {
        const entries = await this.options.history.recent(scope,
            this.options.config.recallHistoryMessages, current?.position, this.revisions.get(scope.conversationId)?.contextStart)
        return toHistoryTranscriptMessages(scope, entries)
    }

    private async renderInjection(scope: ChatHistoryScope, current: ChatHistoryEntry | undefined): Promise<ChatMessage | undefined> {
        const sections: string[] = []
        if (this.options.config.enableSnapshotInjection) {
            const snapshot = await this.options.repository.getLatestSnapshotByScope(scope)
            const text = renderSnapshotText(snapshot?.items ?? [])
            if (text.length > 0) sections.push(`## 短期记忆\n${text}`)
        }
        if (this.options.config.enableUserProfileInjection) {
            const speakerKeys = collectUserProfileSpeakerKeys(await this.windowMessages(scope, current))
            const profiles = await this.options.userProfiles.renderForSpeakers(scope.presetId, speakerKeys)
            if (profiles.trim().length > 0) sections.push(`## 用户画像\n${profiles.trim()}`)
        }
        if (sections.length === 0) return undefined
        const text = sections.join('\n\n')
        this.options.logger.diagnosticSummary(() => ({
            event: '记忆注入',
            detail: `${formatLogScope(scope)}; 注入长度：${text.length} 字符`
        }))
        return ChatMessage.notice(SNAPSHOT_PLUGIN, text)
    }

    private transcriptOrigin(scope: ChatHistoryScope) {
        if (scope.isDirect === true) {
            return buildMemoryTranscriptOrigin({
                isDirect: true,
                speakerLabel: scope.userId ?? '用户',
                speakerId: scope.userId
            })
        }
        const guildId = scope.guildId ?? scope.conversationId
        const guildName = this.ctx.chat.environmentOf(scope.sessionId)?.guildName ?? guildId
        return buildMemoryTranscriptOrigin({ isDirect: false, guildName, guildId })
    }

    private logScheduleError(conversationId: string, error: unknown) {
        this.options.logger.summary('记忆提取调度失败', `会话：${conversationId}`, 'warn', error)
    }
}

/** 当前输入批次的原始消息身份；内部 notice 与工具步骤不触发召回。 */
function triggeringMessageIds(messages: readonly ChatMessage[]): string[] {
    const ids: string[] = []
    const collectEnvelopeIds = (blocks: readonly ChatBlock[]) => {
        for (const block of blocks) {
            if (block.type !== 'envelope' || block.kind !== 'message') continue
            if (block.sender?.self === true) continue
            ids.push(String(block.id))
            if (block.externalId !== undefined) ids.push(block.externalId)
        }
    }
    for (const message of messages) {
        if (message.role !== 'user' || message.form === 'notice' || message.form === 'snapshot' || message.meta?.backfill === true) continue
        const envelopes = message.content.some((block) => block.type === 'envelope')
        if (envelopes) collectEnvelopeIds(message.content)
        else {
            if (message.source.kind === 'user' && message.source.routeId !== undefined) ids.push(String(message.id))
            if (message.meta?.externalId !== undefined) ids.push(message.meta.externalId)
        }
    }
    return ids
}
