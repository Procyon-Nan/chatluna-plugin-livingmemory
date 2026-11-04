import { Context, Service } from 'cordis'
import type { Disposable } from 'cordis'
import type {} from '@cordisjs/plugin-database'
import type {} from '@chatluna/memory'
import type {} from '@chatluna/tool'
import { LivingMemoryBackend } from './service/backend.ts'
import { LivingMemoryMemoryProviders } from './service/app/memory_providers.ts'
import { LivingMemoryLogger } from './service/logging/logger.ts'
import { registerLivingMemoryTools } from './service/memory/tools/index.ts'
import { defineLivingMemoryTables } from './service/persistence/tables.ts'
import { LivingMemoryRepository } from './service/persistence/repository.ts'
import { MessageCollector } from './service/message_collector.ts'
import { LivingMemoryVectorIndexService } from './service/vector_index/service.ts'

declare module 'cordis' {
    interface Context {
        livingmemory: LivingmemoryService
    }
}

const serviceName = 'livingmemory'

export interface LivingMemoryServiceConfig {
    debug: boolean
    embeddingModel: string
    enabledMemoryTools: readonly string[]
    memoryCreateToolMaxMemories: number
    enableConversationIsolation: boolean
}

export const DEFAULT_CONFIG: LivingMemoryServiceConfig = {
    debug: false,
    embeddingModel: '',
    enabledMemoryTools: [
        'living_memory_search',
        'living_memory_get_messages',
        'living_memory_create_memory'
    ],
    memoryCreateToolMaxMemories: 10,
    enableConversationIsolation: false
}

export default class LivingmemoryService extends Service {
    readonly repository: LivingMemoryRepository
    readonly backend: LivingMemoryBackend
    readonly collector: MessageCollector
    readonly vectorIndex: LivingMemoryVectorIndexService
    readonly providers: LivingMemoryMemoryProviders
    readonly logger: LivingMemoryLogger
    private config: LivingMemoryServiceConfig

    constructor(ctx: Context, config: LivingMemoryServiceConfig = DEFAULT_CONFIG) {
        super(ctx, serviceName)
        this.config = config
        defineLivingMemoryTables(ctx)
        this.logger = new LivingMemoryLogger(ctx.logger('livingmemory'), () => this.config.debug)
        this.repository = new LivingMemoryRepository(ctx)
        this.backend = new LivingMemoryBackend(this.repository)
        this.collector = new MessageCollector(ctx.chatluna_collector)
        this.vectorIndex = new LivingMemoryVectorIndexService(ctx, config, this.repository, this.logger)
        this.providers = new LivingMemoryMemoryProviders({
            repository: this.repository,
            backend: this.backend,
            vectorIndex: this.vectorIndex,
            logger: this.logger
        })
    }

    /** 注册后端、采集订阅与记忆工具；插件卸载时随 effect 一并注销。 */
    private register(): Disposable {
        const unregister = this.ctx.memory.backend(this.backend.id, () => this.backend)
        const stopCollecting = this.collector.start()
        const tools = registerLivingMemoryTools(this.ctx, this.providers, {
            enabled: this.config.enabledMemoryTools,
            createToolMaxMemories: this.config.memoryCreateToolMaxMemories,
            enableConversationIsolation: this.config.enableConversationIsolation
        })
        return () => {
            for (const dispose of tools) dispose()
            stopCollecting()
            unregister()
        }
    }

    /**
     * 注册上述能力并启动向量索引。索引的就绪状态决定记忆写入能否通过
     * `assertPresetReady`，因此启动失败按插件加载失败处理。
     */
    async start(): Promise<Disposable> {
        const disposer = this.register()
        try {
            await this.vectorIndex.start()
        } catch (error) {
            disposer()
            throw error
        }
        return async () => {
            this.vectorIndex.beginStop()
            try {
                await this.vectorIndex.stop()
            } finally {
                disposer()
            }
        }
    }
}