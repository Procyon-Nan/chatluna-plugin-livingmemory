# Agent Note: 按模块迁移 v1 测试，不整体重写

Status: proposed

## Problem

LivingMemory v1 有 48 个 vitest 测试文件、14335 行，覆盖提取协调器、Dream 聚类与语义图谱、向量索引、消息池、工具、数据仓库和导入导出。迁移到 ChatLuna v2 时，这些测试的验证对象大部分仍然有效，但装配方式完全不同：12 个文件直接 `import { Context } from 'koishi'`，用 `@koishijs/plugin-database-sqlite` 和 koishi 服务容器搭环境。

D11 已确认 v1 全部业务行为作为迁移基线。测试是该基线唯一可执行的凭据。若整体丢弃，迁移后无法判断提取分块边界、Dream 聚类结果和混合检索排序是否与 v1 一致；若整体重写，则等于用新写的期望值验证新写的实现，失去对照意义。

## Proposal

按模块随源码一起迁移，处置方式分三档。

**原样迁移（34 个）**：不依赖 koishi、只测纯算法与数据结构。只改 import 路径与模块位置，测试体和期望值保持不变。

- 提取与消息池：`extraction-coordinator`、`message-log`、`message-collector`
- Dream：`dream-candidates`、`dream-clustering`、`dream-refinement`、`dream-session`、`dream-worker`、`dream-repository`、`post-extraction-dream`
- 向量索引：`vector-index-worker`、`vector-index-hybrid-query`、`vector-index-rebuild`、`vector-index-dream-ann`、`vector-index-directory-switch`、`vector-index-status-store`、`legacy-embedding-migration`
- 数据与查询：`query`、`query-projections`、`repository-maintenance`、`snapshot-repository`、`user-profile`、`user-profile-repository`、`job-repository`
- 工具与提示词：`memory-tools`、`memory-create-tool`、`indexed-memory-mutations`、`prompt-contracts`、`structured-output`、`preset-import-export`、`recall-coordinator`
- 其他：`config-status`、`logging`、`element-text`

**改造后迁移（11 个）**：装配依赖 koishi 容器，但断言的是业务行为。改 `Context` 为 cordis、把 koishi 数据库换成 v2 的 `@cordisjs/plugin-database` 实现，断言不变。

- `chat-middleware`、`character-middleware`：两个采集入口在 v2 合并为对 observer 的单一订阅，测试改为验证同一套入池规则，不验证中间件挂载。
- `chatluna-transcript-adapter`、`message-log-registry`：适配器接口由 v2 的消息契约替代。
- `dream-workflows`、`agentic-recall`、`indexed-recall`、`preset-persona`、`memory-entry-fields`、`source-origins-migration`、`vector-index-service`：只替换容器与仓储替身的构造方式。

**改造后迁移且覆写装配部分（1 个）**：`extraction-prompt` 中依赖 koishi 提示词注入的用例改为直接构造提示词输入，断言提示词内容的部分保留。

**删除（2 个）**：验证 v1 装配与界面形态的文件，其行为在 v2 由框架承担。

- `client-dashboard`（83 行）：UI 快照，界面重做。
- `living-memory-service-lifecycle`（140 行）：服务装配顺序，v2 的 `ctx.effect` 与 dispose 语义不同。

迁移顺序跟随源码：模块搬完的同一提交内，其测试必须通过。不设"最后统一补测试"的阶段。

## Alternatives considered

**整体丢弃**：省去迁移成本，但 D11 声明 v1 全部行为为基线，而 36 个纯逻辑测试正是分块边界、聚类结果和检索排序的唯一定义。丢弃后只能用人工对话验证，无法发现差一条消息的分块偏移。

**在 v1 环境下保留测试，v2 另写一套**：可以让旧测试继续运行，但两套实现同时演进，v2 的测试逐渐偏离 v1 期望，对照关系在几次改动后失效。且插件交付后不应依赖 koishi 测试环境。

**用 v2 现有测试风格全量重写**：期望值由新实现反推，验证的是"代码做了它现在做的事"，不是"行为与 v1 一致"。这正好抵消了迁移要做的事。

## Acceptance criteria

- 原样迁移的 34 个文件在插件仓库中运行通过，断言与期望值相对 v1 没有业务性改动；确需调整的逐条记录原因。
- 改造后迁移的文件只改装配，不改断言内容。
- 删除的两个文件在迁移方案中记录其覆盖的行为由哪项 v2 能力或验收项承接。
- 每个模块的源码与测试在同一个提交内落地，仓库在任一提交点都能跑通全部测试。
- 测试运行环境只依赖 cordis、vitest 与 v2 的数据库实现，不引入 koishi。

## Risks

- v1 的测试大量使用 `vi.mock` 与手工构造的 Repository 替身，改装配时会暴露对 v1 内部结构的耦合，部分断言需要跟着类型变化调整。
- PGlite 的测试使用真实 WASM 数据库和临时目录，在 CI 与 WSL 下的路径和句柄行为需要单独确认。
- 48 个测试文件中保留 46 个，插件仓库的测试体量与源码体量相当，维护成本随迁移一起留下。