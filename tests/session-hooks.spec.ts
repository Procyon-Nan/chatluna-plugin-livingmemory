import assert from 'node:assert/strict'
import type { Context } from 'cordis'
import type { Agent } from '@chatluna/agent'
import type { ChatObserverService } from '@chatluna/chat-observer'
import { ChatMessage, contentText } from '@chatluna/message'
import { MessageCollector } from '../src/service/message_collector.ts'
import { LivingMemorySessionHooks } from '../src/service/session_hooks.ts'
import { createCapturedLogger } from './workflow-test-utils.ts'
import type { ConversationLogEntryInput } from '../src/service/transcript/message_log/types.ts'
import type { LivingMemoryTranscriptMessage, MemoryScope } from '../src/contracts/memory.ts'
import type { MemorySnapshotRecord } from '../src/contracts/memory.ts'

type PrepareStep = (input: {
    agent: Agent
    stepNumber: number
    steps: readonly unknown[]
}) => Promise<{ contribute?: readonly ChatMessage[] } | undefined>

interface SessionHooksHarness {
    hooks: LivingMemorySessionHooks
    prepare: PrepareStep
    turn: (agent: Agent) => void
    setSnapshot: (text: string) => void
    recallCalls: {
        scope: MemoryScope
        current: LivingMemoryTranscriptMessage
        history: () => Promise<LivingMemoryTranscriptMessage[]>
    }[]
    extractionCalls: {
        scope: MemoryScope
        includeOverheard: boolean
        origin: () => Promise<{ header: string; sourceLabel: string }>
    }[]
    observed: (input: { id: string; userId?: string; text: string }) => void
    agentOf: (input?: { presetId?: string; sessionId?: string; reply?: string }) => Agent
    guildName?: string
}

const createHarness = (
    config: Partial<{
        enableSnapshotInjection: boolean
        enableUserProfileInjection: boolean
        recallIntervalMessages: number
        recallHistoryMessages: number
        extractionWindowMessages: number
        extractionIncludeOverheard: boolean
    }> = {}
): SessionHooksHarness => {
    const prepared: PrepareStep[] = []
    const turnListeners: ((payload: { agent: Agent; reason: string }) => void)[] = []
    const captured = createCapturedLogger(false)
    const recallCalls: SessionHooksHarness['recallCalls'] = []
    const extractionCalls: SessionHooksHarness['extractionCalls'] = []
    const buffers = new Map<string, any[]>()
    let snapshotText = ''

    const harness: SessionHooksHarness = {
        hooks: null as never,
        prepare: async () => undefined,
        turn: (agent) => {
            for (const listener of turnListeners) listener({ agent, reason: 'completed' })
        },
        setSnapshot: (text) => {
            snapshotText = text
        },
        recallCalls,
        extractionCalls,
        observed: ({ id, userId, text }) => {
            const list = buffers.get('conv-1') ?? []
            list.push({
                id: `obs:${id}`,
                cid: 'cid',
                routeId: 'route-1',
                platformMessageId: id,
                time: Date.now(),
                userId: userId ?? 'user-1',
                name: '用户A',
                self: false,
                backfilled: false,
                content: [{ type: 'text', text }]
            })
            buffers.set('conv-1', list)
        },
        agentOf: ({ presetId, sessionId, reply } = {}) => {
            const messages =
                reply === undefined
                    ? []
                    : [ChatMessage.assistant(reply, { provider: 'test', model: 'test' })]
            return {
                options: {
                    config: { provider: 'test', model: 'test' },
                    conversationKey: 'conv-1',
                    presetId: presetId ?? 'preset-1',
                    location: { platform: 'onebot', selfId: 'bot-1', isDirect: false, guild: 'guild-1' }
                },
                session: { id: sessionId ?? 'session-1', messages: () => messages }
            } as unknown as Agent
        }
    }

    const observer = {
        recentOfConversation: (key: string, limit: number) =>
            (buffers.get(key) ?? []).slice(-limit),
        identityOfConversation: () => ({
            platform: 'onebot',
            selfId: 'bot-1',
            isDirect: false,
            guildId: 'guild-1',
            channelId: 'channel-1',
            userId: 'user-1'
        })
    } as unknown as Pick<ChatObserverService, 'recentOfConversation' | 'identityOfConversation'>

    const ctx = {
        agents: {
            prepareStep: (fn: PrepareStep) => {
                prepared.push(fn)
                harness.prepare = fn
                return () => {}
            }
        },
        on: (_name: string, listener: (payload: { agent: Agent; reason: string }) => void) => {
            turnListeners.push(listener)
            return () => {}
        },
        chat: {
            environmentOf: () =>
                harness.guildName === undefined ? undefined : { guildName: harness.guildName }
        }
    } as unknown as Context

    const snapshot = (): MemorySnapshotRecord | undefined =>
        snapshotText === ''
            ? undefined
            : {
                  id: 'snapshot-1',
                  presetId: 'preset-1',
                  conversationId: 'conv-1',
                  query: '',
                  items: [
                      {
                          finalText: snapshotText,
                          toolCallSummary: {
                              searchTexts: [],
                              searchKeywords: [],
                              maxCandidates: 0
                          },
                          matchedMemories: []
                      }
                  ],
                  createdAt: new Date()
              }

    harness.hooks = new LivingMemorySessionHooks(ctx, {
        collector: new MessageCollector(observer),
        recall: {
            queue: async (
                scope: MemoryScope,
                current: LivingMemoryTranscriptMessage,
                history: () => Promise<LivingMemoryTranscriptMessage[]>
            ) => {
                recallCalls.push({ scope, current, history })
            }
        } as never,
        extraction: {
            queue: async (
                scope: MemoryScope,
                options: {
                    includeOverheard: boolean
                    resolveTranscriptOrigin: () => Promise<{
                        header: string
                        sourceLabel: string
                    }>
                }
            ) => {
                extractionCalls.push({
                    scope,
                    includeOverheard: options.includeOverheard,
                    origin: options.resolveTranscriptOrigin
                })
            }
        } as never,
        userProfiles: {
            renderForSpeakers: async () => ''
        } as never,
        repository: {
            getLatestSnapshotByScope: async () => snapshot()
        },
        logger: captured.logger,
        config: {
            enableSnapshotInjection: config.enableSnapshotInjection ?? true,
            enableUserProfileInjection: config.enableUserProfileInjection ?? false,
            recallIntervalMessages: config.recallIntervalMessages ?? 10,
            recallHistoryMessages: config.recallHistoryMessages ?? 20,
            extractionWindowMessages: config.extractionWindowMessages ?? 30,
            extractionIncludeOverheard: config.extractionIncludeOverheard ?? false
        }
    })
    harness.hooks.register()
    return harness
}

describe('LivingMemorySessionHooks', () => {
    it('injects nothing on the first step when no snapshot exists', async () => {
        const harness = createHarness()
        harness.observed({ id: 'm-1', text: '问' })

        const patch = await harness.prepare({
            agent: harness.agentOf(),
            stepNumber: 1,
            steps: []
        })

        assert.equal(patch, undefined)
    })

    it('contributes the snapshot on the first step only', async () => {
        const harness = createHarness()
        harness.observed({ id: 'm-1', text: '问' })
        harness.setSnapshot('用户喜欢红茶')

        const agent = harness.agentOf()
        const first = await harness.prepare({ agent, stepNumber: 1, steps: [] })
        const second = await harness.prepare({ agent, stepNumber: 2, steps: [] })

        assert.equal(first?.contribute?.length, 1)
        assert.match(contentText(first!.contribute![0].content), /用户喜欢红茶/)
        assert.equal(second, undefined)
    })

    it('queues recall with the triggering message and a history loader', async () => {
        const harness = createHarness({ recallIntervalMessages: 1 })
        harness.observed({ id: 'm-1', text: '第一句' })
        harness.observed({ id: 'm-2', text: '第二句' })

        await harness.prepare({ agent: harness.agentOf(), stepNumber: 1, steps: [] })

        assert.equal(harness.recallCalls.length, 1)
        assert.equal(harness.recallCalls[0].current.contentLines.join(''), '第二句')
        const history = await harness.recallCalls[0].history()
        assert.deepEqual(
            history.map((message) => message.contentLines.join('')),
            ['第一句']
        )
    })

    it('leaves recall alone when the interval is disabled', async () => {
        const harness = createHarness({ recallIntervalMessages: 0 })
        harness.observed({ id: 'm-1', text: '问' })

        await harness.prepare({ agent: harness.agentOf(), stepNumber: 1, steps: [] })

        assert.equal(harness.recallCalls.length, 0)
    })

    it('queues extraction after a completed turn', async () => {
        const harness = createHarness()
        harness.observed({ id: 'm-1', text: '问' })

        harness.turn(harness.agentOf({ reply: '答' }))

        assert.equal(harness.extractionCalls.length, 1)
        assert.equal(harness.extractionCalls[0].scope.presetId, 'preset-1')
    })

    it('skips extraction when the window is zero', async () => {
        const harness = createHarness({ extractionWindowMessages: 0 })
        harness.observed({ id: 'm-1', text: '问' })

        harness.turn(harness.agentOf({ reply: '答' }))

        assert.equal(harness.extractionCalls.length, 0)
    })

    it('ignores an agent without a preset', async () => {
        const harness = createHarness()
        harness.observed({ id: 'm-1', text: '问' })
        const agent = {
            options: { config: {}, conversationKey: 'conv-1' },
            session: { id: 'session-1', messages: () => [] }
        } as unknown as Agent

        const patch = await harness.prepare({ agent, stepNumber: 1, steps: [] })
        harness.turn(agent)

        assert.equal(patch, undefined)
        assert.equal(harness.extractionCalls.length, 0)
    })

    it('uses the guild name from the chat environment for the transcript origin', async () => {
        const harness = createHarness()
        harness.guildName = '测试群'
        harness.observed({ id: 'm-1', text: '问' })

        harness.turn(harness.agentOf({ reply: '答' }))
        const origin = await harness.extractionCalls[0].origin()

        assert.equal(origin.header, '以下是你在「测试群」（群聊 ID：guild-1）中的聊天记录：')
    })

    it('falls back to the guild id when the environment has no name', async () => {
        const harness = createHarness()
        harness.observed({ id: 'm-1', text: '问' })

        harness.turn(harness.agentOf({ reply: '答' }))
        const origin = await harness.extractionCalls[0].origin()

        assert.match(origin.header, /群聊 ID：guild-1/)
        assert.match(origin.header, /「guild-1」/)
    })
})