# 实施阶段划分

状态：草案。更新日期：2026-11-04。总进度见 [迁移方案](migration-plan.md)。

本文把 M01—M09 的工作项按"可独立验证"重新切成实施阶段。阶段编号只描述推进顺序，不替代迁移方案中的任务编号；每个阶段的验收仍对应 Mxx-Vy 项。

## 阶段

| 阶段 | 内容 | 涉及 M | 完成后可验证 | 依赖框架侧 |
| --- | --- | --- | --- | --- |
| S1 | 数据层：表定义、仓储、事务、迁移记录 | M03 | 建表、读写往返、旧数据导入的字段映射 | 否 |
| S2 | 后端适配：实现 `MemoryBackend` 全套方法与注册 | M01-L1、M03 | 原生页面可选到后端，原生工具可增删改查 | 否 |
| S3 | 采集层：消息池、回填、去重、游标、纪元 | M05 | 各引擎消息进入同一池 | 是，M05-C1/C2 |
| S4 | 模型与工具：langchain 换 `ctx.ai`，zod 换 Schema，工具改注册 | M04 | 单次提取与召回可用真实模型跑通 | 否 |
| S5 | 工作流：提取、召回、Dream、画像、人设 | M06、M07 | 业务闭环可用，与 v1 行为对照 | 部分，M06-C1 |
| S6 | 调度与任务：让出原生调度、稳定任务 ID、卸载取消 | M01 | 自动流程只触发一次，两个页面任务一致 | 是，M01-C1/C2/C3 |
| S7 | 管理与导入：WebUI、命令、配置、旧数据导入 | M08 | 管理端可用，旧数据进入新流程 | 否 |
| S8 | 验收：跨引擎、生命周期、D11 行为对照 | M09 | 迁移完成 | — |

S1、S2 与框架侧无关，可立即开始。S3 依赖统一采集与交付归属接口，S6 依赖调度归属与任务受理接口，对应需求见 [框架侧接口需求](framework-requirements.md)。

## 各阶段交付物

### S1 数据层

迁移 `src/service/persistence/`（2784 行）：表定义、条目仓储、任务仓储、快照仓储、画像仓储、来源与规范化、维护与清理。v1 使用 koishi 的 `ctx.model.extend` 与 `database.get/create/set`，v2 的 `@cordisjs/plugin-database` 提供同名 API，`packages/conversations/core/src/database.ts` 是现成范例。

同一提交内迁移以下测试：`query`、`query-projections`、`repository-maintenance`、`snapshot-repository`、`user-profile`、`user-profile-repository`、`job-repository`、`memory-entry-fields`。

### S2 后端适配

实现 `MemoryBackend` 接口。`packages/memory/core/src/types.ts` 定义签名，`packages/memory/core/src/markdown.ts`（674 行）是完整的参考实现。需要处理 `index()` 的预算语义、`watch()` 的变更通知、`history()`/`revert()` 的版本能力，以及 `export`/`import` 的格式。

### S3 采集层

迁移 `src/service/transcript/`（1352 行）：消息日志、注册表、回填、规范化、去重、序号。v1 有三个采集入口（普通对话中间件、Character 中间件、平台消息采集器），v2 合并为对 observer 的单一订阅。

阻塞点：需要 M05-C1 的观察事件与可见历史接口。接口未就绪前可用 `recentOfConversation` 轮询，但那只是临时适配，不写入设计。

### S4 模型与工具

langchain 在 v1 中被 21 个文件引用，`ctx.ai` 提供 `chatluna.extract(schema, {...})` 与 `chatluna.judge(...)` 两种结构化调用。工具从 langchain `tool()` 改为 `ctx.tools.define()`。

### S5 工作流

迁移 `src/service/workflows/`（4701 行）：提取协调器、召回协调器、Dream 聚类与语义图谱、Dream session 与 worker、结构化输出。保留 v1 的窗口、分块、交流边界与失败处理，详见 [提取窗口与分块 Note](../.agent/note/proposed/architecture/2026-11-03-extraction-window-and-chunking.md)。

### S6 调度与任务

需要 M01-C1 的调度让出声明、M01-C2 的任务受理与取消、M01-C3 的原生页面接入。

### S7 管理与导入

迁移 `src/plugins/`（1417 行）与 `client/`。v1 使用 koishi-console，v2 使用 `@chatluna/ui-client`。旧数据导入覆盖记忆、来源、画像、人设与快照，对应 D05。

### S8 验收

跨引擎运行、生命周期验证、D11 行为对照，以及发布产物检查。

## 向量索引

`src/service/vector_index/`（4708 行）保留 v1 实现，只替换 embedding 调用层，作为独立工作线并入 S1—S5，不单列阶段。依据见 [向量索引保留 Note](../.agent/note/proposed/architecture/2026-11-04-vector-index-retention.md)。

## 测试处置

按模块随源码一起迁移，不设"最后统一补测试"的阶段。三档处置与文件清单见 [测试迁移策略 Note](../.agent/note/proposed/architecture/2026-11-04-test-migration-strategy.md)。

## 提交粒度

一个阶段可以拆成多次提交，但每次提交必须满足：源码与其测试同期落地，仓库在该提交点能跑通全部测试。提交信息按阶段与模块标注，便于回溯。

## 阻塞项

| 阶段 | 阻塞项 | 对应框架侧子项 |
| --- | --- | --- |
| S3 | 无公共观察事件，无按会话+历史的可见历史接口，无交付归属字段 | M05-C1、M05-C2 |
| S3 | 无会话 reset/switch/fork 通知，无预设实际生效通知 | M02-C1 |
| S6 | 后端无法声明调度归属 | M01-C1 |
| S6 | 任务 ID 不可预派，`extract` 无取消信号 | M01-C2、M06-C1 |
| S6 | 原生任务页只读 `listJobs` | M01-C3 |