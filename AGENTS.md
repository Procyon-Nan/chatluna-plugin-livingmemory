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

本项目为 `chatluna-plugin-livingmemory`，位于 ChatLuna v2 模板项目的 `external/livingmemory/`，由模板项目提供开发运行环境。当前处于插件脚手架与迁移方案讨论阶段。

```text
livingmemory/
├── AGENTS.md                   # 本项目协作规范、代码结构与文档索引
├── CHANGELOG.md                # 变更记录
├── README.md                   # 插件说明，当前为脚手架内容
├── package.json                # 插件包信息、导出入口与依赖
├── tsconfig.json               # 服务端 TypeScript 配置，继承模板项目配置
├── tsconfig.client.json        # 客户端 TypeScript 配置，继承模板项目配置
├── src/
│   ├── index.ts                # 插件入口、配置 schema 与依赖声明
│   └── service.ts              # Cordis 服务骨架
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

迁移讨论持续更新方案文档，分别标记已确认事项、设计草案与待讨论问题。后续按实际讨论内容拆分专题文档，并同步本索引。

