import type { RouteSettings } from '../../../routing.ts'
import type { Context } from 'cordis'
import type {
    AgenticMemorySearchToolCallSummary,
    AgenticMemorySnapshotItem,
    AgenticMemorySnapshotMemoryItem,
    LivingMemorySearchResult,
    MemoryScope
} from '../../../contracts/memory.ts'
import type { LivingMemoryConfig } from '../../../contracts/workflows.ts'
import { formatLogScope, type LivingMemoryLogger } from '../../logging/logger.ts'
import { MemoryInputError } from '../../memory/errors.ts'
import { resolveScopeAssistantLabel } from '../../memory/helpers.ts'
import { contextMemoryFields, renderMemoriesForModel } from '../../prompts/memory_entries.ts'
import {
    memoryPassTool,
    memorySearchTool,
    memoryUpdateSnapshotTool,
    snapshotMaxLineLength
} from '../../prompts/memory_tools.ts'
import { buildSnapshotRecallPrompts } from '../../prompts/agentic_recall.ts'
import type { LivingMemoryLoopTool } from '../tool_call.ts'
import { LivingMemoryToolLoop } from '../tool_loop.ts'
import type { LivingMemorySearchEngine } from './memory_search_engine.ts'

type RecallModels = Pick<LivingMemoryConfig, 'subModel' | 'memorySearchToolMaxResults'>
type RecallRule = Pick<RouteSettings, 'snapshotMaxLines' | 'enableConversationIsolation'>
type LivingMemoryAgenticRecallConfig = RecallModels & RecallRule

interface SearchArgs {
    searchTexts: string[]
    searchKeywords?: string[]
}

type SnapshotOperation =
    | { type: 'append'; text: string }
    | { type: 'replace'; line: number; text: string }
    | { type: 'delete'; line: number }

interface RecordedAgenticSearchCall {
    searchTexts: string[]
    searchKeywords: string[]
    results: LivingMemorySearchResult[]
}

/** 与 v1 一致：单次召回的模型调用上限。 */
const agenticRecallMaxModelCalls = 6

const noMemoryFoundMessage = '没有找到相关记忆。'

const aggregateToolCallSummary = (
    calls: RecordedAgenticSearchCall[],
    maxCandidates: number
): AgenticMemorySearchToolCallSummary => ({
    searchTexts: [...new Set(calls.flatMap((call) => call.searchTexts))],
    searchKeywords: [...new Set(calls.flatMap((call) => call.searchKeywords))],
    maxCandidates
})

const toSnapshotMemoryItem = (
    result: LivingMemorySearchResult
): AgenticMemorySnapshotMemoryItem => ({
    type: result.type,
    content: result.content,
    keywords: [...result.keywords],
    summary: result.summary,
    sentiment: result.sentiment,
    importance: result.importance,
    createdAt: result.createdAt,
    updatedAt: result.updatedAt
})

const uniqueSnapshotMemoryItems = (
    results: LivingMemorySearchResult[]
): AgenticMemorySnapshotMemoryItem[] => {
    const seen = new Set<string>()
    const items: AgenticMemorySnapshotMemoryItem[] = []
    for (const result of results) {
        if (seen.has(result.id)) {
            continue
        }
        seen.add(result.id)
        items.push(toSnapshotMemoryItem(result))
    }
    return items
}

/**
 * 按 v1 语义把按行编辑应用到旧快照：行号指向同一份基线，删除不改变其余
 * 原行编号，追加按提交顺序接在末尾。全部校验通过后才返回最终文本。
 */
const applySnapshotOperations = (
    operations: readonly SnapshotOperation[],
    lines: readonly string[],
    maxLines: number
): string => {
    const changes = new Map<number, string | null>()
    const additions: string[] = []

    for (const operation of operations) {
        if (operation.type === 'append') {
            additions.push(operation.text)
            continue
        }
        const { line } = operation
        if (line >= lines.length) {
            throw new MemoryInputError(`行号 ${line} 超出旧快照的 ${lines.length} 行范围。`)
        }
        if (changes.has(line)) {
            throw new MemoryInputError(`第 ${line} 行存在重复操作，请为该行提交一个操作。`)
        }
        changes.set(line, operation.type === 'delete' ? null : operation.text)
    }

    const updatedLines = lines.flatMap((text, index) => {
        const change = changes.get(index)
        return change === null ? [] : [change ?? text]
    })
    const finalLines = [...updatedLines, ...additions]
    if (finalLines.length > maxLines) {
        throw new MemoryInputError(
            `编辑后的快照共 ${finalLines.length} 行，上限为 ${maxLines} 行，请删减后重新提交。`
        )
    }
    // 新提交的文本已由工具 schema 校验，这里只检查原样保留的旧行。
    const oversizedLines = lines.flatMap((text, index) =>
        !changes.has(index) && text.length > snapshotMaxLineLength ? [index] : []
    )
    if (oversizedLines.length > 0) {
        throw new MemoryInputError(
            `旧快照行号 ${oversizedLines.join('、')} 的内容超过 ${snapshotMaxLineLength} 个字符，请缩短或删除这些行后重新提交。`
        )
    }
    return finalLines.join('\n')
}

/**
 * 召回用的三个工具：检索、提交快照、跳过。作用域与旧快照由闭包带入，
 * 与 v1 按实例构造工具的结构一致。
 */
export const createRecallTools = (options: {
    searchEngine: Pick<LivingMemorySearchEngine, 'searchMemories'>
    config: LivingMemoryAgenticRecallConfig
    scope: MemoryScope
    snapshotLines: readonly string[]
    recordedSearchCalls: RecordedAgenticSearchCall[]
    saveSnapshot: (item: AgenticMemorySnapshotItem) => Promise<void>
}): LivingMemoryLoopTool[] => {
    const { searchEngine, config, scope, snapshotLines, recordedSearchCalls } = options

    return [
        {
            name: memorySearchTool.name,
            description: memorySearchTool.description,
            args: memorySearchTool.schema,
            async run(input: SearchArgs) {
                const conversationId = config.enableConversationIsolation
                    ? scope.conversationId
                    : undefined
                const results = await searchEngine.searchMemories(
                    scope.presetId,
                    { ...input, memoryTypes: ['all'], memoryStatus: 'active' },
                    conversationId
                )
                recordedSearchCalls.push({
                    searchTexts: input.searchTexts,
                    searchKeywords: input.searchKeywords ?? [],
                    results
                })
                return results.length === 0
                    ? noMemoryFoundMessage
                    : renderMemoriesForModel(results, { fields: contextMemoryFields })
            }
        },
        {
            name: memoryUpdateSnapshotTool.name,
            description: [
                memoryUpdateSnapshotTool.description,
                `编辑后的快照最多 ${config.snapshotMaxLines} 行，每行最多 ${snapshotMaxLineLength} 个字符。`
            ].join('\n'),
            args: memoryUpdateSnapshotTool.schema,
            async run(input: { operations: SnapshotOperation[] }) {
                const finalText = applySnapshotOperations(
                    input.operations,
                    snapshotLines,
                    config.snapshotMaxLines
                )
                const item: AgenticMemorySnapshotItem = {
                    finalText,
                    toolCallSummary: aggregateToolCallSummary(
                        recordedSearchCalls,
                        config.memorySearchToolMaxResults
                    ),
                    matchedMemories: uniqueSnapshotMemoryItems(
                        recordedSearchCalls.flatMap((call) => call.results)
                    )
                }
                await options.saveSnapshot(item)
                return { updated: true }
            }
        },
        {
            name: memoryPassTool.name,
            description: memoryPassTool.description,
            args: memoryPassTool.schema,
            run: async () => ({ updated: false })
        }
    ]
}

export class LivingMemoryAgenticRecallExecutor {
    constructor(
        private readonly ctx: Context,
        private readonly config: RecallModels,
        private readonly searchEngine: LivingMemorySearchEngine,
        private readonly logger: LivingMemoryLogger
    ) {}

    async run(
        rules: RecallRule,
        scope: MemoryScope,
        chatHistory: string,
        snapshotLines: readonly string[],
        saveSnapshot: (item: AgenticMemorySnapshotItem) => Promise<void>,
        runLogger: LivingMemoryLogger = this.logger,
        signal?: AbortSignal
    ): Promise<AgenticMemorySnapshotItem | null> {
        signal?.throwIfAborted()
        const prompt = buildSnapshotRecallPrompts({
            assistantLabel: resolveScopeAssistantLabel(scope),
            chatHistory,
            snapshotLines,
            snapshotMaxLines: rules.snapshotMaxLines
        })
        const recordedSearchCalls: RecordedAgenticSearchCall[] = []
        let savedSnapshot: AgenticMemorySnapshotItem | null = null

        const loop = new LivingMemoryToolLoop({
            ctx: this.ctx,
            model: this.config.subModel,
            system: prompt.systemPrompt,
            input: prompt.inputPrompt,
            tools: createRecallTools({
                searchEngine: this.searchEngine,
                config: { ...this.config, ...rules },
                scope,
                snapshotLines,
                recordedSearchCalls,
                saveSnapshot: async (item) => {
                    await saveSnapshot(item)
                    savedSnapshot = item
                }
            }),
            logger: runLogger,
            stage: 'recall',
            ...(signal === undefined ? {} : { signal })
        })
        const modelCalls = await loop.runUntilConclusion({
            maxModelCalls: agenticRecallMaxModelCalls,
            conclusiveTools: [memoryPassTool.name, memoryUpdateSnapshotTool.name]
        })
        runLogger.diagnosticSummary((fields) => ({
            event: '召回模型调用结束',
            detail: `${formatLogScope(fields)}; 模型调用：${modelCalls} 次; 检索调用：${recordedSearchCalls.length} 次`
        }))
        return savedSnapshot
    }
}
