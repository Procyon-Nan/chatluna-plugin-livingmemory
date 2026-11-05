# ChatLuna v2 框架侧接口需求

状态：草案。更新日期：2026-11-05。

本文把 [迁移方案](migration-plan.md) 中由 ChatLuna v2 承担的接口项单独列出，供框架侧实施。每项给出当前源码事实、需要补充的契约和验收条件。路径相对于 v2 源码 `packages/`。

## 1. 统一消息采集（M05-C1）

**当前事实**

- `chat/observer/src/service.ts` 在 `message`、`middleware`、`chat/before-receive`、`chat/receive`、`send` 上被动观察，只对外暴露拉取式 `recentOfConversation(key, limit)` 与 `channelOf`，没有“消息已入池”的公共事件。
- `ObservedMessage` 含 `id`、`cid`、`routeId`、`platformMessageId`、`time`、`userId`、`name`、`self`、`backfilled`、`content`，不含会话键、历史 session 和实际预设。
- 没有活跃 Agent 时消息仍会被 `_onMessage` 记入通道缓冲，但消费方无法得到通知。

**需要补充**

1. 公共事件 `chatluna/observed`，参数为单条 `ObservedMessage`，在每次 `channels.observe` 后发出，包含旁听消息、自身回声与回填消息，并用 `backfilled` 区分。
2. 事件载荷补充 `conversationKey`、`sessionId`（当前历史头）、`routeId`、`platform`，与 `recentOfConversation` 的键一致。
3. 公共读取接口按 `conversationKey` 与 `sessionId` 返回可见历史（含平台历史回填能力声明），返回 `ObservedMessage`，附带分页。

**验收**

- 未触发引擎回复的群消息、无活跃 Agent 的消息都能通过事件到达订阅方。
- 同一消息在事件与 `recentOfConversation` 中身份一致；回填消息带 `backfilled: true` 且不计入实时序。

## 2. 交付归属（M05-C2）

**当前事实**

- `chat/core/src/session.ts` 的 `SentInfo` 为 `{ source, command?, own, messageIds, content }`，`emitSent()` 在 `chatSent` 上附加。
- 来源分类为 `chat`、`command`、`plugin`、`schedule`；`own` 仅表示由对话回复发出。
- 没有对“本次交付对应哪条入站请求或哪个轮次”的关联字段。

**需要补充**

1. `SentInfo` 增加 `conversationKey`、`sessionId`、`presetId`（本轮实际生效值）与 `replyTo`（被回复的入站消息 ID 或轮次号）。
2. 分句、分段发送时，每一段都携带同一 `replyTo` 与同一 `presetId`。

**验收**

- 一次回复被切成多段时，订阅方可用 `replyTo` 归并到同一轮次。
- 预设切换后仍在发送的回复，其 `presetId` 为原请求的预设，不取发送时的最新配置。

## 3. 会话与预设变化通知（M02-C1、M06-C1）

**当前事实**

- `conversations/core/src/service.ts` 的 `reset()`、`switch()`、`fork()` 只改历史头，不发出任何事件；唯一事件是 `chatluna/sessions-indexed`。
- `session/core/src/service.ts` 的 `branch()` 发出 `chatluna/session-branch`（`{ parent, session, at }`），但 `conversations.fork()` 不额外通知。
- `engine/core/src/index.ts` 的 `switchPreset()` 只写 `slot.pending`，`switchAtTurnStart()` 在下一轮开始才应用，并写入 `preset/selected` 标记；没有对外事件。

**需要补充**

1. `conversations` 在 `reset`、`switch`、`fork` 完成后发出事件，载荷含 `conversationKey`、`previousSessionId`、`currentSessionId`、`reason`（`reset`/`switch`/`fork`），保证与入池顺序可核对。
2. 预设实际生效时发出 `chatluna/preset-applied`，载荷含 `conversationKey`、`sessionId`、`presetId`、`turn`；与 `preset/selected` 标记同批写入。
3. 提供只读查询：给定 `conversationKey` 返回当前历史头与当前生效预设，供无 Agent 场景使用。

**验收**

- `reset`/`switch`/`fork` 与 `preset-applied` 的先后顺序在订阅方可复现，且与消息入池顺序一致。
- 同一会话连续 A → B → A 时，收到两次 `preset-applied`，消费方可据此各建新起点。

## 4. 后端调度归属（M01-C1）

**当前事实**

- `memory/core/src/extract.ts` 用 `prepareStep(order: 890)` 自行维护每会话游标，达到 `extractWindow` 后调用 `memory.extract(agent)`；若后端提供 `extract` 则提前返回，但阈值判断与游标仍由原生执行。
- `memory/core/src/consolidate.ts` 自行管理空闲定时器、数量阈值与夜间区间，在 `chatluna/memory-change` 与 30 秒轮询中触发；后端 `dream()` 也在这条链路内被调用。
- `memory/core/src/service.ts` 的 `onExtract`/`onDream` 各只保存一个处理器。

**LivingMemory 侧已就绪**

`LivingMemoryBackend` 提供一个只读字段，声明三项自动入口的归属：

```ts
readonly scheduling = { extract: true, dream: true, recall: true }
```

`true` 表示该入口由后端负责。插件侧契约在 `src/contracts/framework.ts` 的 `MemoryBackendScheduling`，与下方建议形状一致；框架落地后改为从 `@chatluna/memory` 导入。

**需要补充**

1. `MemoryBackend` 增加声明字段（如 `scheduling?: { extract?: boolean; dream?: boolean; recall?: boolean }`），为 `true` 时原生对应自动入口整体让出：不建游标、不建定时器、不做阈值判断。
2. 让出后原生仍保留手动入口（`ctx.memory.extract`、`ctx.memory.dream`）。
3. 后端切换时，原生按已让出的入口停用与恢复，不重复注册定时器。

**验收**

- 选择 LivingMemory 后，原生不再触发窗口提取、空闲 dream、数量 dream 与夜间 dream；切回原生后端后恢复。
- 原生手动提取与手动 dream 在两种模式下都可用。

## 5. 任务受理、状态与取消（M01-C2、M06-C1）

**当前事实**

- `MemoryService.runJob()` 内部生成 `job_${Date.now()}_${size+1}`，返回 `{ job, stats }`，调用方无法预派任务 ID，也没有取消入口。
- `MemoryJob` 的 `status` 有 `pending`/`running`/`completed`/`partial`/`failed`，`trigger` 为 `idle`/`nightly`/`size`/`manual`/`window`；`partial` 未被使用。
- `MemoryBackend.extract(scope, messages)` 无 `AbortSignal`；`dream(presetId, signal)` 有。
- `packages/memory/core/src/jobs.ts` 在加载时把遗留 `running` 记为 `failed`（`interrupted by restart`）。

**需要补充**

1. `MemoryBackend.extract` 增加 `signal: AbortSignal`（放在 options 上，避免位置参数破坏现有实现）。
2. 新增受理接口：后端可先登记一次执行并拿到稳定 `jobId`，再交给 `runJob` 使用该 ID；`runJob` 接受可选 `jobId` 与 `AbortSignal`。
3. 新增取消入口 `cancelJob(id)`，把 `status` 置为终止态并触发取消信号；终止态在 `MemoryJobStatus` 中明确定义，同时补上 `partial` 的使用或移除。
4. `listJobs(presetId?)` 与 `chatluna/memory-job` 事件保持现有形状，供原生页面与专用页面共用。

**验收**

- 页面可先取得任务 ID 再展示排队状态，最终状态由同一 ID 查询或事件更新。
- 取消后不推进游标、不重试，尚未提交的结果不落库；已提交主数据不回滚。
- 插件卸载时原生等待在途任务收尾，再释放后端实例。

**LivingMemory 侧已就绪**

- 任务状态增加 `cancelled`；取消原因写入 `error`，已产生的进度文本保留在 `detail`。
- 提取、召回、Dream 三个协调器都有 `stop()`：停止接收新触发、取消在途模型调用、等待结算。Dream 另支持按任务取消，`DreamJobCancelledError` 区分「用户取消」与「服务停止」——前者记 `cancelled`，后者沿用 v1 记 `failed`。
- 取消不写失败任务、不推进消费游标、不提交尚未落库的结果；已提交的主数据不回滚。
- 后端侧已具备投影与订阅（`src/service/app/job_view.ts`、`job_surface.ts`）。**需要框架补的是入口**：`MemoryService` 没有读取后端任务的通道，页面的 `memory.jobs.run` 依赖 `listJobs()` 前后差集，后端任务因此永远不在其中。

## 6. 原生任务页面读取后端任务（M01-C3）

**当前事实**

- `plugins/memory/webui/src/index.ts` 的状态源是 `memory.listJobs(presetId)`，刷新依赖 `chatluna/memory-job`；`memory.jobs.run` 通过 `listJobs()` 的前后差集找到新任务。
- `memory.jobs.undo` 依赖 `MemoryJob.operations`，该字段由 `runJob` 用前后导出差异生成。

**需要补充**

- 后端任务与原生任务用同一 `MemoryJob` 形状进入 `listJobs`。若后端自己写入 `operations`，`runJob` 的差异计算需跳过；否则保持原生差异计算，后端只负责执行。
- 原生页面只展示，不解释后端专有字段。

**验收**

- LivingMemory 自动任务出现在原生任务列表，状态、错误与统计与专用页面一致。
- `memory.jobs.run` 对后端任务返回同一个判定的新任务。

**LivingMemory 侧已就绪**

投影后的任务形状：

| 字段 | 来源 |
| --- | --- |
| `id` / `presetId` / `kind` / `status` / `error` | 任务审计行原样 |
| `scope` | `{ presetId, conversationId }` |
| `trigger` | Dream 的 `post-extraction:*` 输入 → `window`，其余 Dream → `manual`；提取与召回 → `window`；索引 → `manual` |
| `startedAt` / `finishedAt` | 毫秒时间戳；`pending` 行以 `createdAt` 顶替 `startedAt` |
| `stats` / `operations` | 留空。v1 把统计写在 `detail` 文本里，操作明细由 Dream 会话记录持有 |

后端订阅入口为 `LivingMemoryJobSurface.watch(listener)`，框架接到 `chatluna/memory-job` 后即可驱动页面刷新；`list`、`get`、`cancel` 三者同理。页面上的「撤销」对后端任务不可用（`operations` 为空），这是有意保留的差异：v1 没有逐条差异撤销能力。

取消按任务类型分流：`dream` 中止在途运行并等任务行落入 `cancelled`；`index` 运行在向量索引的维护队列内、没有逐任务中止信号，取消返回 `undefined` 而不是标记终态（否则会与运行器的收尾写入互相覆盖）；`extract`/`recall` 只在失败时落任务行，残留的未结束行没有在途执行，直接置终态。框架侧遇到 `undefined` 时向页面报告「该任务不可取消」。

## 7. 工具参数 schema 保留字段说明（M04）

**当前事实**

- `packages/core/schema/src/json-schema.ts` 的 `convertString` / `convertNumber` / `convertArray` 只输出 `type`、`min`、`max`、`pattern`、`minItems`、`maxItems`，`meta.description` 没有被写出。
- 实测 `Schema.object({ a: Schema.string().description('说明A') })` 经 `schemasteryToJsonSchemaNode` 得到 `{"type":"object","properties":{"a":{"type":"string"}},...}`，说明字段消失。
- v1 用 zod 的 `.describe()` 承载行为约束，例如记忆检索的「必须是完整句子结构」与「避免以用户名作为关键词」、记忆正文的第一人称与字数要求。这些说明是模型行为的一部分，属于 D11 基线。

**需要补充**

- `convertString`、`convertNumber`、`convertArray`、`convertObject`、`convertUnion`、`convert` 的 `const` 分支在 `meta.description` 存在时输出 `description` 字段，`Schema <-> JsonSchema` 双向转换（`packages/core/schema/src/subset.ts` 的 `withCommon` 已支持读取）保持一致。

**验收**

- `Schema.object({ a: Schema.string().description('说明') })` 转换后 `properties.a.description` 等于 `'说明'`。
- 工具注册后 `toolSpec().parameters` 与 `describe()` 的输出都带字段说明。

## 依赖关系

1 → 3 是 M05/M02 的前置；4 → 5 → 6 是 M01 的实施顺序。7 独立，影响 M04 的工具契约保真。M06 的重新计数依赖 1、2、3 全部落地。

## 实施状态

| 项 | 插件侧 | 框架侧 |
| --- | --- | --- |
| 1 统一消息采集 | 已按契约形状实现（S3） | 待补 |
| 2 交付归属 | 已按契约形状实现（S3） | 待补 |
| 3 会话与预设变化 | 已按契约形状实现（S3） | 待补 |
| 4 调度归属 | 已声明 `scheduling`（S6） | 待补：原生读取该字段并让出调度 |
| 5 任务受理、状态与取消 | 已实现 `cancelled`、`getJob`、`cancelJob`、`watchJobs`（S6） | 待补：`runJob` 接受预派 `jobId` 与信号、`extract` 接受信号、取消入口 |
| 6 原生任务页读取后端任务 | 已实现投影与订阅面（S6） | 待补：`listJobs` 合并后端任务、`memory.jobs.run` 识别后端任务 |
| 7 工具 schema 说明字段 | 已把说明并入工具描述规避（S4） | 待补 |

插件侧实现在 `src/contracts/framework.ts` 声明形状，框架落地后改为从 `@chatluna/*` 导入；`src/service/app/job_view.ts`、`job_surface.ts` 与 `LivingMemoryBackend.scheduling` 是第 4—6 项对应的落点。
