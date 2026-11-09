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

如果只想在指定群自动提取记忆，把全局的「自动提取间隔」设为 `0`，再为这些群设置需要的消息条数。

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `enableSnapshotInjection` | boolean | `true` | 开启记忆快照注入 |
| `enableUserProfileInjection` | boolean | `false` | 注入最近聊天中发言人的已有画像 |
| `enableConversationIsolation` | boolean | `false` | 只检索当前会话与全局记忆 |
| `recallIntervalMessages` | number | `20` | 有聊天记录时，首次唤醒即召回；之后在唤醒时按新增聊天条数触发。`0` 关闭自动召回 |
| `recallHistoryMessages` | number | `20` | 每次唤醒时，用于召回和画像注入的最近聊天条数 |
| `snapshotMaxLines` | number | `5` | 记忆快照的最大行数 |
| `extractionWindowMessages` | number | `60` | 未提取消息达到该条数时提取（0—360）；`0` 关闭 |
| `enableAutoDream` | boolean | `true` | 提取保存新记忆后自动整理 |
| `extractionIncludeOverheard` | boolean | `false` | 旁听提取：bot 未参与的闲聊是否计入提取；关闭时只提取对话与其前方一个窗口内的消息 |

## 插件配置

在 **LivingMemory → 插件配置** 调整模型、记忆工具、画像生成和调试选项，点「保存设置」后对所有预设生效。

模型项取值 `无` 表示未配置，对应工作流会跳过并在管理页给出配置告警。

### 基础配置

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `debug` | boolean | `false` | 记录召回、提取、Dream 每次模型调用的完整提示词与原始响应 |

### 模型配置

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `mainModel` | string | `无` | 主 LLM：提取记忆、Dream、用户画像 |
| `subModel` | string | `无` | 子 LLM：召回记忆 |
| `embeddingModel` | string | `无` | 嵌入模型：记忆检索与 Dream |
| `rerankModel` | string | `无` | Reranker：检索结果重排序 |

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

在「记忆」页点「新建记忆」，选择目标预设或输入新的预设 ID。已有条目可点「编辑」修改正文、关联用户、情绪和重要度等内容。

可逐条勾选记忆，也可全选当前筛选的所有结果（含其他页）。永久删除选中记忆前需要确认；清空整个预设时，需输入弹窗中包含预设名的完整短语。

要迁移记忆，在原实例选好预设后点「导出记忆」。在目标实例选好预设，点「导入记忆」，选择 LivingMemory v1 或 v2 导出的 JSON 文件并确认。目标实例还没有预设时，使用文件中的预设名。
