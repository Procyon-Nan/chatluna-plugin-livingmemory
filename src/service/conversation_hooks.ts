import { isCustomConversation, type RouteSettings } from '../routing.ts'
import type { Context, Disposable } from 'cordis'
import type { Agent } from '@chatluna/agent'
import type { ObservedEvent } from '@chatluna/chat-observer'
import type {} from '@chatluna/chat'
import type {} from '@chatluna/conversations'
import { ChatMessage, type ChatMessageMeta } from '@chatluna/message'
import { createSpeakerKey } from './memory/speaker_identity.ts'
import type { LivingMemoryLogger } from './logging/logger.ts'
import { formatLogScope } from './logging/logger.ts'
import { formatTranscriptHeader } from './transcript/header.ts'
import { toHistoryTranscriptMessages } from './chat_history.ts'
import type { ChatHistoryScope, LivingMemoryChatHistory } from './chat_history.ts'
import { resolvePresetAssistantLabel, snapshotScopeOf } from './memory/helpers.ts'
import { renderSnapshotText } from './memory/snapshot/snapshot_text.ts'
import type { LivingMemoryRecallCoordinator } from './workflows/recall/coordinator.ts'
import type { LivingMemoryExtractionCoordinator } from './workflows/extraction/coordinator.ts'
import type { LivingMemoryUserProfileService } from './user_profile.ts'
import type { SnapshotRepository } from '../contracts/workflows.ts'

interface LivingMemoryConversationHooksOptions {
    history: LivingMemoryChatHistory
    recall: LivingMemoryRecallCoordinator
    extraction: LivingMemoryExtractionCoordinator
    userProfiles: LivingMemoryUserProfileService
    repository: Pick<SnapshotRepository, 'getLatestSnapshotByScope'>
    logger: LivingMemoryLogger
    settingsOf: (key: string, location?: Agent['options']['location'], routeId?: string, noticeSessionId?: string) => RouteSettings
}

/** 只保存消费边界；聊天正文始终从框架读取。 */
interface ConversationState {
    scope: ChatHistoryScope
    boundary: number
    deliveries: Map<number, Delivery>
}

interface Delivery {
    settings: RouteSettings
    routeId?: string
    pendingMessageIds: Set<string>
    lastReply?: { id: string; routeId: string; position?: number }
    extractionEnd?: { position: number; routeId: string }
    drained: boolean
}

interface CapturedWindow {
    readonly settings: RouteSettings
    readonly speakerKeys: string[]
    readonly routeId?: string
    readonly position?: number
    readonly presetId?: string
    readonly revision?: { contextStart: number }
}

interface TurnInput {
    routeId?: string
    state: ConversationState
    settings: RouteSettings
    speakerKeys: string[]
}

interface RunningTurn extends TurnInput {
    number: number
    injection?: Promise<ChatMessage | undefined>
}

export class LivingMemoryConversationHooks {
    private readonly disposables: (() => void)[] = []
    private readonly conversations = new Map<string, ConversationState>()
    private readonly revisions = new Map<string, { contextStart: number }>()
    private readonly turns = new WeakMap<object, RunningTurn>()
    private readonly queued = new WeakMap<Wake, CapturedWindow>()
    private active = false

    constructor(
        private readonly ctx: Context,
        private readonly options: LivingMemoryConversationHooksOptions
    ) {}

    register(): Disposable {
        this.active = true
        this.disposables.push(this.ctx.on('chatluna/agent-input', ({ agent, state, message }) => {
            if (state === 'queued') return this.onInputQueued(agent, message)
        }))
        this.disposables.push(this.ctx.on('chatluna/engine-turn', ({ agent, turn, input }) => this.beginTurn(agent, turn, input)))
        this.disposables.push(this.ctx.on('agent/before-turn', ({ agent, turn, input }) => {
            if (agent.options.engine === undefined) return this.beginTurn(agent, turn, input)
        }))
        this.disposables.push(this.ctx.on('agent/before-request', async request => {
            const turn = this.turns.get(request.agent)
            if (!turn || !this.isCurrent(turn)) return
            turn.injection ??= this.renderInjection(turn)
            const injection = await turn.injection
            if (injection && this.isCurrent(turn)) request.append(injection)
        }))
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
            if (!this.active || event.message.backfilled) return
            const work = event.message.self ? this.onObservedReply(event) : this.onObservedChat(event)
            void work.catch(error => this.logScheduleError(event.conversationKey, error))
        }))
        this.disposables.push(this.ctx.on('send', (session) => {
            const sent = session.chatSent
            const reply = sent?.reply
            if (!reply || !sent?.own || !sent.messageIds.length) return
            const state = this.conversations.get(reply.conversationKey)
            if (state?.scope.sessionId !== reply.sessionId || state.scope.presetId !== reply.presetId) return
            // 同一次发送的多个平台 ID 共用正文；渲染器主动拆段则分别产生 send。
            const delivery = state.deliveries.get(reply.turn)
            if (!delivery) return
            const routeId = session.routeId
            const id = `${routeId}:${sent.messageIds[0]}`
            delivery.pendingMessageIds.add(id)
            delivery.lastReply = { id, routeId }
        }))
        this.disposables.push(this.ctx.on('chatluna/agent-turn', ({ agent, reason }) => {
            const running = this.turns.get(agent)
            this.turns.delete(agent)
            if (!running) return
            const { state } = running
            void this.finishTurn(state, running.number, reason === 'completed').catch((error) =>
                this.logScheduleError(state.scope.conversationId, error))
        }))
        return () => {
            this.active = false
            for (const dispose of this.disposables.splice(0)) dispose()
            this.conversations.clear()
            this.revisions.clear()
        }
    }

    contextForTurn(agent: object): Pick<TurnInput, 'settings' | 'routeId'> | undefined {
        const turn = this.turns.get(agent)
        if (turn && this.isCurrent(turn)) return turn
    }

    private isCurrent({ state }: TurnInput) {
        return this.active && this.conversations.get(state.scope.conversationId) === state
    }

    private onInputQueued(agent: Agent, message: ChatMessage) {
        const key = agent.options.conversationKey
        if (key === undefined) return
        const trigger = findTurnTrigger([message])
        // 合批可以替换外层消息，原始 wake 保持不变。
        if (!trigger?.wake || this.queued.has(trigger.wake)) return
        this.queued.set(trigger.wake, this.captureWindow(agent, key, trigger))
    }

    private captureWindow(agent: Agent, key: string, trigger: TurnTrigger | undefined): CapturedWindow {
        const revision = this.revisions.get(key)
        const observed = trigger?.kind === 'chat' ? this.options.history.locateUser(key, trigger, revision?.contextStart) : undefined
        const position = trigger?.kind === 'notice' ? this.options.history.lastPosition(key) : observed?.position
        const routeId = trigger?.kind === 'chat' ? (observed?.routeId ?? trigger.routeId) : agent.options.location?.route
        const noticeSessionId = trigger?.kind === 'notice' ? String(agent.session.id) : undefined
        const settings = this.options.settingsOf(key, agent.options.location, routeId, noticeSessionId)
        const speakers = new Set<string>()
        if (settings.enableUserProfileInjection && position !== undefined && (!isCustomConversation(key) || routeId)) {
            for (const row of this.recentChat(key, settings, position, routeId)) {
                if (row.role === 'user' && row.userId !== undefined) speakers.add(createSpeakerKey(row.platform, row.userId))
            }
        }
        const presetId = this.agentPreset(agent)
        return { speakerKeys: [...speakers], settings, position, presetId, revision, routeId }
    }

    private recentChat(key: string, settings: RouteSettings, through: number, routeId?: string) {
        const isolatedRoute = isCustomConversation(key) && settings.enableConversationIsolation ? routeId : undefined
        return this.options.history.recent({ conversationId: key }, settings.recallHistoryMessages,
            through, this.revisions.get(key)?.contextStart, isolatedRoute)
    }

    private agentPreset(agent: Agent) {
        return this.ctx.get('engines')?.presetOf(agent) ?? agent.options.presetId
    }

    private async beginTurn(agent: Agent, turn: number, messages: readonly ChatMessage[]) {
        if (this.turns.get(agent)?.number === turn) return
        this.turns.delete(agent)
        const key = agent.options.conversationKey
        if (key === undefined) return
        try {
            const trigger = findTurnTrigger(messages)
            const queued = trigger?.wake && this.queued.get(trigger.wake)
            const window = queued ?? this.captureWindow(agent, key, trigger)
            const head = await this.ctx.conversations.current(key)
            if (!head || String(head.sessionId) !== String(agent.session.id)) return
            if (!this.active || this.revisions.get(key) !== window.revision) return

            const presetId = this.agentPreset(agent) ?? head.presetId
            if (!presetId || (window.presetId !== undefined && presetId !== window.presetId)) return
            if (head.presetId && head.presetId !== presetId && this.conversations.get(key)?.scope.presetId !== presetId) return

            const { settings, position, routeId, speakerKeys } = window
            const boundary = position === undefined ? this.options.history.lastPosition(key) : position - 1
            const state = this.stateOf(key, String(head.sessionId), presetId, boundary)
            this.turns.set(agent, { state, settings, speakerKeys, routeId, number: turn })
            state.deliveries.set(turn, { settings, routeId, pendingMessageIds: new Set(), drained: false })
        } catch (error) {
            this.options.logger.summary('准备本轮记忆上下文失败', key, 'warn', error)
        }
    }

    private async renderInjection({ state, speakerKeys, settings }: TurnInput): Promise<ChatMessage | undefined> {
        const { scope } = state
        const sections: string[] = []
        if (settings.enableSnapshotInjection) {
            const snapshot = await this.options.repository.getLatestSnapshotByScope(snapshotScopeOf(scope, settings))
            const text = renderSnapshotText(snapshot?.items ?? [])
            if (text.length > 0) sections.push(`<memory>\n${text}\n</memory>`)
        }
        if (settings.enableUserProfileInjection) {
            const profiles = await this.options.userProfiles.renderForSpeakers(scope.presetId, speakerKeys)
            if (profiles.trim().length > 0) sections.push(`<users_profile>\n${profiles.trim()}\n</users_profile>`)
        }
        if (sections.length === 0) return undefined
        const text = sections.join('\n\n')
        this.options.logger.diagnosticSummary(() => ({
            event: '记忆注入',
            detail: `${formatLogScope(scope)}; 注入长度：${text.length} 字符`
        }))
        return ChatMessage.notice('chatluna:livingmemory', text)
    }

    private changeScope(key: string, sessionId: string, presetId: string | undefined, sessionChanged: boolean) {
        const existing = this.conversations.get(key)
        if (!sessionChanged && existing?.scope.sessionId === sessionId && existing.scope.presetId === presetId) return
        const boundary = this.options.history.lastPosition(key)
        // 首次确定预设时保留已入队的发言人；切换或清除已有归属时才使窗口失效。
        if (existing || sessionChanged || presetId === undefined) this.reset(key, sessionChanged ? boundary : undefined)
        if (presetId !== undefined) this.stateOf(key, sessionId, presetId, boundary)
    }

    reset(conversationId: string, contextStart = this.revisions.get(conversationId)?.contextStart ?? -1) {
        this.revisions.set(conversationId, { contextStart })
        this.conversations.delete(conversationId)
        this.options.recall.clearByConversation(conversationId)
        this.options.extraction.clearByConversation(conversationId)
    }

    private stateOf(key: string, sessionId: string, presetId: string, boundary: number): ConversationState {
        const scope = this.options.history.scopeOf(key, sessionId, presetId)
        scope.presetLabel = resolvePresetAssistantLabel(this.ctx, presetId)
        const existing = this.conversations.get(key)
        if (existing?.scope.sessionId === sessionId && existing.scope.presetId === presetId) {
            if (existing.scope.platform === undefined) Object.assign(existing.scope, scope)
            else existing.scope.presetLabel = scope.presetLabel
            return existing
        }
        if (existing !== undefined) this.reset(scope.conversationId)
        const state: ConversationState = { scope, boundary, deliveries: new Map() }
        this.conversations.set(scope.conversationId, state)
        return state
    }

    private async onObservedChat(event: ObservedEvent) {
        const key = event.conversationKey
        const settings = this.options.settingsOf(key, undefined, event.message.routeId)
        const position = this.options.history.locate(key, event.message)
        if (position === undefined) return
        const revision = this.revisions.get(key)
        const current = await this.ctx.conversations.current(key)
        if (!this.active || this.revisions.get(key) !== revision || !current ||
            (event.sessionId !== undefined && current.sessionId !== event.sessionId)) return
        const sessionId = String(current.sessionId)
        let state = this.conversations.get(key)
        if (!state || state.scope.sessionId !== sessionId) {
            const agent = this.ctx.conversations.live(key)?.agent
            const livePreset = agent?.session.id === current.sessionId ? this.agentPreset(agent) : undefined
            const presetId = livePreset ?? current.presetId
            if (!presetId) return
            state = this.stateOf(key, sessionId, presetId, position - 1)
        }
        if (position > state.boundary && settings.extractionIncludeOverheard) await this.queueExtraction(state, settings, position, event.message.routeId)
    }

    private async onObservedReply(event: ObservedEvent) {
        const key = event.conversationKey
        const state = this.conversations.get(key)
        if (!state) return
        const { id, routeId } = event.message
        for (const [turn, delivery] of state.deliveries) {
            if (!delivery.pendingMessageIds.delete(id)) continue
            const position = this.options.history.locate(key, event.message, state.scope)
            if (delivery.lastReply?.id === id) delivery.lastReply.position = position
            // 提取消费历史中的所有回复段，包括在最后一段之后才写入历史的回执。
            if (!delivery.settings.extractionIncludeOverheard && position !== undefined &&
                (!delivery.extractionEnd || position > delivery.extractionEnd.position)) {
                delivery.extractionEnd = { position, routeId }
            }
            await Promise.all([
                this.finishDeliveryIfReady(state, turn, delivery),
                delivery.settings.extractionIncludeOverheard && position !== undefined
                    ? this.queueExtraction(state, delivery.settings, position, routeId)
                    : undefined
            ])
            return
        }
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
        await this.finishDeliveryIfReady(state, turn, delivery)
    }

    private async finishDeliveryIfReady(state: ConversationState, turn: number, delivery: Delivery) {
        if (!delivery.drained || delivery.pendingMessageIds.size > 0) return
        state.deliveries.delete(turn)
        const { settings, extractionEnd } = delivery
        await Promise.all([
            this.queueRecall(state, delivery),
            extractionEnd && this.queueExtraction(state, settings, extractionEnd.position, extractionEnd.routeId)
        ])
    }

    private async queueRecall(state: ConversationState, delivery: Delivery) {
        const { lastReply } = delivery
        if (lastReply?.position === undefined || lastReply.position <= state.boundary) return
        const { position, routeId } = lastReply
        const { scope } = state
        const key = scope.conversationId
        const settings = isCustomConversation(key) && delivery.routeId !== routeId
            ? this.options.settingsOf(key, undefined, routeId)
            : delivery.settings
        if (settings.recallIntervalMessages === 0) return
        const rows = this.recentChat(key, settings, position, routeId)
        if (rows.at(-1)?.position !== position) return
        const history = toHistoryTranscriptMessages(scope, rows)
        await this.options.recall.queue(settings, scope, history, position, routeId)
    }

    private async queueExtraction(state: ConversationState, settings: RouteSettings, eligiblePosition: number, routeId: string) {
        if (settings.extractionWindowMessages === 0) return
        await this.options.extraction.queue(state.scope, {
            routeId: isCustomConversation(state.scope.conversationId) ? routeId : undefined,
            includeOverheard: settings.extractionIncludeOverheard,
            windowMessages: settings.extractionWindowMessages,
            enableAutoDream: settings.enableAutoDream,
            formatTranscriptHeader: entries => formatTranscriptHeader(this.ctx, entries)
        }, state.boundary, eligiblePosition)
    }

    private logScheduleError(conversationId: string, error: unknown) {
        this.options.logger.summary('记忆任务调度失败', `会话：${conversationId}`, 'warn', error)
    }
}

type Wake = NonNullable<ChatMessageMeta['wake']>
type TurnTrigger =
    | { kind: 'notice'; wake: Wake }
    | { kind: 'chat'; id: string; externalId?: string; routeId?: string; wake?: Wake }

function findTurnTrigger(messages: readonly ChatMessage[]): TurnTrigger | undefined {
    let firstChat: TurnTrigger | undefined
    for (const message of messages) {
        for (const input of turnInputs(message)) {
            if (input.wake) return input
            firstChat ??= input
        }
    }
    return firstChat
}

/** 合批后仍按原消息的 ID 和唤醒标记确定历史截止位置。 */
function* turnInputs(message: ChatMessage): Iterable<TurnTrigger> {
    const { form, meta, source } = message
    if (form === 'notice') {
        if (meta?.wake) yield { kind: 'notice', wake: meta.wake }
        return
    }
    if (message.role !== 'user' || source.kind !== 'user' || form === 'snapshot') return
    if (meta && 'backfill' in meta && meta.backfill) return

    const envelopes = message.content.filter(block => block.type === 'envelope')
    if (!envelopes.length) {
        if (source.routeId !== undefined || meta?.externalId !== undefined) {
            yield { kind: 'chat', id: String(message.id), externalId: meta?.externalId, routeId: source.routeId, wake: meta?.wake }
        }
        return
    }

    for (const { kind, id, externalId, sender, wake } of envelopes) {
        if (kind === 'notice') {
            if (wake) yield { kind, wake }
        } else if (!sender?.self) {
            // 外层 source 属于最后一条消息；这里按原消息查 observer 中的路由。
            yield { kind: 'chat', id, externalId, wake }
        }
    }
}
