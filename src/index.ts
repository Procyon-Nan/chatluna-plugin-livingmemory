import type { Context } from 'cordis'
import Schema from 'schemastery'
import { modelAddressSchema } from '@chatluna/schema'
import type {} from '@chatluna/memory'
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
    'memory',
    'database',
    'chat_observer',
    'agents',
    'chat',
    'conversations'
] as const

export type Config = LivingMemoryConfig

/** 模型项的取值沿用 v1：`无` 表示未配置，工作流据此跳过。 */
const modelField = (description: string, modality: string) =>
    modelAddressSchema({ description, default: '无', modality, roles: true })

/**
 * 配置分五组，与 v1 一致。默认值全部来自 `DEFAULT_CONFIG`，schema 只负责
 * 界面语义与取值范围，避免两处默认值漂移。
 */
export const Config: Schema<Config> = Schema.intersect([
    Schema.object({
        enableSnapshotInjection: Schema.boolean()
            .description('开启记忆快照注入。')
            .default(DEFAULT_CONFIG.enableSnapshotInjection),
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
        enableUserProfileInjection: Schema.boolean()
            .description('开启用户画像注入。')
            .default(DEFAULT_CONFIG.enableUserProfileInjection),
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
    }).description('用户画像配置'),
    Schema.object({
        enableConversationIsolation: Schema.boolean()
            .description(
                '自动召回与 living_memory_search 只检索当前会话产生的记忆与全局记忆。'
            )
            .default(DEFAULT_CONFIG.enableConversationIsolation),
        recallIntervalMessages: Schema.number()
            .min(0)
            .max(200)
            .step(1)
            .description(
                '每累计该条数的新消息（含 bot 未回复的闲聊）自动召回一次记忆，会话首次对话时立即召回。设为 0 时关闭自动召回。'
            )
            .default(DEFAULT_CONFIG.recallIntervalMessages),
        recallHistoryMessages: Schema.number()
            .min(1)
            .max(200)
            .step(1)
            .description('每次召回取最近该条数的消息作为上下文。')
            .default(DEFAULT_CONFIG.recallHistoryMessages),
        snapshotMaxLines: Schema.number()
            .min(5)
            .max(50)
            .step(1)
            .description('记忆快照的最大行数。')
            .default(DEFAULT_CONFIG.snapshotMaxLines)
    }).description('记忆召回配置'),
    Schema.object({
        extractionWindowMessages: Schema.number()
            .min(0)
            .max(360)
            .step(1)
            .description(
                '未提取的消息累计达到该条数时自动提取一次记忆。设为 0 时关闭自动提取。'
            )
            .default(DEFAULT_CONFIG.extractionWindowMessages),
        enableAutoDream: Schema.boolean()
            .description('自动提取保存新记忆后，检索近邻并通过 Dream 整理。')
            .default(DEFAULT_CONFIG.enableAutoDream),
        extractionIncludeOverheard: Schema.boolean()
            .description(
                '旁听提取：控制 bot 未参与的闲聊是否计入记忆提取。每次对话及其前方一个提取窗口内的消息总是提取；开启后窗口之外的闲聊也一并提取，关闭时丢弃。'
            )
            .default(DEFAULT_CONFIG.extractionIncludeOverheard),
        enableExtractionWhitelist: Schema.boolean()
            .description('只对白名单内的会话自动提取记忆。')
            .default(DEFAULT_CONFIG.enableExtractionWhitelist),
        extractionWhitelist: Schema.array(Schema.string())
            .role('table')
            .description('自动提取白名单：群聊填群号，私聊填对方用户号。')
            .default(DEFAULT_CONFIG.extractionWhitelist)
    }).description('记忆提取配置')
])

export async function apply(ctx: Context, config: Config = DEFAULT_CONFIG) {
    const service = new LivingmemoryService(ctx, config)
    ctx.effect(() => service.start())
    ctx.logger.info('livingmemory loaded')
}
