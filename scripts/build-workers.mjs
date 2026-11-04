import { mkdir, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'

/**
 * 打包 Worker 产物。Worker 以 Node 原生线程运行，只把项目源码打进单文件，
 * PGlite 保持外部依赖，由运行时从 node_modules 解析。
 *
 * 模板项目用 rolldown 而非 v1 的 esbuild，避免在插件仓库里引入第二套打包器。
 */
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputDirectory = resolve(projectRoot, 'lib')
const entries = [
    ['vector-index-worker', 'src/service/vector_index/worker/entry.ts', ['@electric-sql/pglite', '@electric-sql/pglite-pgvector']]
]

await mkdir(outputDirectory, { recursive: true })

for (const [name, input, external] of entries) {
    const outputPath = resolve(outputDirectory, `${name}.mjs`)
    const bundle = await rolldown({ input: resolve(projectRoot, input), platform: 'node', external })
    await bundle.write({ format: 'esm', file: outputPath, codeSplitting: false })
    await bundle.close()
    const output = await stat(outputPath)
    if (!output.isFile() || output.size === 0) {
        throw new Error(`worker build output is invalid: ${outputPath}`)
    }
}