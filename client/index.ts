import type { Context } from 'cordis'
import zh from './locales/zh.yml'
import en from './locales/en.yml'
import type {} from '../src/contracts/webui_live.ts'

/**
 * 管理页的客户端入口。页面本身按需加载，路由注册与语言资源随客户端启动
 * 载入。
 */
export default function apply(ctx: Context) {
    ctx.locale.register('livingmemory', { zh, en })
    ctx.slots.route({
        path: '/livingmemory',
        page: async () => (await import('./page.tsx')).LivingMemoryPage,
        title: '长期记忆',
        icon: 'brain',
        order: 36,
        group: 'capabilities',
        groupOrder: 36
    })
}
