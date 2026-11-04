import { parentPort } from 'node:worker_threads'
import { LivingMemoryVectorIndexDatabase } from './database.ts'
import { serializeError, startVectorIndexWorker } from './runtime.ts'
import type { VectorIndexWorkerWarning } from '../worker_protocol.ts'

const port = parentPort!
startVectorIndexWorker(
    port,
    new LivingMemoryVectorIndexDatabase({
        reportWarning: (warning) =>
            port.postMessage({
                type: 'warning',
                error: serializeError(warning)
            } satisfies VectorIndexWorkerWarning)
    })
)
