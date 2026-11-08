# 实施阶段划分

状态：框架聊天历史接入已写入本地源码；已通过针对消息读取与消费的自动化测试，真实宿主验收待执行。更新日期：2026-11-07。总进度见 [迁移方案](migration-plan.md)。

本文把 M01—M09 的工作项按"可独立验证"重新切成实施阶段。阶段编号只描述推进顺序，不替代迁移方案中的任务编号；每个阶段的验收仍对应 Mxx-Vy 项。

## 阶段

| 阶段 | 内容 | 涉及 M | 完成后可验证 | 依赖框架侧 |
| --- | --- | --- | --- | --- |
| S1 ✅ | 数据层：表定义、仓储、事务、迁移记录 | M03 | 建表、读写往返、旧数据导入的字段映射 | 否 |
| S2 历史交付 | D16 已移除原生后端 | M01 | 插件独立运行 | 否 |
| S3 历史交付 | 旧采集层：消息池、回填、去重、游标、纪元；按 D15 已替换 | M05 | 原交付记录保留；定向测试通过，待真实宿主验收 | 是，M05-C1/C2 |
| S4 ✅ | 模型与工具：langchain 换 `ctx.ai`，zod 换 Schema，工具改注册 | M04 | 单次提取与召回可用真实模型跑通 | 否 |
| S5 已交付；读取已重接 | 工作流：提取、召回、Dream、画像、人设；保留业务实现，重开消息读取与计数接入 | M06、M07 | 分块、结果及失败规则沿用；新消息来源需联调 | 部分，M06-C1 |
| S6 已交付 | 独立调度、任务与卸载取消 | M01 | 专用页直接展示业务状态 | 否 |
| S6.5 历史交付 | 旧采集与触发收尾：修加载阻塞、复制 observer 缓冲、接入会话钩子；消息接入按 D15 已替换 | M05、M06 | 原交付记录保留；不作为 D15 完成依据 | 原接入无；新接口见下表 |
| S7 ✅ | 管理与导入：WebUI、命令、配置、旧数据导入 | M08 | 管理端可用，旧数据进入新流程 | 否 |
| S8 | 验收：跨引擎、生命周期、D11 行为对照 | M09 | 迁移完成 | — |

S3、S6.5 的旧实现以插件消息池为基础，2026-11-06 按 D15 改为复用框架统一聊天历史。下面的原交付内容和当时验证结果保留为历史记录；新读取接口已通过定向测试，真实平台验收由 S8 跟进。D16 已取消原生任务接线要求。

## 框架聊天历史接入进度（2026-11-07）

- [x] M05、M06：直接读取官方 observer 缓冲；旁听、实际回复及预设切换使用同一消息来源，保留原有分块和固定批次规则。
- [x] 消息历史、会话钩子、转写及两个协调器的定向测试。
- [ ] M09：在真实宿主验证各引擎。实施范围与限制见[消息来源与消费](message-pool.md)。

## 独立插件（2026-11-07）

- [x] 移除原生后端、任务投影与包依赖；保留 v1 旧数据导入和任务仓储。
- [x] 九项对话设置迁入独立规则区块，任务页监听插件自身的变更。
- [x] 隔离宿主加载构建产物，运行中加载再卸载原生 memory，验证任务仍可读写。
- [x] 服务端、客户端类型检查通过；干净构建通过；全量 376 个测试通过，0 跳过。
- [ ] 真实部署的跨引擎对话与界面操作随 S8 验收。

## 各阶段交付物

### S1 数据层

迁移 `src/service/persistence/`（2784 行）：表定义、条目仓储、任务仓储、快照仓储、画像仓储、来源与规范化、维护与清理。v1 使用 koishi 的 `ctx.model.extend` 与 `database.get/create/set`，v2 的 `@cordisjs/plugin-database` 提供同名 API，`packages/conversations/core/src/database.ts` 是现成范例。

同一提交内迁移以下测试：`query`、`query-projections`、`repository-maintenance`、`snapshot-repository`、`user-profile-repository`、`job-repository`。

**已完成**（2026-11-04）。落地内容与验收依据：

| 项 | 结果 |
| --- | --- |
| 源文件 | `src/contracts/` 4 个、`src/query.ts`、`src/service/{app,memory,persistence,shared,workflows}/` 共 23 个 |
| 运行时替换 | `Context` 取自 cordis；数据库经 `ctx.get('database')` 获取（驱动就绪前该服务不存在）；相对 import 统一补 `.ts` 后缀 |
| 表定义 | 8 张表改用 `ctx.model.extend`，`isConsolidated` 字段退役改用 `ctx.model.migrate`；8 张表在 `Tables` 上做模块增强 |
| 测试环境 | `node:test` + 内存 SQLite，`tests/setup.ts` 还原 vitest 的全局函数 |
| 结果 | 17 个用例全部通过；`tsc --noEmit` 无报错 |
| 未覆盖 | `memory-entry-fields`、`user-profile` 两个测试依赖 S4/S5 的模块，随对应阶段迁移 |

S1 只搬仓储与查询，没有实现 `MemoryBackend`。后端适配在 S2，届时这些仓储成为后端实现的读写基础。

### S2 后端适配（历史交付，D16 已撤除）

实现 `MemoryBackend` 接口。`packages/memory/core/src/types.ts` 定义签名，`packages/memory/core/src/markdown.ts`（674 行）是完整的参考实现。需要处理 `index()` 的预算语义、`watch()` 的变更通知、`history()`/`revert()` 的版本能力，以及 `export`/`import` 的格式。

**已完成**（2026-11-04）。落地内容与验收依据：

| 项 | 结果 |
| --- | --- |
| 后端实现 | `src/service/backend.ts`，实现 `search`/`get`/`list`/`create`/`update`/`merge`/`split`/`archive`/`remove`/`sources`/`index`/`export`/`import`/`watch` |
| 注册 | `src/service.ts` 持有仓储与后端，启动时调用 `ctx.memory.backend('livingmemory', …)`，入口用 `ctx.effect` 保证卸载时注销 |
| 字段补齐 | 表增加 `topic`/`title`/`fields` 三列（v2 的 `MemoryEntry` 强制要求）；`src/service/memory/entry_identity.ts` 定义确定性推导：主题取记忆类型，标题取显式值 → 摘要 → 内容首行 |
| 导入语义 | 目标预设内已存在的 id 跳过；同 id 落在其他预设时换发导入 id（记录表以 id 为主键） |
| 结果 | 新增 7 个后端测试，全套 24 个用例通过；`tsc --noEmit` 无报错 |

**暂未实现**，随对应阶段补齐：

| 能力 | 现状 | 补齐阶段 |
| --- | --- | --- |
| `search()` 的向量检索 | 当前为关键词/短语打分，不含 pgvector 混合检索与重排 | S3（向量索引迁移） |
| `extract()`/`dream()` 可选入口 | 未提供；原生自动流程不会把窗口交给本后端 | S5 |
| `history()`/`revert()` | 未提供；v1 无版本历史能力 | 视 M03 决定 |
| 旧数据导入 | 只覆盖 `ctx.memory.import` 的 v2 格式；v1 的完整预设导入（含来源、画像、人设）仍在 `repository.importPresetData` | S7 |

S2 只保证原生 memory 能把 LivingMemory 当作普通后端读写。S3 的向量索引会把 `search()` 换成 v1 的混合检索实现。

### S3 采集层

**历史实现，待 D15 替换。** 以下保留 2026-11-04 的阶段交付内容；插件消息池、注册表、回填与去重不再作为当前目标架构。新进度统一记录在上方“框架聊天历史接入进度”。

迁移 `src/service/transcript/`（1352 行）：消息日志、注册表、回填、规范化、去重、序号。v1 有三个采集入口（普通对话中间件、Character 中间件、平台消息采集器），v2 合并为对 observer 的单一订阅。

历史阶段的阻塞点由本次统一聊天历史实现处理；S3 原池实现已移除，当前使用官方 observer 接口。

**已完成**（2026-11-04）。按 `framework-requirements.md` 声明的形状直接实现，框架侧接口落地后只需换 import：

| 项 | 结果 |
| --- | --- |
| 采集入口 | `src/service/message_collector.ts` 订阅观察、交付、会话变化三类事件，统一维护每会话消息池 |
| 框架契约 | `src/contracts/framework.ts` 声明 `ObservedMessageEvent`、`HistoryReader`、`DeliveredReply`、`ConversationChange`、`ChatLunaCollector`，并通过模块增强声明 `ctx.chatluna_collector` |
| 正文规范化 | `src/service/transcript/element_text.ts` 基于 `ChatBlock` 与 `contentText` 实现，替代 v1 的 satori 元素渲染（319 行 → 60 行） |
| 消息池 | `message_log.ts`（容量、序号、去重、清空纪元）与 `message_log_registry.ts`（建池、回填缓冲、召回窗口、游标、整池释放）从 v1 迁移 |
| 回填 | 由框架按会话键与历史头读取，移除 v1 的频道绑定；失败保留实时缓冲并在下次 `warmup` 重试 |
| 会话生命周期 | 历史头变化与显式 reset/switch/fork 一律整池丢弃后按新历史重建；预设切换不影响池 |
| 测试 | 迁移 `message-log`、`message-log-registry`、`message-collector`、`element-text` 共 35 个用例；全套 59 个用例通过，`tsc --noEmit` 无报错 |

**未纳入本阶段**：`transcript_message`、`transcript_renderer`、`source_serializer`、`message_formatter`、`origin_context`、`message_log/converter` 与 `memory/helpers` 在 v2 中的消费者是提取与召回，随 S5 一起迁移，避免留下无人引用的模块。

`chat-middleware`、`character-middleware`、`chatluna-transcript-adapter` 三个 v1 测试验证的是中间件挂载与适配器接口，v2 中这两个对象都不存在；对应的入池规则与转写转换已由 `message-collector`、`message-log-registry` 覆盖，转换部分随 S5 迁移时补测。

### S4 模型与工具

langchain 在 v1 中被 21 个文件引用，`ctx.ai` 提供 `chatluna.extract(schema, {...})` 与 `chatluna.judge(...)` 两种结构化调用。工具从 langchain `tool()` 改为 `ctx.tools.define()`。

**已完成**（2026-11-04）：

| 项 | 结果 |
| --- | --- |
| 结构化输出 | `src/service/workflows/structured_output.ts` 以 `chatluna.extract(schema, …)` 实现，保留 v1 的三次尝试与纠正提示措辞；v2 没有 langchain 的暂存工具调用循环，模型调用失败改为同样重试 |
| 提示词与 schema | `src/service/prompts/schema.ts` 用 schemastery 重建字段约束；`memory_tools.ts` 把字段说明并入工具描述（v2 的 schema→JSON Schema 转换会丢弃 description，见框架需求 7） |
| 工具 | `src/service/memory/tools/` 注册 7 个模型工具：检索、读取来源消息、创建、更新、合并、拆分、删除；作用域取自 `agent.options`，子代理调用按 `permissions.origin` 拒绝；S4 的快照编辑函数 `createUpdateSnapshotTool` 已移除。现由 `src/service/workflows/recall/agentic_recall.ts` 的 `createRecallTools` 为召回流程提供快照工具 |
| 作用域适配 | 移除 v1 的 Character 预设后缀拼接：v2 的 Character 引擎把自己的预设 id 写入 `agent.options.presetId` |
| 日志 | `src/service/logging/` 提供 `LivingMemoryLogger`（凭据脱敏、循环引用、日志故障隔离）与 `invokeLoggedModel` |
| 向量索引 | `src/service/vector_index/` 从 v1 整体迁移（25 个文件），只替换 embedding 获取：`ctx.chatluna.embed` 包装成 `EmbeddingsLike`；数据目录改用 `resolveChatlunaDataDir` |
| Worker 打包 | `scripts/build-workers.mjs` 用模板项目的 rolldown 打包单文件产物；`npm run build` 后续衔接 |
| 装配 | `src/service/app/memory_providers.ts` 接通仓储、后端与索引；`src/service.ts` 启动向量索引，卸载时先停索引再注销 |
| 测试 | 新增 `structured-output`、`memory-tools`、`logging`、`update-snapshot-tool` 与 5 个向量索引测试；迁移 `legacy-embedding-migration`、`vector-index-dream-ann`、`vector-index-service`；全套 153 个用例中 152 通过、1 个仅 Windows 的目录切换用例跳过；`tsc --noEmit` 无报错 |

**暂未实现**：本阶段遗留的三项（工作流驱动工具、`searchHybrid` 生产接入、预设级串行写队列）已在 S5 补齐。

### S5 工作流

2026-11-06 范围更新：保留以下业务工作流实现；M06 仅重开框架历史读取、聊天消息计数与切换边界接入，不重做分块、失败处理和卸载取消。

迁移 `src/service/workflows/`（4701 行）：提取协调器、召回协调器、Dream 聚类与语义图谱、Dream session 与 worker、结构化输出。保留 v1 的窗口、分块、交流边界与失败处理，详见 [提取窗口与分块 Note](../.agent/note/proposed/architecture/2026-11-03-extraction-window-and-chunking.md)。

**已完成**（2026-11-05）。落地内容与验收依据：

| 项 | 结果 |
| --- | --- |
| 内部工具循环 | 新增 `workflows/tool_call.ts` 与 `workflows/tool_loop.ts`，自行驱动 `ctx.chatluna.chat`：一次模型调用 → 解析零个或多个工具调用 → 执行 → 追加结果。召回与 Dream 共用同一实现，差异由 `maxModelCalls`、`multipleToolCalls`、`conclusiveTools`、`prepareMessages`、`onRound` 等选项表达 |
| 不使用 v2 Agent | `AgentRegistry` 的 `AGENT_INJECT` 要求 9 个服务全部在场，本插件只注入 4 个；`chat-observer` 会索引每个带 `conversationKey` 的 agent，内部会话会污染用户消息池。Dream 的批次状态机、逐轮推进消息与历史压缩也无法用 turn driver 表达 |
| 提取 | `workflows/extraction/` 保留 v1 的窗口、吸收预算、锚定筛选、旁听切片与连续失败三次放弃；失败处理区分「未达上限中断本次排干」与「达上限记任务并推进游标」 |
| 召回 | `workflows/recall/` 的代理式召回改为 `LivingMemoryToolLoop`，模型调用上限 6 次，检索、更新快照、pass 三个工具以闭包持有作用域 |
| Dream | `workflows/dream/` 完整迁移聚类、语义图谱、会话与 Worker；会话工具改为 `LivingMemoryLoopTool`，批次状态、跳过条件与历史压缩沿用 v1 |
| 画像与人设 | `service/user_profile.ts` 与 `service/memory/preset_persona.ts` 经 `chatluna.extract` 取结构化结果；人设卡片新增 `resolvePresetAssistantLabel`，v2 的 Character 引擎直接用自己的预设 id，不再做后缀裁剪 |
| 结构化输出 | 只有解析与校验失败（`extract` 抛 `ProtocolError`）进入三次修正重试；模型请求本身失败原样抛出。此前实现把模型错误也纳入重试，导致人设卡片的 `invoke-failed` 分支不可达 |
| 写路径统一 | `app/memory_providers.ts` 删除自有写入实现，改为全部委托 `LivingMemoryMutationService`：预设级串行队列、落库后同步索引、索引失败转警告的语义只在那一处实现 |
| 装配 | `src/service.ts` 装配变更服务、混合检索、人设卡片、用户画像与三个协调器；启停顺序沿用 v1（先停 Dream 与画像，再停 Worker 与索引） |
| Worker 打包 | `scripts/build-workers.mjs` 增加 `dream-semantic-worker` 入口 |
| 测试 | 迁移并适配 `agentic-recall`、`extraction-coordinator`、`recall-coordinator`、`indexed-recall`、`indexed-memory-mutations`、`dream-*`、`post-extraction-dream`、`user-profile`、`preset-persona` 等 20 个文件；`tests/setup.ts` 增加 `it.each`、`vi.fn`、`expect`（含 `objectContaining`）兼容层。全套 338 个用例中 337 通过、1 个仅 Windows 的目录切换用例跳过；`tsc --noEmit` 无报错 |

**测试适配中的接口差异**：`MessageLogRegistry.register` 的第二参数由 v1 的「绑定 + bot」改为 `ConversationHistorySource`，回填改由框架历史接口读取；`chatluna.rerank(query, documents, options)` 返回与输入同序的 `scores`，替代 v1 langchain Reranker 的 `(index, relevanceScore)` 对；会话工具直接返回对象，不再返回 JSON 字符串。

### S6 调度与任务（历史交付，原生接入已撤除）

需要 M01-C1 的调度让出声明、M01-C2 的任务受理与取消、M01-C3 的原生页面接入。

**已完成**（2026-11-05）。插件侧能力全部落地；框架侧入口按 [框架侧接口需求](framework-requirements.md) 第 4—6 项实施。

| 项 | 结果 |
| --- | --- |
| 调度声明 | `LivingMemoryBackend.scheduling = { extract: true, dream: true, recall: true }`；契约形状由 `src/contracts/framework.ts` 的 `MemoryBackendScheduling` 声明，框架读取该字段后关闭原生的窗口提取、空闲/数量/夜间 Dream 与窗口召回，保留手动入口 |
| 任务状态 | `memoryJobStatuses` 增加 `cancelled`；取消原因写入 `error`，已产生的进度文本保留在 `detail` |
| 任务仓储 | 新增 `getJob`、`cancelJob`（只接受 `pending`/`running`）与 `watchJobs`；每次任务行变化通知订阅方 |
| 任务投影 | 新增 `src/service/app/job_view.ts`：审计行投影为原生 `MemoryJob`，补齐 `scope`、毫秒时间戳与由输入推导的 `trigger`；统计与操作明细留空，v1 把它们写在 `detail` 文本里 |
| 任务面 | 新增 `src/service/app/job_surface.ts`：`list`、`get`、`cancel`、`watch`，供框架把后端任务并入 `listJobs` 与 `chatluna/memory-job` |
| Dream 取消 | 协调器按任务持有 `AbortController` 与结算 Promise；`cancelJob(jobId)` 中止该次运行、等任务行落到终态、等预设队列释放后返回。用户取消抛 `DreamJobCancelledError` 记 `cancelled`，协调器停止仍按失败收尾。预设锁的释放移入队列任务内部，取消返回后可立即重启同一预设 |
| 提取与召回取消 | 两个协调器增加 `stop()`：停止接收新触发、取消在途模型调用、等待结算；取消不记失败任务、不推进游标、不提交未落库结果。提取器与召回执行器补上 `AbortSignal` 参数 |
| 卸载顺序 | 先并行停止 Dream、召回、提取与画像，再停止语义分组 Worker 与向量索引 |
| 测试 | 新增 `job-surface`；补充 `job-repository`、`dream-workflows`、`extraction-coordinator`、`recall-coordinator`、`backend` 的取消与调度声明用例。全套 354 个用例中 353 通过、1 个仅 Windows 的目录切换用例跳过；`tsc --noEmit` 无报错 |

**框架侧未就绪时的行为**：`scheduling` 与任务面是插件侧的声明与读取入口，框架未读取时原生调度仍会运行——此时同一输入可能触发两次提取。该状态只出现在框架接口落地前，验收要求以 M01-V1 为准。

**未纳入本阶段**：召回快照与画像注入到各引擎的上下文接入（M06-C1）属于执行时注入点，与调度归属分属不同接口；已在 S7 之前的采集与触发收尾中落地，见下节。

### S6.5 采集与触发收尾

**历史实现，消息接入待 D15 替换。** 以下保留 2026-11-05 为打通插件加载和会话钩子所做的交付。复制 observer 缓冲、从 Agent 补写末条回复和拼接历史窗口将替换为框架统一聊天历史读取。

S3 与 S5 各自完成单元级验证但拼不到一起：插件整体不加载，召回与提取也没有触发点。本节收尾这两处缺口，依据见 [会话钩子与采集层 Note](../.agent/note/proposed/architecture/2026-11-05-session-hooks-and-collector.md)。

**已完成**（2026-11-05）。

| 项 | 结果 |
| --- | --- |
| 加载阻塞 | `src/index.ts` 的 `inject` 列有 v2 不存在的 `chatluna_collector`，cordis 在依赖缺失时把 fiber 置为 `INACTIVE`，`apply` 从未执行。改为实际存在的 `chatluna`、`memory`、`database`、`chat_observer`、`agents` |
| 采集层 | `MessageCollector` 的数据源换成 `ctx.chat_observer` 的 `recentOfConversation` 与 `identityOfConversation`，由触发点按需拉取；跳过机器人 `self` 回声，回复改由 `recordReplies` 在轮次结束时从 `agent.session.messages()` 记一次 |
| 会话历史 | 新增 `transcript/message_log/session_history.ts`：会话 `ChatMessage` → 日志条目，跳过带 `form` 的注入消息。`recallWindow` 在池内不足时用它补足——观察层回填不进 `observed` 缓冲 |
| 会话钩子 | 新增 `session_hooks.ts`：`prepareStep(order 870)` 同步消息池、触发召回并注入快照与画像（只在该轮第一步）；`chatluna/agent-turn` 在 `completed` 时记录回复并调度提取 |
| 群名 | 提取来源标签取 `ctx.chat.environmentOf(sessionId)?.guildName`，与提示词渲染同源；取不到时用群号代替 |
| 测试 | 新增 `session-hooks`；`message-collector` 改为 `chat_observer` 形状的替身并补充会话历史补窗用例。全套 365 个用例中 364 通过、1 个仅 Windows 的目录切换用例跳过；`tsc --noEmit` 无报错，构建与 Worker 打包成功 |

### S7 管理与导入

迁移 `src/plugins/`（1417 行）与 `client/`。v1 使用 koishi-console，v2 使用 `@chatluna/ui-client`。旧数据导入覆盖记忆、来源、画像、人设与快照，对应 D05。

**已完成**（2026-11-05）。落地内容与验收依据：

| 项 | 结果 |
| --- | --- |
| 配置 | `src/index.ts` 的六组 schema（基础、模型、工具、用户画像、召回、提取），默认值统一取 `DEFAULT_CONFIG`；补上 `apply` 未把用户配置传给服务的问题 |
| 管理服务 | `src/service/app/admin_service.ts` 组合仓储、变更、检索、人设、画像、Dream 与索引的读写；预设列表取目录与库中存量的并集 |
| 配置自检 | `src/service/app/config_status.ts` 沿用 v1 三条规则（召回模型、嵌入模型、提取模型），并入 `MemoryServiceStatus` |
| 命令 | `src/service/app/commands.ts` 的 `/livingmemory <预设> delete <text\|user\|profile> <值>`，确认后归档记忆或删除画像；`-c` 选项因 v2 Character 引擎直接使用预设 id 而移除 |
| 管理页数据面 | `src/service/app/webui.ts` 提供预设、记忆、说话人、画像、人设、快照、任务及插件状态；写操作要求权限 4 |
| 管理页 | 记忆可手动新建、编辑与归档，按预设选择关联用户。列表分别展示摘要、正文、情绪与重要度。画像、人设卡片、快照、任务、召回测试各有独立面板；`/livingmemory` 挂在 capabilities 分组 |
| 旧数据导入 | `importPreset` 覆盖记忆、来源、画像与说话人卡片；补充缺省 `topic`/`title` 的推导，使 v1 版本 1—5 的导出文件导入后与新建行一致 |
| 启动与每日维护 | `src/service/app/maintenance.ts` 接回四项数据修复、全局中断任务回收、过期任务清理与到期归档记忆清理；此前这些方法没有任何调用点 |
| 快照与人设导出 | v1 的快照不进导出文件，人设卡片是预设级派生缓存，同样不进；两者沿用 v1 范围 |
| 结果 | 新增 5 个测试文件共 28 个用例；全套 393 个用例中 392 通过、1 个仅 Windows 的目录切换用例跳过，`tsc` 与客户端 `tsc` 均无报错，模板 `yarn yakumo build` 与 Worker 打包成功 |

**未覆盖**：

| 项 | 现状 |
| --- | --- |
| 配置文件迁移 | v1 的 koishi 配置项按同名映射，v2 未提供自动读取旧配置文件的通道，需用户在配置中重填 |

### S8 验收

跨引擎运行、生命周期验证、D11 行为对照，以及发布产物检查。

**进行中**（2026-11-05）。已完成的核对项：

| 项 | 结果 |
| --- | --- |
| 测试迁移台账 | 48 个 v1 文件中 42 个同名迁移、4 个并入既有测试、2 个删除；v2 另有 9 个新增文件。并入与删除的行为承接关系记录在 `implemented/architecture/2026-11-04-test-migration-strategy.md` |
| 业务行为对照 | 原阶段记录：B01—B14 的断言在对应测试中逐项落地，业务差异为 D14（结构化输出不做字符串化解码）；2026-11-06 新确认 D15 消息来源改造，相关断言与联调待更新 |
| 生命周期 | 启动顺序、启动维护、失败时的资源释放由 `maintenance.spec.ts` 与 `service.ts` 的显式顺序覆盖 |
| 发布产物 | `yarn yakumo build` 产出 `lib/` 与 `dist/client.js`，Worker 打包产出两个 `*.mjs` |
| 配置默认值 | M08-D1 已确定，`DEFAULT_CONFIG` 与 schema 说明一致，`README.md` 的配置表同步 |

由用户执行的人工验收项：

| 项 | 内容 |
| --- | --- |
| 跨引擎实际运行 | 在装有 `agent`、`coding`、`character` 三种引擎的宿主里各跑一轮对话，观察采集、注入与提取 |
| 界面人工验收 | 启动 WebUI 逐个确认六个面板、写操作权限与刷新行为 |

## 向量索引

`src/service/vector_index/`（4708 行）保留 v1 实现，只替换 embedding 调用层，作为独立工作线并入 S1—S5，不单列阶段。依据见 [向量索引保留 Note](../.agent/note/proposed/architecture/2026-11-04-vector-index-retention.md)。

## 测试处置

按模块随源码一起迁移，不设"最后统一补测试"的阶段。三档处置与文件清单见 [测试迁移策略 Note](../.agent/note/implemented/architecture/2026-11-04-test-migration-strategy.md)。

## 提交粒度

一个阶段可以拆成多次提交，但每次提交必须满足：源码与其测试同期落地，仓库在该提交点能跑通全部测试。提交信息按阶段与模块标注，便于回溯。

## 阻塞项

| 阶段 | 阻塞项 | 对应框架侧子项 |
| --- | --- | --- |
| M05、M06 重新接入 | 本地实现已完成，模板 vendor/node_modules 已同步新框架产物，框架及插件构建通过，测试待执行 | M05-C1/C2 |
| M02、M06 重新接入 | 事件边界与重新计数已接入；跨引擎、分支和卸载运行验收待执行 | M02-C1、M06-C1 |
