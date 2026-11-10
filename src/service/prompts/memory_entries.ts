import type { LivingMemoryGetMessagesMemory, MemoryEntryWithSource, PresetSpeakerRecord } from '../../contracts/memory.ts'

type ContextEntry = Pick<MemoryEntryWithSource, 'id' | 'type' | 'updatedAt' | 'sentiment' | 'sourceLabel' | 'content'>
export type DreamPromptEntry = ContextEntry & Pick<MemoryEntryWithSource, 'importance' | 'keywords' | 'summary' | 'speakerKeys'>

const entrySeparator = '\n\n---\n\n'

function renderEntry(entry: ContextEntry, includeId: boolean, details: string[] = []) {
    const lines = [`type=${entry.type}`, `updatedAt=${entry.updatedAt.toISOString()}`]
    if (includeId) lines.unshift(`id=${entry.id}`)
    if (entry.sentiment !== null) lines.push(`sentiment=${entry.sentiment}`)
    return [...lines, ...details, entry.sourceLabel, 'content:', entry.content].join('\n')
}

export function renderMemoriesForModel(entries: readonly ContextEntry[], includeIds = false) {
    return entries.map(entry => renderEntry(entry, includeIds)).join(entrySeparator)
}

export function renderDreamMemories(entries: readonly DreamPromptEntry[], speakers: readonly PresetSpeakerRecord[]) {
    const byKey = new Map(speakers.map(speaker => [speaker.speakerKey, speaker]))
    return entries.map(entry => {
        const details: string[] = []
        if (entry.importance !== null) details.push(`importance=${entry.importance}`)
        details.push(`keywords=${entry.keywords.join('、')}`)
        if (entry.summary !== null) details.push(`summary=${entry.summary}`)
        const labels = entry.speakerKeys.map(key => byKey.get(key)!.speakerLabel)
        return `${renderEntry(entry, true, details)}\nspeakerLabels=${JSON.stringify(labels)}`
    }).join(entrySeparator)
}

/**
 * 来源消息是提取工作流输入与 `<chat_history>` 注入共用的原始格式，
 * `transcriptLines` 由来源消息序列化时写入并随数据持久化，直接作为模型视图复用。
 */
export const renderMemorySourceMessagesForModel = (memory: LivingMemoryGetMessagesMemory) => {
    const header = [`id=${memory.id}`, memory.sourceLabel]

    if (memory.sourceOrigins.length === 0) {
        return [...header, '（该记忆没有记录来源消息）'].join('\n')
    }

    const originCount = memory.sourceOrigins.length
    const blocks = memory.sourceOrigins.map((origin, index) => {
        const lines = origin.messages.flatMap((message) => message.transcriptLines)
        if (originCount > 1) {
            lines.unshift(`来源对话 ${index + 1}/${originCount}：`)
        }
        return lines.join('\n')
    })

    return [...header, blocks.join('\n\n')].join('\n')
}
