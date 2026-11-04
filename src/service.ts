import { Context, Service } from 'cordis'
import type { Disposable } from 'cordis'
import type {} from '@cordisjs/plugin-database'
import type {} from '@chatluna/memory'
import { LivingMemoryBackend } from './service/backend.ts'
import { defineLivingMemoryTables } from './service/persistence/tables.ts'
import { LivingMemoryRepository } from './service/persistence/repository.ts'
import { MessageCollector } from './service/message_collector.ts'

declare module 'cordis' {
    interface Context {
        livingmemory: LivingmemoryService
    }
}

const serviceName = 'livingmemory'

export default class LivingmemoryService extends Service {
    readonly repository: LivingMemoryRepository
    readonly backend: LivingMemoryBackend
    readonly collector: MessageCollector

    constructor(ctx: Context) {
        super(ctx, serviceName)
        defineLivingMemoryTables(ctx)
        this.repository = new LivingMemoryRepository(ctx)
        this.backend = new LivingMemoryBackend(this.repository)
        this.collector = new MessageCollector(ctx.chatluna_collector)
    }

    /** 注册后端与采集订阅；插件卸载时随 effect 一并注销。 */
    register(): Disposable {
        const unregister = this.ctx.memory.backend(this.backend.id, () => this.backend)
        const stopCollecting = this.collector.start()
        return () => {
            stopCollecting()
            unregister()
        }
    }
}