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