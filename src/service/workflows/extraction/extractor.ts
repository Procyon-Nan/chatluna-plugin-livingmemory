import type { Context } from 'cordis'
import { NoModelError } from '@chatluna/ai'
import type {} from '@chatluna/ai-runtime'
import type {} from '@chatluna/ai-runtime/ops'
import type { AttributedMemoryItem } from '../../../contracts/workflows.ts'
import { MemoryInputError } from '../../memory/errors.ts'
import { isModelConfigured } from '../../shared/utils.ts'
import { extractionResultTool } from '../../prompts/memory_tools.ts'
import { buildExtractionPrompts } from '../../prompts/extraction.ts'
import type { PromptMessages } from '../../prompts/prompt_format.ts'
import { normalizeMemoryKeywords } from '../../memory/entry_fields.ts'
import { invokeStructuredOutput } from '../structured_output.ts'
import { resolveScopeAssistantLabel } from '../../memory/helpers.ts'
import { resolveSpeakerKeysByLabels } from '../../memory/speaker_identity.ts'
import type { LivingMemoryLogger } from '../../logging/logger.ts'

export type LivingMemoryExtractionSkipReason =
    | 'model-not-configured'
    | 'model-unavailable'

export interface LivingMemoryExtractionResult {
    extracted: AttributedMemoryItem[]
    prompt: PromptMessages | null
    output: string | null
    skippedReason: LivingMemoryExtractionSkipReason | null
    // 结果工具调用或参数无法通过 Schema 校验时的原因。为 null 表示成功，
    // 包括模型通过工具提交空 memories 数组并说明原因。
    parseError: string | null
}

export interface LivingMemoryExtractionContext {
    presetId: string
    presetLabel?: string
    presetPrompt: string
    speakers: Array<{
        speakerLabel: string
        speakerKey: string
    }>
}

export class LivingMemoryExtractor {
    constructor(
        private readonly ctx: Context,
        private readonly mainModel: string
    ) {}

    async extract(
        input: string,
        context: LivingMemoryExtractionContext,
        logger: LivingMemoryLogger,
        signal?: AbortSignal
    ): Promise<LivingMemoryExtractionResult> {
        signal?.throwIfAborted()
        if (!isModelConfigured(this.mainModel)) {
            return {
                extracted: [],
                prompt: null,
                output: null,
                skippedReason: 'model-not-configured',
                parseError: null
            }
        }

        if (!(await this.isModelAvailable())) {
            return {
                extracted: [],
                prompt: null,
                output: null,
                skippedReason: 'model-unavailable',
                parseError: null
            }
        }

        const prompt = this.buildPrompt(input, context)
        const result = await invokeStructuredOutput({
            ctx: this.ctx,
            model: this.mainModel,
            schema: extractionResultTool.schema,
            systemPrompt: prompt.systemPrompt,
            inputPrompt: prompt.inputPrompt,
            ...(signal === undefined ? {} : { signal }),
            validateResult: ({ memories }) => {
                try {
                    for (const memory of memories) {
                        resolveSpeakerKeysByLabels(
                            memory.speakerLabels,
                            context.speakers
                        )
                    }
                } catch (error) {
                    if (!(error instanceof MemoryInputError)) throw error
                    return error.message
                }
            },
            stringifiedArrayField: 'memories',
            logging: { logger, stage: 'memory-extraction' }
        })
        const extracted =
            result.value?.memories.map((item): AttributedMemoryItem => {
                return {
                    type: item.type,
                    content: item.content,
                    summary: item.summary,
                    keywords: normalizeMemoryKeywords(item.keywords),
                    sentiment: item.sentiment,
                    importance: item.importance,
                    speakerKeys: resolveSpeakerKeysByLabels(
                        item.speakerLabels,
                        context.speakers
                    )
                }
            }) ?? []

        return {
            extracted,
            prompt,
            output: result.output,
            skippedReason: null,
            parseError: result.parseError
        }
    }

    private async isModelAvailable() {
        try {
            await this.ctx.ai.chat(this.mainModel).bind()
            return true
        } catch (error) {
            if (error instanceof NoModelError) return false
            throw error
        }
    }

    private buildPrompt(input: string, context: LivingMemoryExtractionContext) {
        const assistantLabel = resolveScopeAssistantLabel(context)

        return buildExtractionPrompts({
            chatHistory: input,
            assistantLabel,
            presetPrompt: context.presetPrompt
        })
    }
}
