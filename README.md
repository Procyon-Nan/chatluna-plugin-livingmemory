# chatluna-plugin-livingmemory

ChatLuna v2 的长期记忆插件，支持记忆提取与召回、Dream 整理、用户画像和预设人设卡片。可单独使用；与原生 memory 同时启用时，两者各自提取、保存和注入记忆。

## 构建

需要 Node.js 24+ 和 Yarn 4。

在插件目录执行：

```powershell
yarn build
```

## 配套服务

必需服务：

`chatluna`、`schemas`、`routing`、`model`、`database`、`ai`、`tools`、`presets`、`chat_observer`、`agents`、`chat`、`conversations`

命令需要 `koishi`，管理页需要 `chatluna_webui` 和 `permissions`，每日维护需要 `timer`。

## 对话规则

在 **对话规则 → 能力 → LivingMemory** 设置全局默认值，或为指定群、频道单独配置。私聊可按频道或路由 ID 配置。

如果只想在指定群自动提取记忆，把全局的「从聊天中提取记忆的间隔」设为 `0`，再为这些群设置需要的消息条数。

| 配置项 | 配置键 | 默认值 | 说明 |
| --- | --- | --- | --- |
| 从聊天中提取记忆的间隔 | `extractionWindowMessages` | `60` | 按未提取的聊天消息条数计算（0—360）；`0` 关闭自动提取。 |
| 允许群友闲聊触发记忆提取 | `extractionIncludeOverheard` | `false` | 开启后，群友闲聊达到设定条数就能触发提取；关闭时，等 bot 回复后再检查。 |
| 是否在提取新记忆后进行 Dream 整理 | `enableAutoDream` | `true` | 自动提取保存新记忆后，由 Dream 检查是否需要整理。 |
| 记忆自动召回的间隔 | `recallIntervalMessages` | `20` | bot 被唤醒时按新增聊天条数判断是否召回；`0` 关闭自动召回。 |
| 用于召回记忆的聊天消息数 | `recallHistoryMessages` | `20` | 召回时最多读取多少条最近的聊天消息；画像注入也使用这段聊天记录。 |
| 记忆快照的使用范围 | `snapshotScope` | `conversation` | 每一个会话拥有独立记忆快照（`conversation`）或所有会话共享一个记忆快照（`preset`）。开启「会话记忆隔离」时使用独立快照。 |
| 记忆快照的最大行数 | `snapshotMaxLines` | `5` | 可设为 5—50 行。 |
| 会话记忆隔离 | `enableConversationIsolation` | `false` | 召回和检索工具只查当前会话的记忆和全局记忆。 |
| 向 bot 注入记忆快照 | `enableSnapshotInjection` | `true` | 在对话中提供已召回的记忆。 |
| 向 bot 注入用户画像 | `enableUserProfileInjection` | `false` | 在对话中提供最近聊天里发言人的已有画像。 |

## 插件配置

在 **LivingMemory → 插件配置** 调整模型、记忆工具、画像生成和调试选项，点「保存设置」后对所有预设生效。

模型项取值 `无` 表示未配置。重排序模型是可选的；不启用时，检索沿用向量和关键词的综合排序。

### 基础配置

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `debug` | boolean | `false` | 记录 LivingMemory 每次调用对话模型时的提示词、消息和模型响应 |

### 模型配置

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `mainModel` | string | `无` | 主模型：提取记忆、运行 Dream、更新人物画像和人设卡。需支持工具调用 |
| `subModel` | string | `无` | 子 LLM：召回记忆 |
| `embeddingModel` | string | `无` | 嵌入模型：将记忆和查询文本转换为向量，用于检索与 Dream |
| `rerankModel` | string | `无` | 重排序模型（可选）：按候选记忆与查询的相关性重新排序 |

### 工具配置

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `enabledMemoryTools` | string[] | 检索、来源、创建三项 | 向 ChatLuna 注册的记忆工具 |
| `memorySearchToolMaxResults` | number | `15` | 单次检索最多返回条数（1—60） |
| `memorySearchMinSimilarity` | number | `0` | 最低余弦相似度；`0` 表示不限制 |
| `memoryCreateToolMaxMemories` | number | `10` | 单次创建工具最多创建条数（1—60） |

### 用户画像配置

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `enableUserProfileGeneration` | boolean | `true` | 提取后生成或更新画像 |
| `enableDreamUserProfileGeneration` | boolean | `true` | Dream 后生成或更新画像 |
| `userProfileMinMemoryCount` | number | `3` | 生成画像所需最少活跃记忆数 |
| `userProfileMemoryLimit` | number | `20` | 送入模型的关联记忆上限 |

## 命令

`/livingmemory <预设> delete <text|user|profile> <匹配值>`（权限等级 3）

简写 `/livingmemory <预设> -d -<t|u|p> <匹配值>`。删除前会发送确认消息并等待
60 秒回复；记忆按归档处理，画像直接删除。

## 管理页

在 WebUI 的「能力」中打开 `/livingmemory`，可按预设查看记忆、用户画像、人设卡片、快照和任务，也可以测试召回效果。写操作需要权限等级 4。

首次使用可打开「插件指南」，按步骤配置模型、设置对话规则，并用一条记忆测试检索。

在「记忆」页点「新建记忆」，选择目标预设或输入新的预设 ID。已有条目可点「编辑」修改正文、关联用户、情绪和重要度等内容。

可逐条勾选记忆，也可全选当前筛选的所有结果（含其他页）。永久删除选中记忆前需要确认；清空整个预设时，需输入弹窗中包含预设名的完整短语。

要迁移记忆，在原实例选好预设后点「导出记忆」。在目标实例选好预设，点「导入记忆」，选择 LivingMemory v1 或 v2 导出的 JSON 文件并确认。目标实例还没有预设时，使用文件中的预设名。

导入时，能对应到本实例会话的记忆保留其会话归属；找不到对应会话的记忆改为该预设内全局可见，来源显示为 `unknown`。已导入的旧来源在插件下次启动时按同一规则转换。
