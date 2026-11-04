import { Context, Service } from 'cordis'
import type { Disposable } from 'cordis'
import type {} from '@cordisjs/plugin-database'
import type {} from '@chatluna/memory'
import type {} from '@chatluna/tool'
import { LivingMemoryBackend } from './service/backend.ts'
import { LivingMemoryMutationService } from './service/app/mutation_service.ts'
import { LivingMemoryMemoryProviders } from './service/app/memory_providers.ts'
import { LivingMemoryLogger } from './service/logging/logger.ts'
import { registerLivingMemoryTools } from './service/memory/tools/index.ts'
import { defineLivingMemoryTables } from './service/persistence/tables.ts'
import { LivingMemoryRepository } from './service/persistence/repository.ts'
import { MessageCollector } from './service/message_collector.ts'
import { LivingMemoryVectorIndexService } from './service/vector_index/service.ts'
import { LivingMemorySearchEngine } from './service/workflows/recall/memory_search_engine.ts'
import { LivingMemoryAgenticRecallExecutor } from './service/workflows/recall/agentic_recall.ts'
import { LivingMemoryRecallCoordinator } from './service/workflows/recall/coordinator.ts'
import { LivingMemoryExtractor } from './service/workflows/extraction/extractor.ts'
import { LivingMemoryExtractionCoordinator } from './service/workflows/extraction/coordinator.ts'
import { LivingMemoryMessageFormatter } from './service/transcript/message_formatter.ts'
import { LivingMemoryPresetPersonaService } from './service/memory/preset_persona.ts'
import { LivingMemoryUserProfileService } from './service/user_profile.ts'
import { LivingMemoryDreamService } from './service/workflows/dream/service.ts'
import { LivingMemoryDreamWorkerClient } from './service/workflows/dream/worker/client.ts'
import { LivingMemoryDreamJobRunner } from './service/workflows/dream/job_runner.ts'
import { LivingMemoryDreamCoordinator } from './service/workflows/dream/coordinator.ts'
import { LivingMemoryJobTracker } from './service/workflows/job_tracker.ts'
import type { LivingMemoryConfig } from './contracts/workflows.ts'

declare module 'cordis' {
    interface Context {
        livingmemory: LivingmemoryService
    }
}

const serviceName = 'livingmemory'

export interface LivingMemoryServiceConfig extends LivingMemoryConfig {}

export const DEFAULT_CONFIG: LivingMemoryServiceConfig = {
    enableConversationIsolation: false,
    enableSnapshotInjection: true,
    enableUserProfileInjection: false,
    enableUserProfileGeneration: true,
    enableDreamUserProfileGeneration: true,
    enableAutoDream: true,
    mainModel: '无',
    subModel: '无',
    userProfileMinMemoryCount: 3,
    userProfileMemoryLimit: 20,
    recallIntervalMessages: 10,
    recallHistoryMessages: 20,
    snapshotMaxLines: 5,
    embeddingModel: '无',
    rerankModel: '无',
    extractionWindowMessages: 30,
    extractionIncludeOverheard: false,
    enableExtractionWhitelist: false,
    extractionWhitelist: [],
    memorySearchToolMaxResults: 30,
    memorySearchMinSimilarity: 0,
    enabledMemoryTools: [
        'living_memory_search',
        'living_memory_get_messages',
        'living_memory_create_memory'
    ],
    memoryCreateToolMaxMemories: 10,
    debug: false
}

export default class LivingmemoryService extends Service {
    readonly repository: LivingMemoryRepository
    readonly backend: LivingMemoryBackend
    readonly collector: MessageCollector
    readonly vectorIndex: LivingMemoryVectorIndexService
    readonly mutations: LivingMemoryMutationService
    readonly searchEngine: LivingMemorySearchEngine
    readonly presetPersona: LivingMemoryPresetPersonaService
    readonly userProfiles: LivingMemoryUserProfileService
    readonly recallCoordinator: LivingMemoryRecallCoordinator
    readonly extractionCoordinator: LivingMemoryExtractionCoordinator
    readonly dreamCoordinator: LivingMemoryDreamCoordinator
    readonly providers: LivingMemoryMemoryProviders
    readonly logger: LivingMemoryLogger
    private readonly dreamWorker: LivingMemoryDreamWorkerClient
    private readonly dream: LivingMemoryDreamService
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
        this.mutations = new LivingMemoryMutationService(
            this.repository,
            this.vectorIndex,
            this.logger
        )
        this.searchEngine = new LivingMemorySearchEngine(
            ctx,
            config,
            this.repository,
            this.vectorIndex,
            this.logger
        )
        this.providers = new LivingMemoryMemoryProviders({
            repository: this.repository,
            backend: this.backend,
            mutations: this.mutations,
            searchEngine: this.searchEngine
        })
        this.presetPersona = new LivingMemoryPresetPersonaService(
            ctx,
            config,
            this.repository,
            this.logger
        )
        this.userProfiles = new LivingMemoryUserProfileService(
            ctx,
            config,
            this.repository,
            this.logger,
            this.presetPersona
        )
        this.dreamWorker = new LivingMemoryDreamWorkerClient({
            onFailure: (error) =>
                this.logger.summary('Dream 工作线程故障', '操作：执行分组任务', 'error', error)
        })
        this.dream = new LivingMemoryDreamService(
            ctx,
            config,
            this.repository,
            this.mutations,
            this.vectorIndex,
            this.dreamWorker,
            (presetId, mode, speakerKeys) => {
                const enabled =
                    mode === 'post-extraction'
                        ? this.config.enableUserProfileGeneration
                        : this.config.enableDreamUserProfileGeneration
                if (enabled) {
                    this.userProfiles.queueGeneration(presetId, speakerKeys)
                }
            },
            this.presetPersona,
            this.searchEngine
        )
        this.dreamCoordinator = new LivingMemoryDreamCoordinator(
            new LivingMemoryDreamJobRunner(
                this.dream,
                new LivingMemoryJobTracker(this.repository),
                this.logger
            ),
            this.repository,
            this.logger
        )
        this.recallCoordinator = new LivingMemoryRecallCoordinator(
            config,
            this.collector,
            this.repository,
            new LivingMemoryAgenticRecallExecutor(
                ctx,
                config,
                this.searchEngine,
                this.logger
            ),
            this.logger
        )
        this.extractionCoordinator = new LivingMemoryExtractionCoordinator(
            config,
            this.collector,
            this.repository,
            this.mutations,
            new LivingMemoryMessageFormatter(),
            new LivingMemoryExtractor(ctx, config.mainModel),
            this.presetPersona,
            this.logger,
            (presetId, memoryIds, speakerKeys) => {
                if (this.config.enableAutoDream) {
                    this.dreamCoordinator.queueAfterExtraction(presetId, memoryIds)
                } else if (this.config.enableUserProfileGeneration) {
                    this.userProfiles.queueGeneration(presetId, speakerKeys)
                }
            }
        )
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
     * 注册上述能力并启动向量索引与 Dream 工作线程。索引的就绪状态决定记忆写入
     * 能否通过 `assertPresetReady`，因此启动失败按插件加载失败处理。
     */
    async start(): Promise<Disposable> {
        const disposer = this.register()
        await this.vectorIndex.start()
        try {
            await this.dreamWorker.start()
        } catch (error) {
            await this.dreamWorker.stop()
            await this.vectorIndex.stop()
            disposer()
            throw error
        }
        return async () => {
            await Promise.all([this.dreamCoordinator.stop(), this.userProfiles.stop()])
            this.vectorIndex.beginStop()
            try {
                await this.dreamWorker.stop()
            } finally {
                await this.vectorIndex.stop()
                disposer()
            }
        }
    }
}