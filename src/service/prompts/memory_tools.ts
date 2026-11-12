import { Schema } from '@chatluna/schema'
import { generatedMemorySchema, optionalText, requiredText } from './schema.ts'

const memorySearchMaxTextCount = 3
const memorySearchMaxKeywordCount = 3
export const snapshotMaxLineLength = 100

/** 提供给模型的工具名称、用途与参数。 */
export interface LivingMemoryToolDoc<T = any> {
    name: string
    description: string
    schema: Schema<T>
}

const snapshotLineSchema = requiredText(
    `一条完整的记忆内容，使用单行文本，最多 ${snapshotMaxLineLength} 个字符。`
)

export const memoryPassTool: LivingMemoryToolDoc = {
    name: 'living_memory_pass',
    description:
        '记忆快照更新跳过工具，当你认为旧快照已经足够应付未来聊天话题，不需要更新时，使用此工具。',
    schema: Schema.object({})
}

export const memoryUpdateSnapshotTool: LivingMemoryToolDoc = {
    name: 'living_memory_update_snapshot',
    description: '根据接下来的聊天话题更新快照；在一次调用中提交所有按行编辑操作。',
    schema: Schema.object({
        operations: Schema.array(
            Schema.union([
                Schema.object({
                    type: Schema.const('append').required().description('在末尾追加一行'),
                    text: snapshotLineSchema
                }),
                Schema.object({
                    type: Schema.const('replace').required().description('替换指定行的内容'),
                    line: Schema.natural().required().description('旧快照中的行号，从 0 开始'),
                    text: snapshotLineSchema
                }),
                Schema.object({
                    type: Schema.const('delete').required().description('删除指定行'),
                    line: Schema.natural().required().description('旧快照中的行号，从 0 开始')
                })
            ])
        )
            .min(1)
            .required()
            .description('所有按行编辑操作，每行最多可操作一次；追加内容按提交顺序排列。')
    })
}

export const memorySearchTool: LivingMemoryToolDoc = {
    name: 'living_memory_search',
    description: '在长期记忆库中检索相关记忆，结果按相关度从高到低排列。',
    schema: Schema.object({
        searchTexts: Schema.array(requiredText('用于语义检索的短句。'))
            .min(1)
            .max(memorySearchMaxTextCount)
            .required()
            .description(
                '用于语义检索的短句，必须有完整的句子结构（如主谓宾、人物+动作+场景、主语+的+形容词等）；使用第一人称的自然语言描述；每个短句的语义主题唯一。'
            ),
        searchKeywords: Schema.array(requiredText('用于准确匹配的关键词。'))
            .max(memorySearchMaxKeywordCount)
            .description(
                '用于准确匹配的关键词，必须是具体的事物、活动、地点等实体名称或专有名词；避免以用户名作为关键词进行查询。'
            )
    })
}

export const memoryGetMessagesTool: LivingMemoryToolDoc = {
    name: 'living_memory_get_messages',
    description: '查看一条长期记忆的原始消息。使用已知的记忆 ID，或先调用 living_memory_search 查询。',
    schema: Schema.object({
        memoryId: requiredText('要获取原始消息的记忆 ID。')
    })
}

export const memoryCreateTool = (maxMemories: number): LivingMemoryToolDoc => ({
    name: 'living_memory_create_memory',
    description: '在被明确要求记录信息，或发现值得长期记住的内容时，创建长期记忆。',
    schema: Schema.object({
        memories: Schema.array(generatedMemorySchema)
            .min(1)
            .max(maxMemories)
            .required()
            .description('要创建的记忆对象，内容根据当前上下文决定。')
    })
})

export const memoryUpdateTool: LivingMemoryToolDoc = {
    name: 'living_memory_update_memory',
    description: '记忆过时、需要补充或与已知事实冲突时，使用上下文中的记忆 ID，提交完整的新内容替换原记忆。',
    schema: Schema.object({
        memoryId: requiredText('要更新的记忆 ID'),
        memory: generatedMemorySchema.required()
    })
}

export const memoryMergeTool: LivingMemoryToolDoc = {
    name: 'living_memory_merge_memories',
    description: '记忆描述同一事件、关系、概念或偏好，且重复或互补时，使用上下文中的记忆 ID，将它们合并为一条完整的新记忆。',
    schema: Schema.object({
        sourceMemoryIds: Schema.array(requiredText('要被合并的记忆 ID'))
            .min(2)
            .required()
            .description('要被合并的记忆 ID'),
        memory: generatedMemorySchema.required()
    })
}

export const memorySplitTool: LivingMemoryToolDoc = {
    name: 'living_memory_split_memory',
    description: '记忆包含多个主题时，使用上下文中的记忆 ID 拆分它；每条新记忆只保留一个主题，并完整保留原有重要信息。',
    schema: Schema.object({
        sourceMemoryId: requiredText('要拆分的记忆 ID'),
        memories: Schema.array(generatedMemorySchema)
            .min(2)
            .required()
            .description('拆分后的新记忆')
    })
}

export const memoryDeleteTool: LivingMemoryToolDoc = {
    name: 'living_memory_delete_memory',
    description: [
        '长期记忆删除工具，当你需要删除某条记忆时使用此工具；使用当前上下文已提供的记忆 ID。',
        '你应该在某条记忆与其他记忆内容重复、存在冲突或是过时时删除它；一般选择时间上更旧的记忆删除。',
        '参数约束：',
        '- memoryId：要删除的记忆 ID。'
    ].join('\n'),
    schema: Schema.object({
        memoryId: requiredText('要删除的记忆 ID')
    })
}

export const memoryCheckedTool: LivingMemoryToolDoc = {
    name: 'living_memory_checked_memory',
    description: '确认这些长期记忆已经检查，无需变更。',
    schema: Schema.object({
        memoryIds: Schema.array(requiredText('已检查且无需变更的记忆 ID'))
            .min(1)
            .required()
            .description('已检查且无需变更的记忆 ID, 允许批量输入'),
        reason: requiredText('记忆无需变更的理由')
    })
}

export const extractionResultTool = {
    name: 'living_memory_extraction_result',
    description: '提交本次从聊天记录中提取的长期记忆。',
    schema: Schema.object({
        memories: Schema.array(generatedMemorySchema)
            .required()
            .description('本次提取的长期记忆；提取数量为零时提交空数组。'),
        reason: requiredText('提取这些记忆/不提取记忆的简短原因。')
    })
} satisfies LivingMemoryToolDoc

export const userProfileResultTool = {
    name: 'living_memory_user_profile_result',
    description: '提交人物画像的更新或保留结果。',
    schema: Schema.object({
        action: Schema.union(['update', 'keep'])
            .required()
            .description('update 表示生成或更新人物画像；keep 表示保留已有画像'),
        content: optionalText(
            '完整的新人物画像正文，长度不超过 300 个字符；action 为 update 时必须填写，keep 时可省略'
        ),
        reason: requiredText('更新或保留人物画像的简短原因')
    })
} satisfies LivingMemoryToolDoc

export const personaCardResultTool = {
    name: 'living_memory_persona_card_result',
    description: '提交应从预设人设卡片中删除的行号。',
    schema: Schema.object({
        deletedLineNumbers: Schema.array(Schema.natural())
            .required()
            .description('要删除的行号列表，编号从 0 开始；保留全部内容时提交空数组。')
    })
} satisfies LivingMemoryToolDoc
