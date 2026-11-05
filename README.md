# chatluna-plugin-livingmemory

ChatLuna v2 的长期记忆插件。从对话中提取记忆、按需召回并注入提示词，支持 Dream
整理、用户画像与预设人设卡片，并提供独立的 WebUI 管理页。

迁移来源为 v1 的 `chatluna-livingmemory`，业务语义按 D11 原样保留，只替换承载
方式（Cordis 服务、`ctx.ai` 模型调用、`chat_observer` 消息采集、`@chatluna/ui-client`
管理界面）。迁移进度见 [doc/migration-plan.md](doc/migration-plan.md) 与
[doc/migration-stages.md](doc/migration-stages.md)。

## 配套服务

插件加载要求以下服务在场，任一缺失时插件不会加载：

`chatluna`、`memory`、`database`、`chat_observer`、`agents`

命令与 WebUI 是可选能力，分别在有 `koishi` 与 `chatluna_webui` 时注册；每日维护
在有 `timer` 时调度。

## Config

模型项取值 `无` 表示未配置，对应工作流会跳过并在管理页给出配置告警。

### 基础配置

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `enableSnapshotInjection` | boolean | `true` | 开启记忆快照注入 |
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
| `enableUserProfileInjection` | boolean | `false` | 开启画像注入 |
| `enableUserProfileGeneration` | boolean | `true` | 提取后生成或更新画像 |
| `enableDreamUserProfileGeneration` | boolean | `true` | Dream 后生成或更新画像 |
| `userProfileMinMemoryCount` | number | `3` | 生成画像所需最少活跃记忆数 |
| `userProfileMemoryLimit` | number | `20` | 送入模型的关联记忆上限 |

### 记忆召回配置

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `enableConversationIsolation` | boolean | `false` | 只检索当前会话与全局记忆 |
| `recallIntervalMessages` | number | `20` | 每累计多少条新消息召回一次，会话首次对话时立即召回；`0` 关闭 |
| `recallHistoryMessages` | number | `20` | 召回取用的上下文消息条数 |
| `snapshotMaxLines` | number | `5` | 记忆快照的最大行数 |

### 记忆提取配置

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `extractionWindowMessages` | number | `60` | 未提取消息达到该条数时提取（0—360）；`0` 关闭 |
| `enableAutoDream` | boolean | `true` | 提取保存新记忆后自动整理 |
| `extractionIncludeOverheard` | boolean | `false` | 旁听提取：bot 未参与的闲聊是否计入提取；关闭时只提取对话与其前方一个窗口内的消息 |
| `enableExtractionWhitelist` | boolean | `false` | 只对白名单会话自动提取 |
| `extractionWhitelist` | string[] | `[]` | 白名单：群聊填群号，私聊填对方用户号 |

## 命令

`/livingmemory <预设> delete <text|user|profile> <匹配值>`（权限等级 3）

简写 `/livingmemory <预设> -d -<t|u|p> <匹配值>`。删除前会发送确认消息并等待
60 秒回复；记忆按归档处理，画像直接删除。

## 管理页

宿主装有 WebUI 时在「能力」分组下注册 `/livingmemory`，按预设切换，覆盖记忆、
用户画像、人设卡片、快照、任务与召回测试六个面板。写操作要求权限等级 4。