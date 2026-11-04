import assert from 'node:assert/strict'
import { MemoryInputError } from '../src/service/memory/errors.ts'
import {
    createUpdateSnapshotTool,
    updateSnapshotPassTool
} from '../src/service/memory/tools/update_snapshot_tool.ts'
import { snapshotMaxLineLength } from '../src/service/prompts/memory_tools.ts'
import { runTool } from './tool-test-utils.ts'

const run = async (lines: string[], input: unknown, maxLines = 5) => {
    const saved: string[] = []
    const tool = createUpdateSnapshotTool(lines, maxLines, async (text) => {
        saved.push(text)
    })
    const result = await runTool(tool, input, {})
    return { result, saved }
}

it('appends new lines after the existing snapshot', async () => {
    const { result, saved } = await run(['第一行'], { operations: [{ type: 'append', text: '第二行' }] })

    assert.deepEqual(result, { updated: true })
    assert.deepEqual(saved, ['第一行\n第二行'])
})

it('replaces and deletes by the original line numbers in one call', async () => {
    const { saved } = await run(['a', 'b', 'c', 'd'], {
        operations: [
            { type: 'replace', line: 1, text: 'B' },
            { type: 'delete', line: 3 },
            { type: 'append', text: 'e' }
        ]
    })

    assert.deepEqual(saved, ['a\nB\nc\ne'])
})

it('rejects line numbers outside the old snapshot', async () => {
    await assert.rejects(
        run(['a'], { operations: [{ type: 'delete', line: 1 }] }),
        (error: unknown) =>
            error instanceof MemoryInputError && /超出旧快照的 1 行范围/u.test(error.message)
    )
})

it('rejects two operations on the same line', async () => {
    await assert.rejects(
        run(['a', 'b'], {
            operations: [
                { type: 'delete', line: 0 },
                { type: 'replace', line: 0, text: 'x' }
            ]
        }),
        (error: unknown) => error instanceof MemoryInputError && /重复操作/u.test(error.message)
    )
})

it('rejects a result beyond the line limit', async () => {
    await assert.rejects(
        run(['a', 'b'], { operations: [{ type: 'append', text: 'c' }] }, 2),
        (error: unknown) => error instanceof MemoryInputError && /上限为 2 行/u.test(error.message)
    )
})

it('rejects untouched old lines above the character limit', async () => {
    const oversized = 'x'.repeat(snapshotMaxLineLength + 1)
    await assert.rejects(
        run([oversized, 'b'], { operations: [{ type: 'delete', line: 1 }] }),
        (error: unknown) => error instanceof MemoryInputError && /超过 100 个字符/u.test(error.message)
    )
})

it('does not write the snapshot when validation fails', async () => {
    const saved: string[] = []
    const tool = createUpdateSnapshotTool(['a'], 5, async (text) => {
        saved.push(text)
    })

    await assert.rejects(runTool(tool, { operations: [{ type: 'delete', line: 9 }] }, {}))
    assert.deepEqual(saved, [])
})

it('exposes a pass tool that reports no update', async () => {
    const result = await runTool(updateSnapshotPassTool(), {}, {})
    assert.deepEqual(result, { updated: false })
})