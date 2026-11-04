import type { Context } from 'cordis'
import zh from './locales/zh.yml'
import en from './locales/en.yml'

export default function apply(ctx: Context) {
    ctx.locale.register('livingmemory', { zh, en })
}
