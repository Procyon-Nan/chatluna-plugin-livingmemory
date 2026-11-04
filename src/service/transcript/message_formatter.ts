import type { LivingMemoryTranscriptMessage } from '../../contracts/memory.ts'
import type { ExtractionPayload } from '../../contracts/workflows.ts'
import { serializeLivingMemorySourceMessages } from './source_serializer.ts'
import { renderLivingMemoryTranscript } from './transcript_renderer.ts'

export class LivingMemoryMessageFormatter {
    toExtractionPayload(
        messages: LivingMemoryTranscriptMessage[]
    ): ExtractionPayload {
        const speakerByLabel = new Map<string, string>()
        for (const message of messages) {
            if (message.role !== 'user') {
                continue
            }
            if (message.speakerKey != null) {
                speakerByLabel.set(message.speakerLabel, message.speakerKey)
            }
        }
        return {
            input: renderLivingMemoryTranscript(messages),
            sourceOriginMessages: serializeLivingMemorySourceMessages(messages),
            speakers: [...speakerByLabel].map(([speakerLabel, speakerKey]) => ({
                speakerLabel,
                speakerKey
            }))
        }
    }
}
