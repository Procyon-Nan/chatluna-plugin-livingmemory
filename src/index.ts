import type { Context } from 'cordis'
import Schema from 'schemastery'
import { modelAddressSchema } from '@chatluna/schema'
import { registerRouteSettings } from './routing.ts'
import type {} from '@chatluna/chat-observer'
import type {} from '@chatluna/agent'
import type {} from '@chatluna/chat'
import type {} from '@chatluna/conversations'
import LivingmemoryService, { DEFAULT_CONFIG } from './service.ts'
import type { LivingMemoryConfig } from './contracts/workflows.ts'

export const name = 'livingmemory'

/**
 * `inject` 是加载前置条件：任一项缺失时 cordis 会把插件置为 INACTIVE、整段
 * `apply` 不执行。聊天历史由 `chat_observer` 提供，会话切换由
 * `conversations` 通知，提取在 `chat` 完成实际回复发送后触发。
 */
export const inject = [
    'chatluna',
    'schemas',
    'routing',
    'database',
    'model',
    'ai',
    'tools',
    'presets',
    'chat_observer',
    'agents',
    'chat',
    'conversations'
] as const

export type Config = LivingMemoryConfig

const modelField = (description: string, modality: string) =>
    modelAddressSchema({ description, default: '无', modality, roles: true })

/**
 * 插件实例配置。默认值来自 `DEFAULT_CONFIG`，schema 只负责
 * 界面语义与取值范围，避免两处默认值漂移。
 */
export const Config: Schema<Config> = Schema.intersect([
    Schema.object({
        debug: Schema.boolean()
            .description(
                '记录召回、提取、Dream 每次模型调用的完整提示词、原始响应与诊断事件。'
            )
            .default(DEFAULT_CONFIG.debug)
    }).description('基础配置'),
    Schema.object({
        mainModel: modelField(
            '主 LLM 模型，用于提取记忆、Dream 与用户画像。',
            'chat'
        ),
        subModel: modelField('子 LLM 模型，用于召回记忆。', 'chat'),
        embeddingModel: modelField(
            '嵌入模型，用于记忆检索与 Dream。',
            'embeddings'
        ),
        rerankModel: modelField('Reranker 模型，用于记忆检索结果重排序。', 'reranker')
    }).description('模型配置'),
    Schema.object({
        memorySearchToolMaxResults: Schema.number()
            .min(1)
            .max(60)
            .step(1)
            .description(
                '每次记忆检索最多返回的记忆条数，召回与 living_memory_search 共用。'
            )
            .default(DEFAULT_CONFIG.memorySearchToolMaxResults),
        memorySearchMinSimilarity: Schema.number()
            .min(0)
            .max(1)
            .step(0.05)
            .description(
                '记忆检索的最低余弦相似度。关键词命中的记忆不受限制；设为 0 表示不限制。'
            )
            .default(DEFAULT_CONFIG.memorySearchMinSimilarity),
        enabledMemoryTools: Schema.array(
            Schema.union([
                Schema.const('living_memory_search').description(
                    '记忆查询工具：通过语义检索查询记忆'
                ),
                Schema.const('living_memory_get_messages').description(
                    '来源查看工具：查看记忆来源的聊天消息'
                ),
                Schema.const('living_memory_create_memory').description(
                    '记忆创建工具：创建新的记忆'
                ),
                Schema.const('living_memory_update_memory').description(
                    '记忆更新工具：更新已有记忆'
                ),
                Schema.const('living_memory_merge_memories').description(
                    '记忆合并工具：将多条记忆合并为一条'
                ),
                Schema.const('living_memory_split_memory').description(
                    '记忆拆分工具：将一条记忆拆分为多条'
                ),
                Schema.const('living_memory_delete_memory').description(
                    '记忆删除工具：归档删除记忆'
                )
            ])
        )
            .role('checkbox')
            .description('选择向 ChatLuna 注册的记忆工具。')
            .default(DEFAULT_CONFIG.enabledMemoryTools),
        memoryCreateToolMaxMemories: Schema.number()
            .min(1)
            .max(60)
            .step(1)
            .description(
                'living_memory_create_memory 单次调用最多创建的记忆条数。'
            )
            .default(DEFAULT_CONFIG.memoryCreateToolMaxMemories)
    }).description('工具配置'),
    Schema.object({
        enableUserProfileGeneration: Schema.boolean()
            .description('进行记忆提取后，生成、更新相关用户画像。')
            .default(DEFAULT_CONFIG.enableUserProfileGeneration),
        enableDreamUserProfileGeneration: Schema.boolean()
            .description('进行 Dream 记忆整理后，生成、更新相关用户画像。')
            .default(DEFAULT_CONFIG.enableDreamUserProfileGeneration),
        userProfileMinMemoryCount: Schema.number()
            .min(1)
            .max(30)
            .step(1)
            .description('生成或更新单个用户画像所需的最少关联活跃记忆条数。')
            .default(DEFAULT_CONFIG.userProfileMinMemoryCount),
        userProfileMemoryLimit: Schema.number()
            .min(5)
            .max(100)
            .step(1)
            .description('生成单个用户画像时可送入模型的相关记忆条数上限。')
            .default(DEFAULT_CONFIG.userProfileMemoryLimit)
    }).description('用户画像配置')
])

export async function apply(ctx: Context, config: Config = DEFAULT_CONFIG) {
    registerRouteSettings(ctx)
    const service = new LivingmemoryService(ctx, config)
    await ctx.effect(() => service.start())
    ctx.logger.info('livingmemory loaded')
}
