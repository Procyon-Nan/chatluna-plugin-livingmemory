import assert from 'node:assert/strict'
import type { Context } from 'cordis'
import {
    DEFAULT_MEMORY_IMPORTANCE,
    MAX_MEMORY_KEYWORDS,
    normalizeMemoryImportance,
    normalizeMemoryKeywords,
    normalizeMemoryText,
    normalizeOptionalMemoryText
} from '../src/service/memory/entry_fields.ts'
import { LivingMemoryRepository } from '../src/service/persistence/repository.ts'
import { LivingMemoryExtractor } from '../src/service/workflows/extraction/extractor.ts'
import { extractionResultTool } from '../src/service/prompts/memory_tools.ts'
import { withLivingMemoryRepository } from './persistence-test-utils.ts'
import { logger } from './workflow-test-utils.ts'

const keywordInput = () => [
    '  alpha  ',
    'alpha',
    '',
    ...Array.from(
        { length: MAX_MEMORY_KEYWORDS },
        (_, index) => `keyword-${index}`
    )
]

it('normalizes memory text fields consistently', () => {
    assert.equal(normalizeMemoryText('  memory content  '), 'memory content')
    assert.equal(normalizeOptionalMemoryText(null), null)
    assert.equal(normalizeOptionalMemoryText('  summary  '), 'summary')
    assert.equal(normalizeOptionalMemoryText('   '), null)
})

it('normalizes and limits memory keywords consistently', () => {
    const keywords = normalizeMemoryKeywords(keywordInput())

    assert.equal(keywords.length, MAX_MEMORY_KEYWORDS)
    assert.deepEqual(keywords.slice(0, 3), ['alpha', 'keyword-0', 'keyword-1'])
    assert.equal(keywords.at(-1), `keyword-${MAX_MEMORY_KEYWORDS - 2}`)
})

it('normalizes optional importance consistently', () => {
    assert.equal(normalizeMemoryImportance(0.75), 0.75)
    assert.equal(normalizeMemoryImportance(-1), 0)
    assert.equal(normalizeMemoryImportance(2), 1)
    assert.equal(normalizeMemoryImportance(null), null)
    assert.equal(
        normalizeMemoryImportance(undefined) ?? DEFAULT_MEMORY_IMPORTANCE,
        0.5
    )
})

it('applies shared field rules to extracted memories', async () => {
    const extractionKeywords = ['  alpha  ', 'alpha', 'keyword-0']

    const raw = {
        reason: '聊天中包含值得长期记录的事实。',
        memories: [
            {
                type: 'fact',
                content: '  extracted content  ',
                summary: '  extracted summary  ',
                sentiment: '  neutral  ',
                keywords: extractionKeywords,
                importance: 1,
                speakerLabels: ['张三']
            }
        ]
    }
    // `chatluna.extract` 用工具 schema 校验并规整结果，这里照同一条路径取值，
    // 覆盖字段规范化在真实调用链上的效果。
    const ctx = {
        ai: { chat: () => ({ bind: async () => ({}) }) },
        chatluna: {
            extract: async () => extractionResultTool.schema(raw)
        }
    } as unknown as Context
    const extractor = new LivingMemoryExtractor(ctx, 'test-model')

    const result = await extractor.extract(
        'input',
        {
            presetId: 'preset-1',
            presetPrompt: '你是测试助手。',
            speakers: [{ speakerLabel: '张三', speakerKey: 'speaker-key' }]
        },
        logger
    )

    assert.equal(result.parseError, null)
    assert.deepEqual(result.extracted, [
        {
            type: 'fact',
            content: 'extracted content',
            summary: 'extracted summary',
            sentiment: 'neutral',
            keywords: normalizeMemoryKeywords(extractionKeywords),
            importance: 1,
            speakerKeys: ['speaker-key']
        }
    ])
})

it('applies shared field rules to manual persistence writes', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const memory = await repository.createMemory(
            { conversationId: 'conversation-1', presetId: 'preset-1' },
            {
                type: 'fact',
                content: '  manual content  ',
                summary: '  manual summary  ',
                sentiment: '   ',
                keywords: keywordInput(),
                importance: 2
            }
        )

        assert.equal(memory.content, 'manual content')
        assert.equal(memory.summary, 'manual summary')
        assert.equal(memory.sentiment, null)
        assert.deepEqual(
            memory.keywords,
            normalizeMemoryKeywords(keywordInput())
        )
        assert.equal(memory.importance, 1)
    })
})
