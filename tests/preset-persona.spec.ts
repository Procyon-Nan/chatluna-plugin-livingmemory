import assert from 'node:assert/strict'
import type { Context } from 'cordis'
import { ModelError, ProtocolError } from '@chatluna/ai'
import type { PresetPersonaRecord } from '../src/contracts/memory.ts'
import type { PresetPersonaWriteInput } from '../src/service/persistence/preset_personas.ts'
import { personaCardResultTool } from '../src/service/prompts/memory_tools.ts'
import {
    LivingMemoryPresetPersonaService,
    hashPresetText,
    splitLines
} from '../src/service/memory/preset_persona.ts'
import { createCapturedLogger } from './workflow-test-utils.ts'

const presetText = [
    '你是所长，一个年轻可爱的女孩子。',
    '你说话简短随性，偶尔用颜文字。',
    '你可以调用 draw_image(prompt=..., urls=...) 来画画。',
    '输出时必须使用 Markdown 格式。',
    '你想要表达某个场景时可以画一张画。'
].join('\n')

const presetLines = splitLines(presetText)

const storedCard = (
    overrides: Partial<PresetPersonaRecord> & Pick<PresetPersonaRecord, 'card'>
): PresetPersonaRecord => ({
    presetId: 'preset-1',
    rawHash: hashPresetText(presetText),
    source: 'generated',
    totalLines: 5,
    deletedLines: 0,
    usedRawFallback: false,
    updatedAt: new Date(),
    ...overrides
})

/** 让模型调用停在门内，供测试在生成途中插入保存或清空。 */
const createModelGate = () => {
    let open!: () => void
    let markReached!: () => void
    const opened = new Promise<void>((resolve) => {
        open = resolve
    })
    const reached = new Promise<void>((resolve) => {
        markReached = resolve
    })
    return {
        open,
        reached,
        wait: async () => {
            markReached()
            await opened
        }
    }
}

const createHarness = (
    responses: unknown[],
    options: {
        stored?: PresetPersonaRecord[]
        presetTexts?: Record<string, string>
        missingPresetIds?: string[]
        modelGate?: { wait(): Promise<void> }
    } = {}
) => {
    const captured = createCapturedLogger()
    const rows = new Map(
        (options.stored ?? []).map((record) => [record.presetId, record])
    )
    const upserts: PresetPersonaWriteInput[] = []
    const presetTexts = new Map<string, string>(
        Object.entries(options.presetTexts ?? {})
    )
    const invocations: { system: string; prompt: string }[] = []
    const pending = [...responses]
    const repository = {
        getPresetPersona: async (presetId: string) => rows.get(presetId),
        listPresetPersonas: async () => [...rows.values()],
        upsertPresetPersona: async (input: PresetPersonaWriteInput) => {
            upserts.push(input)
            rows.set(input.presetId, { ...input, updatedAt: new Date() })
        },
        deletePresetPersona: async (presetId: string) => {
            rows.delete(presetId)
        }
    }
    const ctx = {
        ai: { chat: () => ({ bind: async () => ({}) }) },
        presets: {
            get: (presetId: string) => {
                if (options.missingPresetIds?.includes(presetId)) {
                    return undefined
                }
                return { name: presetId }
            },

            blocks: (record: { name: string }) => [
                {
                    id: 'system',
                    zone: 'system',
                    role: 'system',
                    order: 0,
                    content: presetTexts.get(record.name) ?? presetText
                }
            ]
        },
        chatluna: {
            extract: async (
                _schema: unknown,
                payload: { system: string; prompt: string }
            ) => {
                await options.modelGate?.wait()
                invocations.push({
                    system: payload.system,
                    prompt: payload.prompt
                })
                const response = pending.shift()
                if (response === undefined) {
                    throw new Error('missing fake model response')
                }
                if (response instanceof Error) throw response
                // `extract` 在真实调用里会先按 schema 校验再返回，这里走同一条路径。
                try {
                    return personaCardResultTool.schema(response)
                } catch (error) {
                    throw new ProtocolError({
                        message: `extract: model output failed schema validation: ${String(error)}`
                    })
                }
            }
        }
    } as unknown as Context
    const service = new LivingMemoryPresetPersonaService(
        ctx,
        { mainModel: 'test-model' },
        repository,
        captured.logger
    )
    return { captured, invocations, presetTexts, rows, service, upserts }
}

const deleteLines = (lineNumbers: number[]) => ({ deletedLineNumbers: lineNumbers })

const prunedCard = [presetLines[0], presetLines[1], presetLines[4]].join('\n')

const modelFailure = (message: string) => new ModelError({ message, code: 'TRANSPORT' })

it('keeps original text and only deletes selected lines', async () => {
    const harness = createHarness([deleteLines([2, 3])])

    const card = await harness.service.resolveOrGenerateCardText('preset-1')

    assert.equal(card, prunedCard)
    assert.equal(harness.invocations.length, 1)
    assert.equal(harness.upserts.length, 1)
    const upsert = harness.upserts[0]
    assert.equal(upsert.presetId, 'preset-1')
    assert.equal(upsert.card, card)
    assert.equal(upsert.rawHash, hashPresetText(presetText))
    assert.equal(upsert.source, 'generated')
    assert.equal(upsert.totalLines, 5)
    assert.equal(upsert.deletedLines, 2)
    assert.equal(upsert.usedRawFallback, false)
})

it('keeps CRLF line endings byte for byte in a pruned card', async () => {
    const harness = createHarness([deleteLines([2, 3])])
    harness.presetTexts.set('preset-1', presetLines.join('\r\n'))

    const card = await harness.service.resolveOrGenerateCardText('preset-1')

    assert.equal(
        card,
        [presetLines[0], presetLines[1], presetLines[4]].join('\r\n')
    )
})

it('returns the preset text unchanged when nothing needs deletion', async () => {
    const harness = createHarness([deleteLines([])])

    const card = await harness.service.resolveOrGenerateCardText('preset-1')

    assert.equal(card, presetText)
    assert.equal(harness.invocations.length, 1)
    assert.equal(harness.upserts.length, 1)
    assert.equal(harness.upserts[0].usedRawFallback, false)
})

it('falls back to the raw text when deletion exceeds the ratio guard', async () => {
    const harness = createHarness([deleteLines([0, 1, 2, 3, 4])])

    const card = await harness.service.resolveOrGenerateCardText('preset-1')

    assert.equal(card, presetText)
    assert.ok(
        harness.captured.info.some((message) =>
            message.includes('事件：人设卡片沿用原文')
        )
    )
    // 守卫回退是正常结果：照常落库，后续解析命中落库行不再调用模型
    assert.equal(harness.upserts.length, 1)
    assert.equal(harness.upserts[0].usedRawFallback, true)
    const again = await harness.service.resolveOrGenerateCardText('preset-1')
    assert.equal(again, presetText)
    assert.equal(harness.invocations.length, 1)
})

it('retries with a correction when line numbers fall out of range', async () => {
    const harness = createHarness([deleteLines([99]), deleteLines([2, 3])])

    const card = await harness.service.resolveOrGenerateCardText('preset-1')

    assert.equal(harness.invocations.length, 2)
    assert.doesNotMatch(card, /draw_image/u)
    assert.ok(
        harness.captured.info.some(
            (message) =>
                message.includes('事件：人设卡片结果解析失败') &&
                message.includes('预设：preset-1') &&
                message.includes('调用序号：1') &&
                message.includes('超出范围的行号')
        )
    )
})

it('falls back to the raw text when every response is invalid', async () => {

    const harness = createHarness([
        'plain text one',
        'plain text two',
        'plain text three',
        modelFailure('request failed')
    ])

    const card = await harness.service.resolveOrGenerateCardText('preset-1')

    assert.equal(card, presetText)
    assert.equal(harness.invocations.length, 3)
    assert.equal(harness.upserts.length, 0)
    // 输出校验失败后下次重新调用；第四次模型调用失败，仍保留原文。
    const retried = await harness.service.resolveOrGenerateCardText('preset-1')
    assert.equal(retried, presetText)
    assert.equal(harness.invocations.length, 4)
    assert.equal(harness.upserts.length, 0)
})

it('reuses a persisted card without a model call when the hash matches', async () => {
    const harness = createHarness([], {
        stored: [storedCard({ card: 'cached card' })]
    })

    const card = await harness.service.resolveOrGenerateCardText('preset-1')

    assert.equal(card, 'cached card')
    assert.equal(harness.invocations.length, 0)
    assert.equal(harness.upserts.length, 0)
})

it('regenerates a generated card when the preset text changes', async () => {
    const harness = createHarness([deleteLines([])], {
        stored: [storedCard({ card: 'cached card' })]
    })
    harness.presetTexts.set('preset-1', `${presetText}\n你喜欢猫。`)

    const card = await harness.service.resolveOrGenerateCardText('preset-1')

    assert.equal(card, `${presetText}\n你喜欢猫。`)
    assert.equal(harness.invocations.length, 1)
    assert.equal(
        harness.rows.get('preset-1')?.rawHash,
        hashPresetText(`${presetText}\n你喜欢猫。`)
    )
})

it('keeps serving a manual card after the preset text changes', async () => {
    const harness = createHarness([], {
        stored: [storedCard({ card: 'manual card', source: 'manual' })]
    })
    harness.presetTexts.set('preset-1', `${presetText}\n你喜欢猫。`)

    const card = await harness.service.resolveOrGenerateCardText('preset-1')

    assert.equal(card, 'manual card')
    assert.equal(harness.invocations.length, 0)
    assert.equal(harness.upserts.length, 0)
})

it('serves a saved manual card on the next resolve', async () => {
    const harness = createHarness([deleteLines([2, 3])])
    await harness.service.resolveOrGenerateCardText('preset-1')

    await harness.service.saveManualCard('preset-1', 'manual card')

    assert.equal(
        await harness.service.resolveOrGenerateCardText('preset-1'),
        'manual card'
    )
    assert.equal(harness.invocations.length, 1)
})

it('keeps cards of presets with identical text apart', async () => {
    const harness = createHarness([deleteLines([2, 3])], {
        stored: [storedCard({ card: 'manual card', source: 'manual' })]
    })

    const card = await harness.service.resolveOrGenerateCardText('preset-2')

    assert.equal(card, prunedCard)
    assert.equal(harness.invocations.length, 1)
    assert.equal(harness.rows.get('preset-2')?.source, 'generated')
    assert.equal(harness.rows.get('preset-1')?.card, 'manual card')
})

it('does not overwrite a manual card saved while a card is being generated', async () => {
    const gate = createModelGate()
    const harness = createHarness([deleteLines([2, 3])], { modelGate: gate })

    const resolving = harness.service.resolveOrGenerateCardText('preset-1')
    await gate.reached
    await harness.service.saveManualCard('preset-1', 'manual card')
    gate.open()

    assert.equal(await resolving, 'manual card')
    assert.equal(harness.rows.get('preset-1')?.source, 'manual')
    assert.equal(harness.rows.get('preset-1')?.card, 'manual card')
})

it('deletes manual cards when the preset data is cleared', async () => {
    const harness = createHarness([], {
        stored: [storedCard({ card: 'manual card', source: 'manual' })]
    })

    await harness.service.clearCard('preset-1')

    assert.equal(harness.rows.size, 0)
})

it('does not write back a card generated across a preset clear', async () => {
    const gate = createModelGate()
    const harness = createHarness([deleteLines([2, 3])], { modelGate: gate })

    const resolving = harness.service.resolveOrGenerateCardText('preset-1')
    await gate.reached
    await harness.service.clearCard('preset-1')
    gate.open()

    assert.equal(await resolving, prunedCard)
    assert.equal(harness.rows.size, 0)
    assert.equal(harness.upserts.length, 0)
})

it('reads the preset text without generating when no card is stored', async () => {
    const harness = createHarness([])

    const card = await harness.service.readCard('preset-1')

    assert.equal(card, presetText)
    assert.equal(harness.invocations.length, 0)
    assert.equal(harness.rows.size, 0)
})

it('lists stored cards without rendering presets or calling the model', async () => {
    const harness = createHarness([], {
        stored: [
            storedCard({
                card: 'generated card',
                totalLines: 7,
                deletedLines: 3
            })
        ]
    })

    const cards = await harness.service.listCards()

    assert.equal(cards.length, 1)
    assert.equal(cards[0].presetId, 'preset-1')
    assert.equal(cards[0].source, 'generated')
    assert.equal(cards[0].totalLines, 7)
    assert.equal(cards[0].deletedLines, 3)
    // 自动卡片由哈希懒更新，不存在过期态
    assert.equal(cards[0].stale, false)
    assert.equal(harness.invocations.length, 0)
})

it('rejects a manual card query when its preset no longer exists', async () => {
    const harness = createHarness([], {
        stored: [
            storedCard({
                presetId: 'gone-preset',
                card: 'manual card',
                source: 'manual',
                rawHash: 'hash-before-edit'
            })
        ],
        missingPresetIds: ['gone-preset']
    })

    await assert.rejects(
        harness.service.listCards(),
        /preset not found: gone-preset/u
    )
})

it('marks a manual card stale when the preset text has changed', async () => {
    const harness = createHarness([], {
        stored: [
            storedCard({
                card: 'manual card',
                source: 'manual',
                rawHash: 'hash-before-edit'
            })
        ]
    })

    const cards = await harness.service.listCards()

    assert.equal(cards[0].stale, true)
    assert.equal(harness.invocations.length, 0)
})

it('saves a manual card and keeps it out of automatic updates', async () => {
    const harness = createHarness([])

    await harness.service.saveManualCard('preset-1', 'edited card')

    assert.equal(harness.upserts.length, 1)
    const upsert = harness.upserts[0]
    assert.equal(upsert.presetId, 'preset-1')
    assert.equal(upsert.card, 'edited card')
    assert.equal(upsert.source, 'manual')
    assert.equal(upsert.totalLines, 1)
    assert.equal(harness.invocations.length, 0)
    assert.equal(harness.captured.info.length, 0)
})

it('rejects empty manual card input', async () => {
    const harness = createHarness([])

    await assert.rejects(
        () => harness.service.saveManualCard('preset-1', '   '),
        /persona card must not be empty/u
    )
    assert.equal(harness.upserts.length, 0)
})

it('regenerates a card on reset and replaces the manual row', async () => {
    const harness = createHarness([deleteLines([2, 3])], {
        stored: [
            storedCard({
                card: 'manual card',
                source: 'manual',
                rawHash: 'hash-before-edit'
            })
        ]
    })

    await harness.service.regenerateCard('preset-1')

    assert.equal(harness.invocations.length, 1)
    assert.equal(harness.rows.get('preset-1')?.source, 'generated')
    assert.equal(harness.rows.get('preset-1')?.card, prunedCard)
})

it('keeps the stored card and reports an error when regeneration fails', async () => {
    const harness = createHarness([modelFailure('model unavailable')], {
        stored: [
            storedCard({
                card: 'manual card',
                source: 'manual',
                rawHash: 'hash-before-edit'
            })
        ]
    })

    await assert.rejects(
        () => harness.service.regenerateCard('preset-1'),
        /人设卡片生成失败：模型调用失败/u
    )
    assert.equal(harness.rows.get('preset-1')?.source, 'manual')
    assert.equal(harness.rows.get('preset-1')?.card, 'manual card')
    assert.equal(harness.upserts.length, 0)
})
