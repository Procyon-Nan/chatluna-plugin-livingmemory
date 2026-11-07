import type { RouteSettings } from '../routing.ts'
import type { Context, Disposable } from 'cordis'
import type { Agent } from '@chatluna/agent'
import type { ObservedEvent } from '@chatluna/chat-observer'
import type {} from '@chatluna/chat'
import type {} from '@chatluna/conversations'
import { ChatMessage, type ChatMessageMeta } from '@chatluna/message'
import type { LivingMemoryTranscriptMessage } from '../contracts/memory.ts'
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
import type { SnapshotRepository } from '../contracts/workflows.ts'

const SNAPSHOT_PLUGIN = 'chatluna:livingmemory'
const RECALL_STEP_ORDER = 870

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
    pendingMessageIds: Set<string>
    lastReplyPosition: number
    drained: boolean
}

interface CapturedWindow {
    readonly settings: RouteSettings
    readonly rows: readonly ChatHistoryEntry[]
    readonly position?: number
    readonly presetId?: string
    readonly contextStart: number
}

type TurnPreparation =
    | { kind: 'ready'; input: TurnInput }
    | { kind: 'awaiting-preset'; window: CapturedWindow }
    | undefined

interface TurnInput {
    state: ConversationState
    settings: RouteSettings
    chatHistory: LivingMemoryTranscriptMessage[]
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
    private readonly queued = new WeakMap<Wake, Promise<TurnPreparation>>()
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
        this.disposables.push(this.ctx.agents.turn(async ({ agent, turn, input }, next) => {
            if (agent.options.engine === undefined) await this.beginTurn(agent, turn, input)
            return next()
        }))
        this.disposables.push(this.ctx.agents.prepareStep(
            ({ agent, stepNumber }) => this.injectFirstStep(agent, stepNumber),
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
            state.deliveries.get(reply.turn)?.pendingMessageIds.add(sent.messageIds[0])
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

    settingsForTurn(agent: object) {
        const running = this.turns.get(agent)
        if (running && this.isCurrent(running)) return running.settings
    }

    private isCurrent({ state }: TurnInput) {
        return this.active && this.conversations.get(state.scope.conversationId) === state
    }

    private async onInputQueued(agent: Agent, message: ChatMessage) {
        const key = agent.options.conversationKey
        if (key === undefined) return
        const trigger = findTurnTrigger([message])
        // 合批可以替换外层消息，原始 wake 保持不变。
        if (!trigger?.wake || this.queued.has(trigger.wake)) return
        const preparation = this.prepareTurn(agent, key, () => {
            const through = trigger.kind === 'notice' ? this.options.history.lastPosition(key) : undefined
            return this.captureWindow(agent, key, trigger, through)
        })
        this.queued.set(trigger.wake, preparation)
        await preparation
    }

    private captureWindow(agent: Agent, key: string, trigger: TurnTrigger | undefined, noticePosition?: number): CapturedWindow {
        const contextStart = this.revisions.get(key)?.contextStart ?? -1
        const position = trigger?.kind === 'chat' ? this.options.history.locateUserPosition(key, trigger, contextStart) : noticePosition
        const routeId = trigger?.kind === 'chat' ? trigger.routeId : undefined
        const noticeSessionId = trigger?.kind === 'notice' ? String(agent.session.id) : undefined
        const settings = this.options.settingsOf(key, agent.options.location, routeId, noticeSessionId)
        const needsHistory = settings.recallIntervalMessages > 0 || settings.enableUserProfileInjection
        const rows = needsHistory && position !== undefined
            ? this.options.history.recent({ conversationId: key }, settings.recallHistoryMessages, position, contextStart)
            : []
        const presetId = this.ctx.get('engines')?.presetOf(agent) ?? agent.options.presetId
        return { rows, settings, position, presetId, contextStart }
    }

    private async prepareTurn(agent: Agent, key: string, getWindow: () => CapturedWindow): Promise<TurnPreparation> {
        try {
            // 入队路径须在第一次 await 前读完窗口；等预设的路径直接使用原窗口。
            const window = getWindow()
            const revision = this.revisions.get(key)
            const head = await this.ctx.conversations.current(key)
            if (!head || String(head.sessionId) !== String(agent.session.id)) return
            if (!this.active || this.revisions.get(key) !== revision || (revision?.contextStart ?? -1) !== window.contextStart) return

            const presetId = this.ctx.get('engines')?.presetOf(agent) ?? agent.options.presetId ?? head.presetId
            if (window.presetId !== undefined && presetId !== window.presetId) return
            if (!presetId) return { kind: 'awaiting-preset', window }
            if (presetId !== head.presetId && this.conversations.get(key)?.scope.presetId !== presetId) return

            const { settings, position } = window
            const boundary = position === undefined ? this.options.history.lastPosition(key) : position - 1
            const scope = this.options.history.scopeOf(key, String(head.sessionId), presetId)
            const state = this.stateOf(scope, boundary)
            const chatHistory = toHistoryTranscriptMessages(state.scope, window.rows)
            if (position !== undefined && settings.recallIntervalMessages > 0) {
                await this.options.recall.queue(settings, state.scope, chatHistory, position)
            }
            return { kind: 'ready', input: { state, settings, chatHistory } }
        } catch (error) {
            this.options.logger.summary('记忆召回调度失败', key, 'warn', error)
            return undefined
        }
    }

    private async beginTurn(agent: Agent, turn: number, messages: readonly ChatMessage[]) {
        if (this.turns.get(agent)?.number === turn) return
        this.turns.delete(agent)
        const key = agent.options.conversationKey
        if (key === undefined) return
        const trigger = findTurnTrigger(messages)
        const queued = trigger?.wake && this.queued.get(trigger.wake)
        let prepared: TurnPreparation
        if (queued) {
            prepared = await queued
            if (prepared?.kind === 'awaiting-preset') {
                const { window } = prepared
                prepared = await this.prepareTurn(agent, key, () => window)
            }
        } else {
            prepared = await this.prepareTurn(agent, key, () => this.captureWindow(agent, key, trigger))
        }
        if (prepared?.kind !== 'ready' || !this.isCurrent(prepared.input)) return
        const { input } = prepared
        this.turns.set(agent, { ...input, number: turn })
        input.state.deliveries.set(turn, {
            settings: input.settings,
            pendingMessageIds: new Set(),
            lastReplyPosition: -1,
            drained: false
        })
    }

    private async injectFirstStep(agent: Agent, stepNumber: number) {
        const running = this.turns.get(agent)
        if (stepNumber !== 1 || !running || !this.isCurrent(running)) return
        running.injection ??= this.renderInjection(running)
        const injection = await running.injection
        if (injection && this.isCurrent(running)) return { contribute: [injection] }
    }

    private async renderInjection({ state, chatHistory, settings }: TurnInput): Promise<ChatMessage | undefined> {
        const { scope } = state
        const sections: string[] = []
        if (settings.enableSnapshotInjection) {
            const snapshot = await this.options.repository.getLatestSnapshotByScope(scope)
            const text = renderSnapshotText(snapshot?.items ?? [])
            if (text.length > 0) sections.push(`## 短期记忆\n${text}`)
        }
        if (settings.enableUserProfileInjection) {
            const speakerKeys = collectUserProfileSpeakerKeys(chatHistory)
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

    private async onObservedChat(event: ObservedEvent) {
        const key = event.conversationKey
        const settings = this.options.settingsOf(key, undefined, event.message.routeId)
        const position = this.options.history.locate(key, event.message)
        if (position === undefined) return
        const revision = this.revisions.get(key)
        const current = await this.ctx.conversations.current(key)
        if (!this.active || this.revisions.get(key) !== revision || !current?.presetId ||
            (event.sessionId !== undefined && current.sessionId !== event.sessionId)) return
        const existing = this.conversations.get(key)
        const state = existing?.scope.sessionId === String(current.sessionId) ? existing
            : this.stateOf(this.options.history.scopeOf(key, String(current.sessionId), current.presetId), position - 1)
        if (position > state.boundary && settings.extractionIncludeOverheard) await this.queueExtraction(state, settings, position)
    }

    private async onObservedReply(event: ObservedEvent) {
        const key = event.conversationKey
        const state = this.conversations.get(key)
        const id = event.message.platformMessageId
        if (!state || id === undefined) return
        for (const [turn, delivery] of state.deliveries) {
            if (!delivery.pendingMessageIds.delete(id)) continue
            const position = this.options.history.locate(key, event.message, state.scope)
            if (position !== undefined) delivery.lastReplyPosition = Math.max(delivery.lastReplyPosition, position)
            if (delivery.settings.extractionIncludeOverheard && position !== undefined) {
                await this.queueExtraction(state, delivery.settings, position)
            }
            await this.finishDeliveryIfReady(state, turn, delivery)
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
        if (!delivery.settings.extractionIncludeOverheard && delivery.lastReplyPosition > state.boundary) {
            await this.queueExtraction(state, delivery.settings, delivery.lastReplyPosition)
        }
    }

    private async queueExtraction(state: ConversationState, settings: RouteSettings, eligiblePosition: number) {
        if (settings.extractionWindowMessages === 0) return
        await this.options.extraction.queue(state.scope, {
            includeOverheard: settings.extractionIncludeOverheard,
            windowMessages: settings.extractionWindowMessages,
            enableAutoDream: settings.enableAutoDream,
            resolveTranscriptOrigin: async () => this.transcriptOrigin(state.scope)
        }, state.boundary, eligiblePosition)
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
    if (message.role !== 'user' || source.kind !== 'user' || form === 'snapshot' || meta?.backfill) return

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
            yield { kind: 'chat', id, externalId, routeId: source.routeId, wake }
        }
    }
}
