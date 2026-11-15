## 项目规范

- 通用协作规则保留在本文件，插件使用说明放在 `README.md`，设计决策放在 `.agent/note/`。
- 除受控配置之外不在源码中写密钥；本地 `.env`、上传数据、依赖目录、构建输出和临时文件不进入交付源码包。
- 临时文件、脚本、截图与验证产物统一放入 `tmp/`。交付前执行构建、类型检查和针对主要业务闭环的集成验证，按实际结果更新交付文档。

## 参考
- chatluna v2 开发文档：https://github.com/ChatLunaLab/doc.git
- chatluna v2 源代码：https://github.com/ChatLunaLab/v2-mirror.git

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

本项目为 `chatluna-plugin-livingmemory`，位于 ChatLuna v2 模板项目的 `external/livingmemory/`，由模板项目提供开发运行环境。

```text
livingmemory/
├── AGENTS.md                   # 本项目协作规范、代码结构与文档索引
├── CHANGELOG.md                # 变更记录
├── README.md                   # 插件说明、构建方法、配套服务和配置
├── package.json                # 插件包信息、导出入口、依赖与测试脚本
├── tsconfig.json               # 插件自身的服务端 TypeScript 配置
├── tsconfig.client.json        # 客户端 TypeScript 配置，继承本插件配置
├── src/
│   ├── index.ts                # 插件入口、配置 schema、依赖声明与服务启动
│   ├── service.ts              # Cordis 服务：装配仓储、历史读取、索引、工作流与工具
│   ├── routing.ts              # 对话规则注册与本轮有效配置读取
│   ├── query.ts                # 记忆、快照、任务、画像的列表过滤、分面统计与分页
│   ├── worker_artifacts.ts     # 解析 Worker 打包产物路径（源码与构建包共用）
│   ├── contracts/              # 跨模块契约：记忆与任务、工作流、向量索引、管理接口与前后端共享的 WebUI 状态和动作；随客户端源码发布
│   ├── service/
│   │   ├── user_profile.ts     # 人物画像生成、审阅与注入渲染
│   │   ├── chat_history.ts     # 无缓存读取框架聊天历史，转换真实时间、昵称与正文，筛选消费范围
│   │   ├── conversation_hooks.ts # 对话钩子：本轮注入、回复后召回、旁听触发、实际交付等待、历史与预设消费边界
│   │   ├── app/                # 应用层组装：管理服务与命令、WebUI 数据面、启动与每日维护、变更服务、管理页视图与任务通知
│   │   ├── logging/            # 诊断日志构造、凭据脱敏与模型调用记录
│   │   ├── memory/             # 字段规范化、说话人身份、来源消息、人设卡片
│   │   │   ├── conversation_sources.ts # 按当前实例的会话路由解析来源及显示名称
│   │   │   ├── origins/        # 读取与校验记忆的消息来源
│   │   │   ├── snapshot/       # 召回快照的文本渲染
│   │   │   └── tools/          # 记忆工具：检索、增删改合并拆分与注册入口
│   │   ├── persistence/        # 表定义、条目/快照/任务/画像/人设仓储与事务；source_migration.ts 匹配迁入记忆的来源会话
│   │   ├── prompts/            # 提示词骨架：结构化 schema、工具参数说明、记忆渲染
│   │   ├── shared/             # 串行任务队列与通用工具
│   │   ├── transcript/         # 聊天转写、来源与文本渲染
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
│   ├── setup.ts                # 注册 node:test 的全局测试函数与生命周期钩子
│   ├── persistence-test-utils.ts # 内存 SQLite 的仓储测试环境
│   ├── worker-test-utils.ts    # 打包 Vector Worker 并给出产物路径
│   ├── tool-test-utils.ts      # 工具调用上下文与执行辅助
│   ├── workflow-test-utils.ts  # 工作流测试的日志捕获、作用域与等待辅助
│   ├── chat-history-test-utils.ts # 框架历史查询夹具，覆盖缓冲滚动、真实时间和实际发送归属
│   └── *.spec.ts               # 各模块的单元和集成测试
├── scripts/
│   ├── build.mjs               # 打包服务端与 WebUI，串行执行 Worker 构建
│   ├── build-client.mjs        # 构建 WebUI，开发时监听改动并通知模板项目
│   ├── clean.mjs               # 清理插件构建产物与增量编译记录
│   └── build-workers.mjs       # 用 rolldown 打包 Vector 与语义分组 Worker 产物
├── client/
│   ├── index.ts                # WebUI 客户端入口：注册 `/livingmemory` 路由与语言资源
│   ├── page.tsx                # 管理页：记忆、画像、人设、快照、任务、召回测试与插件配置
│   ├── page.css                # 管理页滚动区域与画像详情样式
│   ├── settings-panel.tsx      # 当前插件实例的配置表单与保存操作
│   ├── guide-panel.tsx         # 插件配置指南：首次配置、检索示例与常用对话规则
│   ├── memory-deletion-dialog.tsx # 删除选中记忆及清空预设的确认弹窗
│   ├── memory-entry-editor.tsx # 手动新建与编辑记忆共用的表单
│   ├── preset-actions.tsx      # 预设操作菜单、导入确认与 JSON 下载
│   └── locales/
│       ├── zh.yml              # 中文界面文案
│       └── en.yml              # 英文界面文案
└── .agent/
    └── note/                   # Agent Note 工作流与设计决策
        ├── proposed/           # 尚未实施的提案
        ├── implemented/         # 已实施并保留的决策记录
        ├── rejected/            # 已否决但仍有参考价值的提案
        └── archived/            # 冻结的历史记录
```

目录树记录当前已落地文件。新增、删除、移动或重命名文件时同步更新本节。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [README.md](README.md) | 插件简介、构建方法、配套服务、配置项表、命令与管理页入口 |
| [.agent/note/README.zh.md](.agent/note/README.zh.md) | Agent Note 工作流、目录约定、状态转换和归档规则 |

Agent Note 只保留工作流入口，具体记录通过生命周期、类别目录及文内交叉链接查找，不逐篇追加到本索引。

