import { MemoryInputError, missingMemory } from './errors.ts'

const shortId = /^[0-9a-f]{12}$/i
const longId = /^(?:[0-9a-f]{64}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i

const supportsSuffix = (id: string) => shortId.test(id) || longId.test(id)
const suffix = (id: string) => id.slice(-12)

export interface MemoryIdSource {
    findMemoryIds(presetId: string, pattern: RegExp): Promise<string[]>
}

/** 当前操作涉及的尾号。只读取当前预设的 ID，包含归档记忆和占用短号的历史主键。 */
export async function modelMemoryIds(source: MemoryIdSource, presetId: string, ids: readonly string[], committedWarnings?: string[]) {
    const suffixes = [...new Set(ids.filter(supportsSuffix).map(suffix))]
    let matches: string[] = []
    if (suffixes.length) {
        try {
            matches = await source.findMemoryIds(presetId, new RegExp(`(${suffixes.join('|')})$`))
        } catch (error) {
            if (!committedWarnings) throw error
            committedWarnings.push(`记忆已写入，短号查询失败，返回完整 ID：${error instanceof Error ? error.message : String(error)}`)
        }
    }
    const groups = Map.groupBy(matches.filter(supportsSuffix), suffix)
    return {
        display(id: string) {
            const tail = suffix(id)
            const group = groups.get(tail)
            return group?.length === 1 && group[0] === id ? tail : id
        },
        resolve(ref: string, available?: ReadonlySet<string>) {
            if (!shortId.test(ref)) return ref
            const matches = groups.get(ref) ?? []
            if (matches.includes(ref)) return ref
            if (matches.length === 1) return matches[0]
            if (!matches.length) throw missingMemory(ref)
            const allowed = available ? matches.filter(id => available.has(id)) : []
            const hint = allowed.length ? `请使用完整 ID：${allowed.join('、')}。` : '请重新查询并使用完整记忆 ID。'
            throw new MemoryInputError(`记忆短号 ${ref} 对应多条记忆。${hint}`)
        }
    }
}

export async function withModelMemoryIds<T extends { id: string }>(
    source: MemoryIdSource, presetId: string, entries: readonly T[], committedWarnings?: string[]
) {
    const refs = await modelMemoryIds(source, presetId, entries.map(entry => entry.id), committedWarnings)
    return entries.map(entry => ({ ...entry, id: refs.display(entry.id) }))
}
