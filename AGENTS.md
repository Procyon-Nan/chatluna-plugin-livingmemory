## 项目规范

- 通用协作规则保留在本文件，具体实现约定与业务说明放在 `doc/`。
- 除受控配置之外不在源码中写密钥；本地 `.env`、上传数据、依赖目录、构建输出和临时文件不进入交付源码包。
- 临时文件、脚本、截图与验证产物统一放入 `tmp/`。交付前执行构建、类型检查和针对主要业务闭环的集成验证，按实际结果更新交付文档。

## 参考
- chatluna v2 开发文档：`C:\Users\31899\dev\chatlunav2-dev\doc`
- chatluna v2 源代码：`C:\Users\31899\dev\chatlunav2-dev\v2-mirror`
- chatluna v1 下的 livingmemory 插件源代码：`C:\Users\31899\dev\koishi-dev\external\chatluna-livingmemory`

## 代码与设计

- 拒绝防御性编程和防御性设计。围绕已确认的需求、类型和接口契约实现，不为假设中的异常叠加判空、兜底、重试、兼容分支或抽象层。
- 在实际输入边界处理明确的校验和失败场景；内部代码遵循已建立的契约，不重复检查同一条件。契约被破坏时暴露具体错误，修复问题来源，不用默认值、空结果或静默捕获掩盖问题。
- 禁止大块、多重嵌套的三元表达式，尤其是 JSX 中连续嵌套的条件渲染。多分支使用清晰的 `if`、提前返回、具名函数或职责明确的组件；简单二选一可以使用单层三元表达式。
- 优先保证代码可读性。变量、分支和组件应直接表达业务含义，不为压缩行数将多个判断和操作挤在一起。

## 变更记录

- CHANGELOG.md 的提交哈希仅在版本更新提交时统一回填。日常提交保留 `pending`，不要每次提交后回填，也不要为回填单独创建提交。

## 说明与表达

以下约定适用于用户沟通、项目文档、代码注释与界面文字。

- 直接陈述实现、行为、结果和依据。禁止使用“这不是……”“这不代表……”等防御性、甩锅式说明，不添加与当前问题无关的免责声明。
- 需要说明能力范围时，用具体事实表达，例如“任务在当前页面内计时，关闭页面后暂停”，避免用免责式否定句代替行为说明。
- 不使用“可能”“大概”“也许”“未必”等模糊措辞替代核实。技术结论应以源码、文档、运行记录或实际验证为依据。
- 尚未核实的内容必须核实清楚，如果无法查证应当及时汇报；需要用户决定的需求直接提出问题。不得把推测写成确定结论。

## 代码结构

本项目为 `chatluna-plugin-livingmemory`，位于 ChatLuna v2 模板项目的 `external/livingmemory/`，由模板项目提供开发运行环境。当前处于 S6.5 采集与触发收尾完成、S7 管理与导入待开始的阶段。

```text
livingmemory/
├── AGENTS.md                   # 本项目协作规范、代码结构与文档索引
├── CHANGELOG.md                # 变更记录
├── README.md                   # 插件说明，当前为脚手架内容
├── package.json                # 插件包信息、导出入口、依赖与测试脚本
├── tsconfig.json               # 服务端 TypeScript 配置，继承模板项目配置
├── tsconfig.client.json        # 客户端 TypeScript 配置，继承模板项目配置
├── src/
│   ├── index.ts                # 插件入口、配置 schema、依赖声明与服务启动
│   ├── service.ts              # Cordis 服务：装配仓储、后端、采集、索引、工作流与工具
│   ├── query.ts                # 记忆、快照、任务、画像的列表过滤、分面统计与分页
│   ├── worker_artifacts.ts     # 解析 Worker 打包产物路径（源码与构建包共用）
│   ├── contracts/              # 跨模块契约：记忆与任务、工作流、向量索引、管理接口、框架侧待补接口
│   ├── service/
│   │   ├── backend.ts          # v2 MemoryBackend 实现，映射到 v1 仓储
│   │   ├── user_profile.ts     # 人物画像生成、审阅与注入渲染
│   │   ├── message_collector.ts # 统一采集层：拉取 chat_observer 通道缓冲，维护每会话消息池
│   │   ├── session_hooks.ts    # 会话钩子：prepareStep 注入与召回、agent-turn 记录回复并触发提取
│   │   ├── app/                # 应用层组装：记忆读写提供者、变更服务、查询投影、任务视图与任务面
│   │   ├── logging/            # 诊断日志构造、凭据脱敏与模型调用记录
│   │   ├── memory/             # 字段规范化、说话人身份、主题标题推导、来源消息、人设卡片
│   │   │   ├── origins/        # 来源消息的规范化与迁移
│   │   │   ├── snapshot/       # 召回快照的文本渲染
│   │   │   └── tools/          # 记忆工具：检索、增删改合并拆分、快照编辑与注册入口
│   │   ├── persistence/        # 表定义、条目/快照/任务/画像/人设仓储与事务
│   │   ├── prompts/            # 提示词骨架：结构化 schema、工具参数说明、记忆渲染
│   │   ├── shared/             # 串行任务队列与通用工具
│   │   ├── transcript/         # 消息日志、回填、会话历史转换、转写与 ChatBlock 到日志文本的规范化
│   │   ├── vector_index/       # PGlite + pgvector 索引：维护、重建、对账、状态与 Worker
│   │   │   └── worker/         # 索引进程内实现：schema、查询、变更、Dream 近邻
│   │   └── workflows/          # 工作流：工具循环、结构化输出、任务跟踪
│   │       ├── extraction/     # 自动提取协调器与提取器
│   │       ├── recall/         # 召回协调器、代理式召回与混合检索
│   │       └── dream/          # Dream 协调器、聚类、语义图谱、会话与 Worker
│   │           ├── semantic/   # 语义图谱的候选、二分、细化与校验
│   │           ├── session/    # Dream 会话：批次状态、历史压缩、会话工具
│   │           └── worker/     # 语义分组 Worker 的客户端、协议与入口
├── tests/
│   ├── setup.ts                # 把 node:test 的同名函数装回全局，兼容 v1 测试体
│   ├── persistence-test-utils.ts # 内存 SQLite 的仓储测试环境
│   ├── worker-test-utils.ts    # 打包 Vector Worker 并给出产物路径
│   ├── tool-test-utils.ts      # 工具调用上下文与执行辅助
│   ├── workflow-test-utils.ts  # 工作流测试的日志捕获、作用域与等待辅助
│   └── *.spec.ts               # 与源码同期迁移的测试
├── scripts/
│   └── build-workers.mjs       # 用 rolldown 打包 Vector 与语义分组 Worker 产物
├── client/
│   ├── index.ts                # WebUI 客户端入口，当前注册国际化资源
│   └── locales/
│       ├── zh.yml              # 中文界面文案
│       └── en.yml              # 英文界面文案
├── .agent/
│   └── note/                   # Agent Note 工作流与迁移设计记录
│       ├── proposed/           # 尚未实施的提案
│       ├── implemented/         # 已实施并保留的决策记录
│       ├── rejected/            # 已否决但仍有参考价值的提案
│       └── archived/            # 冻结的历史记录
└── doc/
    ├── migration-plan.md       # v1 → v2 迁移方案、任务进度与验收清单
    ├── migration-stages.md      # S1—S8 实施阶段、交付物与阻塞项
    ├── message-pool.md          # 统一消息采集、内存消息池维护与验收清单
    ├── framework-requirements.md # ChatLuna v2 框架侧接口需求，供 v2 开发者实施
    └── v1-behavior-inventory.md # v1 全量业务行为清单与迁移核对入口
```

目录树记录当前已落地文件。新增、删除、移动或重命名文件时同步更新本节；迁移中的模块划分先记录到方案文档，落地后补入目录树。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [README.md](README.md) | 插件简介与配置说明，当前为脚手架内容 |
| [doc/migration-plan.md](doc/migration-plan.md) | 迁移目标、确认事项、任务编号与依赖、设计/实施/验收进度、双方接口及职责草案、旧数据迁移范围 |
| [doc/migration-stages.md](doc/migration-stages.md) | S1—S8 实施阶段划分、各阶段交付物、模块归属、向量索引与测试处置、提交粒度与阻塞项 |
| [doc/message-pool.md](doc/message-pool.md) | M05 跨引擎统一采集、分池、回填、去重、内存游标、会话生命周期、冷启动与实施验收 |
| [doc/framework-requirements.md](doc/framework-requirements.md) | 由 ChatLuna v2 承担的接口项：统一采集、交付归属、会话与预设通知、调度归属、任务受理与取消、原生任务页面接入，含当前源码事实与验收条件 |
| [doc/v1-behavior-inventory.md](doc/v1-behavior-inventory.md) | D11 的 v1 全量业务行为清单、源码/测试核对入口、v2 适配归属和执行标记 |
| [.agent/note/README.zh.md](.agent/note/README.zh.md) | Agent Note 工作流、目录约定、状态转换和归档规则 |
| [.agent/note/proposed/architecture/2026-11-03-extraction-window-and-chunking.md](.agent/note/proposed/architecture/2026-11-03-extraction-window-and-chunking.md) | 沿用 v1 自动提取窗口、完整交流、旁听分块和批次进度语义的提案 |
| [.agent/note/proposed/architecture/2026-11-04-v1-behavior-preservation.md](.agent/note/proposed/architecture/2026-11-04-v1-behavior-preservation.md) | v1 全部业务行为作为迁移基线，以及 v2 适配层的职责边界 |
| [.agent/note/proposed/architecture/2026-11-04-extraction-inflight-lifecycle.md](.agent/note/proposed/architecture/2026-11-04-extraction-inflight-lifecycle.md) | v1 在途自动提取的状态失效、原作用域提交和 v2 卸载生命周期契约提案 |
| [.agent/note/proposed/architecture/2026-11-04-vector-index-retention.md](.agent/note/proposed/architecture/2026-11-04-vector-index-retention.md) | 保留 v1 向量索引能力，只把 embedding 调用层替换为 v2 `ctx.ai.embed` 的提案 |
| [.agent/note/proposed/architecture/2026-11-04-test-migration-strategy.md](.agent/note/proposed/architecture/2026-11-04-test-migration-strategy.md) | v1 测试按模块随源码迁移的三档处置与文件清单提案 |
| [.agent/note/proposed/architecture/2026-11-05-session-hooks-and-collector.md](.agent/note/proposed/architecture/2026-11-05-session-hooks-and-collector.md) | v1 两个中间件在 v2 的等价钩子、采集层改用 `chat_observer` 拉取、召回窗口与会话历史的补足规则 |
| [.agent/note/implemented/architecture/2026-11-05-internal-tool-loop.md](.agent/note/implemented/architecture/2026-11-05-internal-tool-loop.md) | 召回与 Dream 自行驱动模型调用的工具循环，以及不接入 v2 Agent 层的依据 |

迁移讨论持续更新方案文档，分别标记已确认事项、设计草案与待讨论问题。后续按实际讨论内容拆分专题文档，并同步本索引。

