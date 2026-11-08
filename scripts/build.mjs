import { readFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'
import { build as buildClient } from '@chatluna/ui-client'

const projectRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
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

await buildClient(projectRoot.replaceAll('\\', '/'), {
    logLevel: 'info',
    build: {
        rollupOptions: {
            onwarn(warning, warn) {
                // 管理页只在浏览器运行，组件的客户端标记不影响打包。
                if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('"use client"')) return
                warn(warning)
            }
        }
    }
})
await import('./build-workers.mjs')
