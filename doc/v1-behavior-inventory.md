# LivingMemory v1 业务行为清单

状态：**初始清单，核对中**。对应迁移原则：D11。更新日期：2026-11-04。

本清单用于执行 v1 → v2 迁移前的行为盘点。清单中的“保留”表示迁移后仍需保持 v1 的可观察业务语义；v2 侧的接口、服务生命周期、消息接入、作用域和模型调用属于承载方式。每一项在实施前补齐触发条件、输入范围、状态变化、持久化结果、失败处理、用户可见结果、v1 源码/测试证据和 v2 适配位置。

## 盘点状态

- [ ] **D11-L1**：完成下表每项的源码、测试、配置、数据和管理入口核对。
- [ ] **D11-L2**：为每项填写 v2 适配接口、负责模块和跨引擎覆盖范围。
- [ ] **D11-V1**：建立 v1 与 v2 的行为对照验证，记录保持、适配或经独立决策批准的变化。
- [ ] **D11-V2**：确认旧数据、旧配置和旧任务记录能够进入对应的 v2 业务流程。

## 行为目录

| 编号 | v1 业务范围 | 需要保留的行为 | v1 核对入口 | v2 迁移归属 | 状态 |
| --- | --- | --- | --- | --- | --- |
| B01 | 插件装配与配置 | 配置 schema、默认值、开关、白名单、模型配置、可选服务和配置状态提示 | `src/index.ts`、`src/service/app/config_status.ts`、`tests/config-status.spec.ts` | M01、M04、M08 | [ ] |
| B02 | 统一消息采集 | ChatLuna 对话、Character 对话、平台旁听、实际回复、未触发回复的消息、历史回填、规范化、顺序、去重、容量淘汰和清空纪元 | `src/plugins/message_collector.ts`、`src/plugins/chat_middleware.ts`、`src/plugins/character_middleware.ts`、`src/service/transcript/message_log/`、`tests/message-collector.spec.ts`、`tests/message-log*.spec.ts` | M02、M05 | [ ] |
| B03 | 会话与预设作用域 | 会话键、预设键、群聊/私聊、用户身份、Character 映射、跨引擎共享、历史切换、分支和重置边界 | `src/service/app/scope.ts`、`src/service/memory/helpers.ts`、`src/contracts/memory.ts`、`tests/character-middleware.spec.ts`、`tests/chat-middleware.spec.ts` | M02、M05 | [ ] |
| B04 | 召回与上下文注入 | 召回触发间隔、消息锚点、混合检索、重排序、Agentic Recall 工具循环、快照保存/更新、画像和人设注入 | `src/service/workflows/recall/`、`src/service/app/prompt_hydration.ts`、`src/service/memory/tools/`、`tests/recall-coordinator.spec.ts`、`tests/agentic-recall.spec.ts` | M04、M06、M07 | [ ] |
| B05 | 自动提取 | 阈值、完整交流、旁听末尾用户段、窗口与分块、游标、批次上界、有效空结果、条件不足、失败重试、跳过、来源记录和提取后回调 | `src/service/workflows/extraction/`、`tests/extraction-coordinator.spec.ts`、`tests/extraction-prompt.spec.ts` | M05、M06 | [ ] |
| B06 | Dream 与后处理 | 手动/自动触发、增量与全量范围、串行任务、聚类、容量约束分组、工具会话、上下文压缩、取消、统计、失败和提取后联动 | `src/service/workflows/dream/`、`tests/dream-*.spec.ts`、`tests/post-extraction-dream.spec.ts`、`docs/dream.md` | M01、M04、M07 | [ ] |
| B07 | 用户画像与人设 | 说话人注册、身份核对、画像生成/更新/删除、画像注入、人设卡生成/读取/编辑/重置及生命周期 | `src/service/user_profile.ts`、`src/service/memory/preset_persona.ts`、`src/service/persistence/user_profiles.ts`、`src/service/persistence/preset_personas.ts`、`tests/user-profile*.spec.ts`、`tests/preset-persona.spec.ts` | M02、M03、M04、M07 | [ ] |
| B08 | 记忆数据与来源 | 记忆字段、状态、来源文本和来源关系、说话人关联、创建/更新/合并/拆分/归档/删除、快照、事务和旧格式导入 | `src/contracts/memory.ts`、`src/service/persistence/`、`src/service/memory/origins/`、`tests/indexed-memory-mutations.spec.ts`、`tests/preset-import-export.spec.ts`、`tests/source-origins-migration.spec.ts` | M03、M07、M08 | [ ] |
| B09 | 向量索引与同步 | 索引文档、嵌入、关键词与向量混合查询、增量同步、对账、重建、目录所有权、Worker、就绪状态和失败恢复 | `src/service/vector_index/`、`tests/vector-index-*.spec.ts`、`docs/vector-index.md` | M03、M07、M09 | [ ] |
| B10 | 模型调用与结果校验 | 提示词、结构化输出 schema、工具调用、一次纠错、模型不可用/请求失败/解析失败、用量和日志记录 | `src/service/prompts/`、`src/service/workflows/structured_output.ts`、`src/service/logging/model_calls.ts`、`tests/structured-output.spec.ts`、`tests/prompt-contracts.spec.ts` | M04、M06、M07 | [ ] |
| B11 | 记忆工具与命令 | 主对话工具范围、搜索、来源消息、创建、更新、合并、拆分、删除、快照编辑、确认无变更，以及管理命令语法和结果 | `src/service/memory/tools/`、`src/plugins/living_memory_tools.ts`、`src/plugins/commands.ts`、`tests/memory-tools.spec.ts`、`tests/memory-create-tool.spec.ts` | M01、M07、M08 | [ ] |
| B12 | WebUI 与 RPC | 记忆、快照、画像、人设、任务、检索测试、索引状态、分页、编辑、清理确认、错误展示和国际化 | `src/contracts/rpc.ts`、`src/plugins/webui.ts`、`client/`、`tests/client-dashboard.spec.ts`、`docs/WEBUI_GUIDE.md` | M08、M09 | [ ] |
| B13 | 任务、日志与生命周期 | 任务受理/运行/完成/失败/取消、统一任务引用、诊断事件、服务启动/停止、排空、资源释放、在途调用和失败可查询性 | `src/service/workflows/job_tracker.ts`、`src/service/logging/`、`src/service/app/living_memory_service.ts`、`tests/living-memory-service-lifecycle.spec.ts`、`docs/logging.md` | M01、M06、M07、M09 | [ ] |
| B14 | 数据迁移与兼容 | v1 记忆、画像、来源、快照、人设、索引和配置的导入、映射、备份、重复执行和恢复 | `src/service/persistence/entries.ts`、`src/service/persistence/repository.ts`、`tests/legacy-embedding-migration.spec.ts`、`tests/source-origins-migration.spec.ts` | M03、M08、M09 | [ ] |

## 核对规则

1. 先阅读 v1 源码和测试，再为 v2 设计接口；v2 已有功能不能代替 v1 行为证据。
2. 同一行为同时核对服务端、客户端、配置、持久化、任务和引擎接入；只迁移其中一层视为未完成。
3. `agent`、`coding`、`character` 等引擎都要填写适配入口。v1 没有直接对应的引擎实现时，记录由 ChatLuna v2 公共契约承载的兼容路径。
4. 发现行为差异时标记为“适配差异待决策”，记录旧行为、新行为、原因、影响和验收条件；未确认前不把差异写成实现目标。
5. 本清单完成后，回填 [迁移方案](migration-plan.md) 对应工作项的实施前置和验收编号。
