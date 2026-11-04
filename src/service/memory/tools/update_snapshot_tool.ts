import { defineTool, type ToolCallContext, type ToolDefinition } from '@chatluna/tool'
import { MemoryInputError } from '../errors.ts'
import {
    memoryPassTool,
    memoryUpdateSnapshotTool,
    snapshotMaxLineLength
} from '../../prompts/memory_tools.ts'

type SnapshotOperation =
    | { type: 'append'; text: string }
    | { type: 'replace'; line: number; text: string }
    | { type: 'delete'; line: number }

/**
 * 快照按行编辑工具。旧快照行号指向同一份基线，删除操作保持其余原行编号稳定；
 * 追加内容按提交顺序接在末尾。全部校验通过后才写库，失败时快照保持不变。
 */
export const createUpdateSnapshotTool = (
    lines: readonly string[],
    maxLines: number,
    saveSnapshot: (text: string) => Promise<void>
): ToolDefinition<{ operations: SnapshotOperation[] }> =>
    defineTool({
        name: memoryUpdateSnapshotTool.name,
        description: [
            memoryUpdateSnapshotTool.description,
            `编辑后的快照最多 ${maxLines} 行，每行最多 ${snapshotMaxLineLength} 个字符。`
        ].join('\n'),
        args: memoryUpdateSnapshotTool.schema,
        traits: { effect: 'write' },
        async run(input: { operations: SnapshotOperation[] }, _call: ToolCallContext) {
            const changes = new Map<number, string | null>()
            const additions: string[] = []

            for (const operation of input.operations) {
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
            // 新提交的文本已由工具 schema 校验，这里检查原样保留的旧行。
            const oversizedLines = lines.flatMap((text, index) =>
                !changes.has(index) && text.length > snapshotMaxLineLength ? [index] : []
            )
            if (oversizedLines.length > 0) {
                throw new MemoryInputError(
                    `旧快照行号 ${oversizedLines.join('、')} 的内容超过 ${snapshotMaxLineLength} 个字符，请缩短或删除这些行后重新提交。`
                )
            }
            await saveSnapshot(finalLines.join('\n'))
            return { updated: true }
        }
    })

/** 跳过快照更新：模型认为旧快照已足够时调用。 */
export const updateSnapshotPassTool = (): ToolDefinition<Record<string, never>> =>
    defineTool({
        name: memoryPassTool.name,
        description: memoryPassTool.description,
        args: memoryPassTool.schema,
        run: () => ({ updated: false })
    })