import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from '@chatluna/ui-client'

const root = resolve(import.meta.dirname, '..').replaceAll('\\', '/')
const watch = process.argv.includes('--watch')

await build(root, {
    logLevel: 'info',
    plugins: watch ? [{
        name: 'livingmemory:notify-webui',
        writeBundle: () => writeFile(new URL('../.webui-reload', import.meta.url), String(Date.now()))
    }] : [],
    build: {
        watch: watch ? {} : null,
        rollupOptions: {
            onwarn(warning, warn) {
                // 管理页只在浏览器运行，组件的客户端标记不影响打包。
                if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('"use client"')) return
                warn(warning)
            }
        }
    }
})
