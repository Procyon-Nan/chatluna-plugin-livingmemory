import { rm } from 'node:fs/promises'

const projectRoot = new URL('..', import.meta.url)
await Promise.all([
    'lib/',
    'dist/',
    'tsconfig.tsbuildinfo',
    'tsconfig.client.tsbuildinfo'
].map((path) => rm(new URL(path, projectRoot), { recursive: true, force: true })))
