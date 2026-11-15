import { readFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { resolve } from 'node:path'
import { rolldown } from 'rolldown'

const projectRoot = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'))
const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })

const bundle = await rolldown({
    input: resolve(projectRoot, 'src/index.ts'),
    platform: 'node',
    tsconfig: resolve(projectRoot, 'tsconfig.json'),
    external: (id) => isBuiltin(id) || dependencies.some((name) => id === name || id.startsWith(`${name}/`))
})
try {
    await bundle.write({
        format: 'esm',
        file: resolve(projectRoot, 'lib/index.js'),
        sourcemap: true
    })
} finally {
    await bundle.close()
}

await import('./build-client.mjs')
await import('./build-workers.mjs')
