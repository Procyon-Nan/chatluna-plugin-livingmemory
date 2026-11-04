import { Schema } from '@chatluna/schema'
import { generatedMemorySchema, memoryFieldDocs, requiredText } from './schema.ts'

const memorySearchMaxTextCount = 3
const memorySearchMaxKeywordCount = 3
export const snapshotMaxLineLength = 100

/**
 * 工具的模型可见契约：名称、描述与参数 schema。
 *
 * v2 的 `schemasteryToJsonSchemaNode` 不输出字段 `description`，因此每个工具
 * 的字段说明都并入 `description`（见 `doc/framework-requirements.md` 第 7 项）。
 * `withParameterDocs` 把参数说明逐项接在工具描述之后。
 */
export interface LivingMemoryToolDoc {
    name: string
    description: string
    schema: Schema
}

const withParameterDocs = (
    description: string[],
    docs: readonly (readonly [string, string])[]
) =>
    [
        ...description,
        '参数约束：',
        ...docs.map(([field, doc]) => `- ${field}：${doc}`)
    ].join('\n')

/** 记忆字段逐项说明，附在使用 `generatedMemorySchema` 的工具描述之后。 */
const memoryFieldDocsText = () =>
    (Object.keys(memoryFieldDocs) as (keyof typeof memoryFieldDocs)[])
        .map((field) => `  - ${field}：${memoryFieldDocs[field]}`)
        .join('\n')

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
    description: withParameterDocs(
        [
            '记忆快照更新工具，当你认为旧快照需要补充、修改或删减，以适应未来聊天话题时使用此工具。',
            '你必须在一次工具调用中，完成所有对旧快照的按行编辑操作。'
        ],
        [
            [
                'operations',
                '所有按行编辑操作，每行最多可操作一次；追加内容按提交顺序排列。每项取以下之一：' +
                    '{"type":"append","text":...} 在末尾追加一行；' +
                    '{"type":"replace","line":...,"text":...} 替换指定行的内容；' +
                    '{"type":"delete","line":...} 删除指定行。' +
                    `line 是旧快照中的行号，从 0 开始；text 是单行文本，最多 ${snapshotMaxLineLength} 个字符。`
            ]
        ]
    ),
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
    description: withParameterDocs(
        [
            '长期记忆查询工具，当你需要在记忆库中查询记忆时使用此工具；检索相关度越高的记忆在工具结果中排名越靠前。'
        ],
        [
            [
                'searchTexts',
                `用于语义检索的短句，最多 ${memorySearchMaxTextCount} 条；必须有完整的句子结构（如主谓宾、人物+动作+场景、主语+的+形容词等）；使用第一人称的自然语言描述；每个短句的语义主题唯一。`
            ],
            [
                'searchKeywords',
                `用于准确匹配的关键词，最多 ${memorySearchMaxKeywordCount} 个；必须是具体的事物、活动、地点等实体名称或专有名词；避免以用户名作为关键词进行查询。可省略。`
            ]
        ]
    ),
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
    description: withParameterDocs(
        [
            '长期记忆的原始消息获取工具，当你需要获取某条记忆的原始消息时使用此工具；使用已知的记忆 ID 或调用 living_memory_search 工具检索得到记忆 ID。'
        ],
        [['memoryId', '要获取原始消息的记忆 ID。']]
    ),
    schema: Schema.object({
        memoryId: requiredText('要获取原始消息的记忆 ID。')
    })
}

export const memoryCreateTool = (maxMemories: number): LivingMemoryToolDoc => ({
    name: 'living_memory_create_memory',
    description: withParameterDocs(
        [
            '长期记忆创建工具，当你被明确要求记录信息，或你认为有值得长期记忆的内容时使用此工具。'
        ],
        [
            ['memories', `要创建的记忆对象，1 到 ${maxMemories} 条，内容根据当前上下文决定。`],
            ['memories[].*', memoryFieldDocsText()]
        ]
    ),
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
    description: withParameterDocs(
        [
            '长期记忆更新工具，当你需要更新某条记忆时使用此工具；使用当前上下文已提供的记忆 ID。',
            '你应该在某条记忆中描述的内容过时、需要补充或是与你所知道的信息存在冲突时更新它。',
            '你应该提交更新后的完整记忆字段，不要遗漏或省略任一字段。'
        ],
        [
            ['memoryId', '要更新的记忆 ID。'],
            ['memory', `更新后的完整记忆字段：\n${memoryFieldDocsText()}`]
        ]
    ),
    schema: Schema.object({
        memoryId: requiredText('要更新的记忆 ID'),
        memory: generatedMemorySchema
    })
}

export const memoryMergeTool: LivingMemoryToolDoc = {
    name: 'living_memory_merge_memories',
    description: withParameterDocs(
        [
            '长期记忆合并工具，当你需要将多条记忆合并成一条时使用此工具；使用当前上下文已提供的记忆 ID。',
            '你应该在多条记忆描述同一事件、关系、概念或偏好，且内容重复或互相补充时合并它们。',
            '你应该提交合并后的完整新记忆字段，不要遗漏或省略任一字段。'
        ],
        [
            ['sourceMemoryIds', '要被合并的记忆 ID，至少两条。'],
            ['memory', `合并后的完整新记忆字段：\n${memoryFieldDocsText()}`]
        ]
    ),
    schema: Schema.object({
        sourceMemoryIds: Schema.array(requiredText('要被合并的记忆 ID'))
            .min(2)
            .required()
            .description('要被合并的记忆 ID'),
        memory: generatedMemorySchema
    })
}

export const memorySplitTool: LivingMemoryToolDoc = {
    name: 'living_memory_split_memory',
    description: withParameterDocs(
        [
            '长期记忆拆分工具，当你需要将一条记忆拆分为多条记忆时使用此工具；使用当前上下文已提供的记忆 ID。',
            '你应该在一条记忆包含了多个主题的事实内容时拆分它；拆分后的每条记忆主题唯一，且不丢失重要信息。',
            '你应该提交拆分后的完整新记忆字段，不要遗漏或省略任一字段。'
        ],
        [
            ['sourceMemoryId', '要拆分的记忆 ID。'],
            ['memories', `拆分后的新记忆，至少两条；每项字段：\n${memoryFieldDocsText()}`]
        ]
    ),
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
    description: withParameterDocs(
        [
            '长期记忆删除工具，当你需要删除某条记忆时使用此工具；使用当前上下文已提供的记忆 ID。',
            '你应该在某条记忆与其他记忆内容重复、存在冲突或是过时时删除它；一般选择时间上更旧的记忆删除。'
        ],
        [['memoryId', '要删除的记忆 ID。']]
    ),
    schema: Schema.object({
        memoryId: requiredText('要删除的记忆 ID')
    })
}

export const memoryCheckedTool: LivingMemoryToolDoc = {
    name: 'living_memory_checked_memory',
    description: withParameterDocs(
        ['长期记忆检查工具，当你确认记忆无需更新、合并或归档时使用此工具。'],
        [
            ['memoryIds', '已检查且无需变更的记忆 ID，允许批量输入。'],
            ['reason', '记忆无需变更的理由。']
        ]
    ),
    schema: Schema.object({
        memoryIds: Schema.array(requiredText('已检查且无需变更的记忆 ID'))
            .min(1)
            .required()
            .description('已检查且无需变更的记忆 ID, 允许批量输入'),
        reason: requiredText('记忆无需变更的理由')
    })
}

export const extractionResultTool: LivingMemoryToolDoc = {
    name: 'living_memory_extraction_result',
    description: withParameterDocs(
        ['记忆提取结果提交工具，当你需要提交从聊天记录中提取到的长期记忆时使用此工具。'],
        [
            ['memories', `本次提取的长期记忆；提取数量为零时提交空数组。每项字段：\n${memoryFieldDocsText()}`],
            ['reason', '提取这些记忆/不提取记忆的简短原因。']
        ]
    ),
    schema: Schema.object({
        memories: Schema.array(generatedMemorySchema)
            .required()
            .description('本次提取的长期记忆；提取数量为零时提交空数组。'),
        reason: requiredText('提取这些记忆/不提取记忆的简短原因。')
    })
}

export const userProfileResultTool: LivingMemoryToolDoc = {
    name: 'living_memory_user_profile_result',
    description: withParameterDocs(
        ['人物画像更新工具，当你需要提交人物画像的更新或保留结果时使用此工具。'],
        [
            ['action', 'update 表示生成或更新人物画像；keep 表示保留已有画像。'],
            [
                'content',
                '完整的新人物画像正文，长度不超过 300 个字符；action 为 update 时必须填写。'
            ],
            ['reason', '更新或保留人物画像的简短原因。']
        ]
    ),
    schema: Schema.object({
        action: Schema.union(['update', 'keep'])
            .required()
            .description('update 表示生成或更新人物画像；keep 表示保留已有画像'),
        content: requiredText('完整的新人物画像正文，长度不超过 300 个字符。'),
        reason: requiredText('更新或保留人物画像的简短原因')
    })
}

export const personaCardResultTool: LivingMemoryToolDoc = {
    name: 'living_memory_persona_card_result',
    description: withParameterDocs(
        ['人设卡片删减工具，当你需要按行删减预设原文内容时使用此工具。'],
        [['deletedLineNumbers', '要删除的行号列表，编号从 0 开始；保留全部内容时提交空数组。']]
    ),
    schema: Schema.object({
        deletedLineNumbers: Schema.array(Schema.natural())
            .required()
            .description('要删除的行号列表，编号从 0 开始；保留全部内容时提交空数组。')
    })
}
