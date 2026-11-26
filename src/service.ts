import { Context, Service } from 'cordis'
import { existsSync, watch } from 'node:fs'
import type { Disposable } from 'cordis'
import type {} from '@cordisjs/plugin-database'
import type {} from '@cordisjs/plugin-loader'
import type {} from '@chatluna/tool'
import { LivingMemoryMutationService } from './service/app/mutation_service.ts'
import { LivingMemoryMemoryProviders } from './service/app/memory_providers.ts'
import { LivingMemoryLogger } from './service/logging/logger.ts'
import { registerLivingMemoryTools } from './service/memory/tools/index.ts'
import { defineLivingMemoryTables } from './service/persistence/tables.ts'
import { LivingMemoryRepository } from './service/persistence/repository.ts'
import { migrateLegacySources } from './service/persistence/source_migration.ts'
import { routeSettings } from './routing.ts'
import { LivingMemoryChatHistory } from './service/chat_history.ts'
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
import { LivingMemoryMaintenance } from './service/app/maintenance.ts'
import { LivingMemoryAdminService } from './service/app/admin_service.ts'
import { livingMemoryCommands } from './service/app/commands.ts'
import { livingMemoryWebUI } from './service/app/webui.ts'
import { LivingMemoryConversationHooks } from './service/conversation_hooks.ts'
import type { LivingMemoryConfig } from './contracts/workflows.ts'

declare module 'cordis' {
    interface Context {
        livingmemory: LivingmemoryService
    }
}

const serviceName = 'livingmemory'

export interface LivingMemoryServiceConfig extends LivingMemoryConfig {}

export const DEFAULT_CONFIG: LivingMemoryServiceConfig = {
    enableUserProfileGeneration: true,
    enableDreamUserProfileGeneration: true,
    mainModel: '无',
    subModel: '无',
    userProfileMinMemoryCount: 3,
    userProfileMemoryLimit: 30,
    embeddingModel: '无',
    rerankModel: '无',
    memorySearchToolMaxResults: 15,
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
    readonly history: LivingMemoryChatHistory
    readonly vectorIndex: LivingMemoryVectorIndexService
    readonly mutations: LivingMemoryMutationService
    readonly searchEngine: LivingMemorySearchEngine
    readonly presetPersona: LivingMemoryPresetPersonaService
    readonly userProfiles: LivingMemoryUserProfileService
    readonly recallCoordinator: LivingMemoryRecallCoordinator
    readonly extractionCoordinator: LivingMemoryExtractionCoordinator
    readonly dreamCoordinator: LivingMemoryDreamCoordinator
    readonly admin: LivingMemoryAdminService
    readonly maintenance: LivingMemoryMaintenance
    readonly providers: LivingMemoryMemoryProviders
    readonly logger: LivingMemoryLogger
    private readonly conversationHooks: LivingMemoryConversationHooks
    private readonly dreamWorker: LivingMemoryDreamWorkerClient
    private readonly dream: LivingMemoryDreamService
    private config: LivingMemoryServiceConfig

    constructor(ctx: Context, config: LivingMemoryServiceConfig = DEFAULT_CONFIG) {
        super(ctx, serviceName)
        this.config = config
        defineLivingMemoryTables(ctx)
        this.logger = new LivingMemoryLogger(ctx.logger('livingmemory'), () => this.config.debug)
        this.repository = new LivingMemoryRepository(ctx)
        this.history = new LivingMemoryChatHistory(ctx.chat_observer)
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
            config.subModel,
            this.history,
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
            this.history,
            this.repository,
            this.mutations,
            new LivingMemoryMessageFormatter(),
            new LivingMemoryExtractor(ctx, config.mainModel),
            this.presetPersona,
            this.logger,
            (presetId, memoryIds, speakerKeys, enableAutoDream) => {
                if (enableAutoDream) {
                    this.dreamCoordinator.queueAfterExtraction(presetId, memoryIds)
                } else if (this.config.enableUserProfileGeneration) {
                    this.userProfiles.queueGeneration(presetId, speakerKeys)
                }
            }
        )
        this.conversationHooks = new LivingMemoryConversationHooks(ctx, {
            history: this.history,
            recall: this.recallCoordinator,
            extraction: this.extractionCoordinator,
            userProfiles: this.userProfiles,
            repository: this.repository,
            logger: this.logger,
            settingsOf: (...args) => routeSettings(ctx, ...args)
        })
        this.admin = new LivingMemoryAdminService({
            config,
            repository: this.repository,
            mutations: this.mutations,
            searchEngine: this.searchEngine,
            presetPersona: this.presetPersona,
            userProfiles: this.userProfiles,
            dreamCoordinator: this.dreamCoordinator,
            vectorIndex: this.vectorIndex,
            listPresetIds: async () =>
                ctx.presets.list().map((preset) => preset.id),
            cleanupConversation: (conversationId) =>
                this.cleanupConversation(conversationId)
        })
        this.maintenance = new LivingMemoryMaintenance(ctx, {
            repository: this.repository,
            mutations: this.mutations,
            logger: this.logger
        })
    }

    /**
     * 清理单个会话在本插件内的状态：快照按会话删除，召回与提取游标按会话
     * 失效，消费边界重新建立。记忆条目本身不删——它们属于预设，不随会话消失。
     */
    private async cleanupConversation(conversationId: string) {
        await this.repository.deleteSnapshotsByConversation(conversationId)
        this.conversationHooks.reset(conversationId)
    }

    /** 注册会话钩子与记忆工具；插件卸载时随 effect 一并注销。 */
    private register(): Disposable {
        const stopHooks = this.conversationHooks.register()
        this.registerCommands()
        this.registerWebUI()
        const tools = registerLivingMemoryTools(this.ctx, this.providers, {
            enabled: this.config.enabledMemoryTools,
            createToolMaxMemories: this.config.memoryCreateToolMaxMemories,
            resolveRoute: (agent, routeId) => {
                const turn = agent && this.conversationHooks.contextForTurn(agent)
                if (turn) return { routeId: turn.routeId, isolated: turn.settings.enableConversationIsolation }
                const settings = routeSettings(this.ctx, agent?.options.conversationKey, agent?.options.location, routeId)
                return { routeId, isolated: settings.enableConversationIsolation }
            }
        })
        return () => {
            for (const dispose of tools) dispose()
            stopHooks()
        }
    }

    /**
     * 命令只在宿主装了 `koishi` 服务时注册，卸载随插件的 effect 一并完成。
     * 不把 `koishi` 列进插件 `inject`：命令是可选能力，缺它不应让整插件不加载。
     */
    private registerCommands() {
        const admin = this.admin
        this.ctx.plugin({
            name: 'livingmemory-commands',
            inject: ['koishi'],
            apply: (ctx: Context) => livingMemoryCommands(ctx, admin)
        })
    }

    /**
     * 管理页只在宿主装了 `chatluna_webui` 时注册。子插件的形式与命令一致：
     * 界面是可选能力，缺它不应让整插件不加载。
     */
    private registerWebUI() {
        const ui = {
            admin: this.admin,
            repository: this.repository,
            logger: this.logger
        }
        this.ctx.plugin({
            name: 'livingmemory-webui',
            inject: ['chatluna_webui', 'permissions'],
            apply: (ctx: Context) => {
                ctx.chatluna_webui.state('livingmemory.settingsEntry', {
                    get: () => {
                        const entry = this.ctx.fiber.entry
                        return entry ? { id: entry.id } : null
                    }
                })
                const files = {
                    baseUrl: import.meta.url,
                    source: '../client/index.ts',
                    bundle: '../dist/client.js'
                }
                const webui = ctx.chatluna_webui
                let entry = webui.addEntry(files)
                if (!webui.config.devMode && existsSync(new URL('../scripts/build-client.mjs', import.meta.url))) {
                    ctx.effect(() => {
                        const watcher = watch(new URL('../', import.meta.url), (_event, file) => {
                            if (file !== '.webui-reload') return
                            const previous = entry
                            entry = webui.addEntry(files)
                            previous.dispose()
                        })
                        return () => watcher.close()
                    })
                }
                livingMemoryWebUI(ctx, ui)
            }
        })
    }

    /**
     * 注册上述能力并启动向量索引与 Dream 工作线程。索引的就绪状态决定记忆写入
     * 能否通过 `assertPresetReady`，因此启动失败按插件加载失败处理。
     *
     * 先标记上次中断的任务，待工作线程启动后再安排归档清理。
     */
    async start(): Promise<Disposable> {
        await migrateLegacySources(this.ctx)
        await this.maintenance.recoverInterruptedJobs()
        const disposer = this.register()
        const stopMaintenance = this.maintenance.schedule()
        try {
            await this.vectorIndex.start()
            await this.dreamWorker.start()
        } catch (error) {
            await this.dreamWorker.stop()
            await this.vectorIndex.stop()
            stopMaintenance()
            disposer()
            throw error
        }
        this.maintenance.queueStartupArchivedCleanup()
        await this.maintenance.settled()
        return async () => {
            // 先停止接收新任务并取消在途运行，再释放 Worker 与索引。
            stopMaintenance()
            disposer()
            await Promise.all([
                this.dreamCoordinator.stop(),
                this.recallCoordinator.stop(),
                this.extractionCoordinator.stop(),
                this.userProfiles.stop()
            ])
            await this.maintenance.settled()
            this.vectorIndex.beginStop()
            try {
                await this.dreamWorker.stop()
            } finally {
                await this.vectorIndex.stop()
            }
        }
    }
}
