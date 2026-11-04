# 变更记录

## 2026-11-04 version:0.0.0

- pending: 新增 `doc/framework-requirements.md`，按 M01-C1/C2/C3、M02-C1、M05-C1/C2、M06-C1 列出 ChatLuna v2 需补充的接口项、当前源码事实与验收条件；同步 `AGENTS.md` 目录树与文档索引。
- pending: 新增 `doc/migration-stages.md`，把 M01—M09 重新切分为 S1—S8 实施阶段，给出各阶段交付物、模块归属、向量索引与测试处置、提交粒度和阻塞项。
- pending: 新增两篇 Agent Note：`2026-11-04-vector-index-retention.md` 记录保留 v1 向量索引、只替换 embedding 层的决策依据；`2026-11-04-test-migration-strategy.md` 给出 48 个测试文件的三档处置与文件清单。
- pending: `doc/migration-plan.md` 新增已确认事项 D12（向量索引保留）与 D13（测试迁移策略）。
- pending: 完成 S1 数据层迁移。从 v1 移植 `src/contracts/`（4 个文件）、`src/query.ts`、`src/service/{app,memory,persistence,shared,workflows}/` 共 23 个源文件；koishi 的 `Context` 换成 cordis，`ctx.database` 改为经 `ctx.get('database')` 访问，相对 import 补 `.ts` 后缀。
- pending: 表定义改用 v2 的 `ctx.model.extend` / `ctx.model.migrate`，并为 8 张表声明 `Tables` 模块增强，使查询带类型。
- pending: 测试运行器由 vitest 换成 `node --test --experimental-transform-types`；新增 `tests/setup.ts` 把 `it`/`describe` 装回全局，兼容 v1 测试体，不引入新依赖。
- pending: 迁移 `query`、`query-projections`、`repository-maintenance`、`snapshot-repository`、`user-profile-repository`、`job-repository` 六个测试文件，17 个用例全部通过；`job-repository` 的首个用例改用统一测试环境。
- pending: 新增 `.gitignore`；`package.json` 增加 `test` 脚本与数据库相关依赖；`tsconfig.json` 开启 `allowImportingTsExtensions`。
- pending: 完成 S2 后端适配。新增 `src/service/backend.ts` 实现 v2 `MemoryBackend` 的 14 个方法，`src/service.ts` 持有仓储与后端并通过 `ctx.memory.backend` 注册，入口改用 `ctx.effect` 管理注销。
- pending: 记忆表增加 `topic`/`title`/`fields` 三列以匹配 v2 的 `MemoryEntry`；新增 `src/service/memory/entry_identity.ts` 定义主题与标题的确定性推导，旧行读取时按同一规则补齐标题。
- pending: 导出格式增加 `topic`/`title`/`fields` 可选字段，旧导出文件按缺省规则导入；`createMemory` 支持显式 id，用于保持导入时的原有身份。
- pending: 新增 `tests/backend.spec.ts` 共 7 个用例，覆盖主题标题推导、作用域过滤、面统计、检索、归档删除与变更通知、字段更新、索引分组与导出导入往返；全套 24 个用例通过。
- pending: 完成 S3 采集层。新增 `src/service/message_collector.ts`，把框架的观察、交付与会话变化事件统一接入 `MessageLogRegistry`，各引擎共用同一套入池、回填、去重与读取逻辑；`src/service.ts` 随之持有采集层，`src/index.ts` 增加对 `chatluna_collector` 的依赖声明。
- pending: 新增 `src/contracts/framework.ts` 声明框架侧待补的采集、交付与变化契约（对应 `doc/framework-requirements.md` 的 M05-C1、M05-C2、M02-C1），上游落地后改为从 `@chatluna/*` 导入即可。
- pending: `src/service/transcript/element_text.ts` 改为基于 v2 已归一化的 `ChatBlock` 渲染日志文本，替换 v1 按 satori 元素类型逐项解析的 319 行实现。
- pending: 消息池的历史回填改由框架的可见历史接口按会话键与历史头读取，移除 v1 的频道绑定与 `toBackfillChannelId`；历史头变化（重置、切换、分支）时整池丢弃并按新历史重建，避免旧分支内容混入。
- pending: 修正回填失败后 `warmup` 不重试的问题：失败时保留实时缓冲并复位状态，下次预热按历史、实时顺序重新入账。
- pending: 迁移 `message-log`、`message-log-registry`、`message-collector`、`element-text` 四个测试文件共 35 个用例；全套 59 个用例通过，`tsc --noEmit` 无报错。
- pending: 完成 S4 模型与工具。新增 `src/service/workflows/structured_output.ts`，以 v2 的 `chatluna.extract(schema, …)` 实现结构化输出，保留 v1 的三次尝试、纠正提示措辞与取消传播；v2 无 langchain 的暂存工具调用循环，模型调用失败改为一并重试。
- pending: 新增 `src/service/prompts/` 四个文件，用 schemastery 重建记忆生成 schema、工具参数说明、提示词 XML 片段与记忆渲染；字段约束说明并入工具描述，规避 v2 `schemasteryToJsonSchemaNode` 丢弃 description 的问题（框架需求见 `doc/framework-requirements.md` 第 7 节）。
- pending: 新增 `src/service/memory/tools/`，注册检索、读取来源消息、创建、更新、合并、拆分、删除 7 个模型工具；作用域从 `agent.options` 解析，子代理调用按 `permissions.origin` 拒绝；删除 v1 的 Character 预设后缀拼接，v2 Character 引擎已写入自己的预设 id。
- pending: 新增 `src/service/logging/`，`LivingMemoryLogger` 负责诊断块格式化、凭据脱敏、循环引用处理与日志故障隔离；`invokeLoggedModel` 统一记录模型调用。
- pending: 从 v1 整体迁移 `src/service/vector_index/` 共 25 个文件，保留 PGlite + pgvector 索引、重建对账、目录切换与 Dream 近邻维护；embedding 层改由 `ctx.chatluna.embed` 提供，数据目录改用 `resolveChatlunaDataDir` 解析 `CHATLUNA_DATA`。
- pending: 新增 `scripts/build-workers.mjs`，用模板项目的 rolldown 打包 Vector Worker 单文件产物；新增 `src/worker_artifacts.ts` 统一解析产物路径；`package.json` 增加 `@electric-sql/pglite`、`@electric-sql/pglite-pgvector` 依赖与 `rolldown` 开发依赖。
- pending: 新增 `src/service/app/memory_providers.ts` 接通仓储、后端与向量索引，保持「主数据已提交、索引失败只记警告」的 v1 语义。
- pending: `src/service.ts` 改为在启动时注册后端、采集与工具并启动向量索引，卸载时先停索引再注销；此前向量索引未启动，记忆写入会因索引未就绪而失败。`src/index.ts` 相应改为调用 `start()`。
- pending: 新增 `structured-output`、`memory-tools`、`logging`、`update-snapshot-tool`、`vector-index-worker`、`vector-index-hybrid-query`、`vector-index-status-store`、`vector-index-rebuild`、`vector-index-directory-switch` 测试；迁移 `legacy-embedding-migration`、`vector-index-dream-ann`、`vector-index-service`；vitest 的 `vi.spyOn` 改为 `node:test` 的 `mock.method`。全套 153 个用例中 152 个通过，1 个仅 Windows 的目录切换用例跳过；`tsc --noEmit` 无报错。