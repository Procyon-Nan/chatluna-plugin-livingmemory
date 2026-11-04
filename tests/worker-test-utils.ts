import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const executeFile = promisify(execFile)
const projectRoot = fileURLToPath(new URL('..', import.meta.url))

export const vectorIndexWorkerPath = resolve(projectRoot, 'lib', 'vector-index-worker.mjs')

/** 测试要跑真实 Worker，先确保打包产物存在且比源码新。 */
let workerBuild: Promise<unknown> | null = null

export const ensureWorkersBuilt = () => {
    if (workerBuild === null) {
        workerBuild = executeFile(process.execPath, [resolve(projectRoot, 'scripts', 'build-workers.mjs')])
    }
    return workerBuild
}