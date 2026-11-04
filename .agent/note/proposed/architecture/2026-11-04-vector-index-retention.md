# Agent Note: 保留 v1 向量索引，仅替换 embedding 调用层

Status: proposed

## Problem

LivingMemory v1 的向量检索不是单一的向量近邻查询。`src/service/vector_index/` 下 25 个文件、4708 行代码共同支撑：独立 Worker 线程中的 PGlite + pgvector、向量与关键词混合打分、索引重建、目录切换、状态存储和增量对账。ChatLuna v2 提供 `ctx.vector`（`packages/storage/vector`），接口只有 `upsert`、`search`、`remove`、`clear`，`search` 仅接受 embedding 与 payload 过滤器。

迁移时若用 `ctx.vector` 承接检索，会丢掉混合查询的分数合成、ANN 重建流程、索引状态与目录维护，并改变召回排序结果。若不使用，则插件需要自带 WASM 版数据库与 Worker 构建产物，这在 v2 插件生态中没有先例。

## Proposal

保留 v1 的整套向量索引能力，只替换 embedding 的调用方式。

1. `src/service/vector_index/` 整体迁移到 v2，包括 Worker 线程、`worker/schema.ts`、`worker/queries.ts`、`worker/mutations.ts`、`worker/dream_ann.ts`、`rebuild.ts`、`maintenance.ts`、`status_store.ts` 和 `directory_switch.ts`。这些文件只有 `service.ts` 与 `maintenance.ts` 引用了 koishi 的 `Context` 类型，替换为 cordis 的 `Context`，`ctx.baseDir` 改为 v2 的路径解析。
2. 检索语义保持不变：混合查询继续使用向量近邻与关键词命中合成（`KEYWORD_MATCH_BOOST = 0.15`、`KEYWORD_ONLY_BASE_SCORE = 0.3`），筛选继续按预设、状态、排除项、来源会话和类型执行。
3. embedding 层替换为 v2 模型调用。v1 的 `EmbeddingsLike` 是 langchain 接口（`embedDocuments(texts)` / `embedQuery(text)`），v2 是 `ctx.ai.embed(address)` 返回 `Model<'embed'>`。在 `service/vector_index/embedding.ts` 前加一层适配，把两种方法映射到同一次模型调用，`VectorIndexEmbeddingContext`、维度探测和向量校验逻辑不变。
4. 数据目录沿用 `data/chatluna/living-memory/vector-index.pglite`，配置项 `embeddingModel` 改为 v2 的模型地址格式。
5. Worker 构建继续使用 v1 的 esbuild 脚本方式，产物随插件发布；不在运行时依赖 tsx 或源码加载。

不引入 `@chatluna/storage-vector` 与 `@chatluna/storage-vector-sqlite`。这两个包保持不注册、不依赖。

## Alternatives considered

**使用 `ctx.vector` + `@chatluna/storage-vector-sqlite`**：可以删除约 4700 行代码和两个 WASM 依赖，但 v2 的 `VectorStore` 没有关键词检索路径，也没有版本化 schema、索引重建、状态存储和目录切换。混合查询与重建语义无法表达，只能重新设计召回排序，属于 D11 禁止的迁移期业务变更。

**保留 pglite 但去掉 Worker 线程**：减少构建复杂度，但 PGlite 是同步阻塞的 WASM 数据库，放进主线程会在召回和大批量对账时阻塞事件循环，影响同进程内其他插件。Worker 还承担了索引重建期间的内存隔离。

**改用 sqlite-vec 重新实现混合查询**：可以获得比 pgvector 更轻的依赖，但需要重写 schema、查询和 ANN 逻辑，并重建 6 个向量索引 spec 的期望值。迁移阶段承担这项重写的收益无法证明。

## Acceptance criteria

- `vector-index-*` 的 6 个 spec（`service`、`worker`、`hybrid-query`、`rebuild`、`dream-ann`、`directory-switch`、`status-store`）在 v2 下全部通过，期望值不做业务性调整。
- 同一批记忆与同一查询在 v1 与 v2 下返回相同的命中顺序和分数。
- embedding 只通过 `ctx.ai.embed(address)` 调用；插件不引用 `@langchain/core`。
- Worker 线程在 v2 宿主进程中能启动、重建索引、处理目录切换，并在插件卸载时正常终止。
- 插件构建产物包含 Worker 脚本；运行时不从 `src/` 加载。

## Risks

- PGlite 的 WASM 初始化在 v2 宿主进程中未经验证。v2 使用同一 Node 运行时，但 pglite 的文件句柄与 Worker 通信需要实机确认。
- 插件需要发布 Worker 构建产物，构建流程比纯 TypeScript 插件复杂；`scripts/build-workers.mjs` 需要随迁移一起改造。
- 数据目录与 v1 不同（v1 的 `ctx.baseDir` 与 v2 的 `ctx.baseUrl` 解析规则可能不一致），旧数据导入时需要显式指定来源路径，不能假设目录位置相同。
- 保留约 4700 行代码意味着后续维护成本留在插件侧，v2 的向量能力演进无法自动受益。