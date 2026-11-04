import type { LivingMemoryTranscriptMessage } from '../../contracts/memory.ts'
import { formatLivingMemoryMessageTime } from './transcript_message.ts'

export const renderLivingMemoryTranscriptLines = (
    message: LivingMemoryTranscriptMessage
) => {
    const time = formatLivingMemoryMessageTime(message.createdAt)
    return message.contentLines.map((line, index) =>
        index === 0 ? `[${time}] ${message.speakerLabel}：${line}` : line
    )
}

export const renderLivingMemoryTranscript = (
    messages: LivingMemoryTranscriptMessage[]
) => {
    return messages.flatMap(renderLivingMemoryTranscriptLines).join('\n')
}
