# Agent Note: 采集层与自动流程并入 v2 的会话钩子

Status: proposed

## Problem

插件在 S3 迁移了消息池与采集层，在 S5 迁移了召回、提取、Dream、画像与人设。这两部分各自完成了单元级验证，但拼不到一起：插件目前在任何宿主里都整体不加载。

原因是一处声明错误。`src/index.ts` 的 `inject` 里有 `chatluna_collector`，`src/contracts/framework.ts` 用模块增强把它声明成 `Context.chatluna_collector`。这个名字在 ChatLuna v2 里不存在——模板项目的 `node_modules` 与 v2 源码里搜索 `chatluna_collector` 的匹配数都是 0。`cordis` 的 `inject` 在实现缺失时把 fiber 的 epoch 置为 `INACTIVE`，所以 `LivingmemoryService` 整个构造过程不会执行，`MessageCollector` 那一行从未运行过。

S3 这样做是有意的：当时按 `doc/framework-requirements.md` 的 M05-C1/M05-C2/M02-C1 声明形状实现，计划等框架侧补齐后只换 import。问题在于把“未来会有的服务”写进了 `inject`，而 `inject` 是加载前置条件，不是可选依赖。

即使把 `chatluna_collector` 修掉，还有第二个缺口：`src/` 里没有任何地方调用 `recallCoordinator.queue()` 与 `extractionCoordinator.queue()`。v1 由 `plugins/chat_middleware.ts`、`character_middleware.ts`、`living_memory_tools.ts` 在 `chatluna/before-chat`、`after-chat` 两个中间件里触发，而 v2 没有这两个事件名。

## Current v2 behavior

v2 把 v1 的两个中间件拆成了四个接入点，逐条核对如下。

| v1 | v2 等价物 | 源码位置 |
| --- | --- | --- |
| `chatluna/before-chat` 改写输入与挂载注入 | `chatluna/prompt-submit`（`serial`，可改 `input`、向 `context` 追加内容） | `packages/agent/core/src/events.ts:21`，调用点 `loop/agent.ts:497` |
| `before-chat` 中按步追加记忆 | `ctx.agents.prepareStep(fn, { order })`，返回 `contribute: ChatMessage[]` | `packages/agent/core/src/service.ts:368`；原生 memory 自用 890 触发提取、900 注入索引（`memory/core/src/extract.ts:58`、`memory/core/src/inject.ts:8`） |
| `chatluna/after-chat` 取回复、触发提取 | `chatluna/agent-turn`（`emit`，载荷 `{ agent, reason, steps }`） | `packages/agent/core/src/events.ts:17`，`loop/agent.ts:543` |
| 旁听采集与历史读取 | `chat_observer.recentOfConversation(key, limit)`、`identityOfConversation(key)`、`backfill(cid)` | `packages/chat/observer/src/service.ts:178,182,359` |

另外两处与本次决定相关的源码事实：

- `chat_observer` 没有“消息入池”的公共事件，只有拉取式读取。旁听消息由它自己维护通道缓冲，消费方拿不到推送。
- `chat_observer` 的回填由它自己完成：它在 `_backfill` 里调用历史来源，把结果以 `when: 'quiet'` 送进 agent，**不进入 `channel.observed` 缓冲**。插件的消息池因此无法通过 `recentOfConversation` 拿到回填消息，只能拿实时消息。

## Proposal

分三步，顺序不能颠倒。

### 1. 解除加载阻塞

`inject` 里移除 `chatluna_collector`，保留 `chatluna`、`memory`、`database`、`chat_observer`。`src/contracts/framework.ts` 的契约声明保留为设计依据，但不再作为 `inject` 项；采集层改为构造参数注入，服务缺失时插件仍能加载。

这一步只改加载语义，不改任何业务行为。

### 2. 采集层改用 `chat_observer`

`MessageCollector` 的输入从 `ChatLunaCollector` 换成 `ChatObserverService`，两种数据来源：

- **实时消息**：`prepareStep` 每步执行时，用 `recentOfConversation(conversationKey, limit)` 拉取通道缓冲，与池内已有条目按 `platformMessageId` 去重后追加。这与原生 memory 的提取路径同源，不引入新的框架依赖。
- **回复**：`chatluna/agent-turn` 发生时，`agent.session.messages()` 的末条 assistant 消息就是本轮回复；按 `message.id` 去重后作为 `role: 'assistant'` 条目追加。

回填不迁移：`chat_observer` 已经把历史送进 agent 会话，插件再从 `agent.session` 读取即可得到同一份历史。池子只维护实时视界，与 v1 的“池内保留历史用于召回窗口”语义有差异——这条差异需要单独确认（见 Risks 第一条）。

### 3. 接入触发与注入

三个钩子，与原生 memory 的分工一致：

- `prepareStep({ order: 870 })`：读取会话归属 → 计算提取窗口 → `recallCoordinator.queue(...)` → 把快照与画像以 `prepareStep` 的 `contribute` 返回。排在原生 memory 的 890 之前，保证原生提取读到的是本插件已更新的消息池。
- `chatluna/agent-turn`：`reason` 为正常结束时调用 `extractionCoordinator.queue(...)`。
- `chatluna/prompt-submit`：不需要。v1 用它挂载注入，v2 由 `prepareStep` 的 `contribute` 取代。

作用域从 `agent.options` 取：`presetId`、`conversationKey`；平台、群号、用户从 `chat_observer.identityOfConversation(conversationKey)` 或 `agent.options.location` 补齐，与 `PermissionSubject` 的字段对应。

## Alternatives considered

**等框架侧补齐 `chatluna_collector`**：能原样保留 S3 的实现，也是 S3 当时的计划。放弃原因有两层：`inject` 里的不存在服务会让插件完全静默失效，在框架侧落地前无法做任何端到端验证；而 v2 已经有 `chat_observer` 这个可用的采集面，重建一个服务只是在包装同一份数据。

**把 `chatluna_collector` 从 `inject` 移除但保留采集层的可选降级**：加载问题能解决，但降级分支要同时维护事件订阅与轮询两套路径，而事件那套在框架里根本不存在，等于为不存在的接口写兼容代码。直接换成现成接口更简单。

**召回在 `chatluna/agent-turn` 里异步预取，`prepareStep` 只读已存快照**：热路径零等待，与 v1 的“本轮触发、下轮生效”一致。放弃原因是首轮没有快照，而 S6 的任务面已把召回定义为带任务状态的工作流，异步预取的启动时机与任务受理顺序会对不上。原生 memory 选择在 `prepareStep` 内等待执行，这里跟随同一取舍，延迟问题留到性能验证时再处理。

**在 `chatluna/prompt-submit` 里做注入**：可以改写本轮输入。但 `prompt-submit` 发生在轮次开始、`prepareStep` 之前，此时召回尚未执行，拿不到本轮快照，只能注入上一轮的结果。

## Acceptance criteria

- 插件在只装有 `chatluna`、`memory`、`database`、`chat_observer`、`agents` 的宿主里正常加载，服务可构造。
- 一条群消息进入后，消息池能通过 `recentOfConversation` 读到它；同一条消息不会因重复拉取而重复入池。
- 一轮回复结束后，`extractionCoordinator.queue` 被调用；累计达到窗口阈值时产出记忆。
- 召回在 `prepareStep(order 870)` 内执行，快照与画像出现在本轮的实际请求里，而不是下一轮。
- 卸载时三个协调器的 `stop()` 都在释放 `chat_observer` 订阅之前完成。
- 现有 354 个用例保持通过；`MessageCollector` 的测试改为用 `chat_observer` 形状的测试替身。

以上全部满足：365 个用例中 364 通过、1 个仅 Windows 用例跳过；`tsc --noEmit` 无输出；`yarn yakumo build` 与 Worker 打包成功。新增 `tests/session-hooks.spec.ts` 覆盖注入时机、召回调度、提取调度、群名回退与无预设会话。原「354 个用例」一项按实际数更新为 365。

## Risks

- **消息池的视界变化**：v1 的池子保留回填历史，召回窗口从池里取；改用 `chat_observer` 后回填不进 `observed` 缓冲，池子只覆盖实时消息。已确认的处理：池子只维护实时视界，召回窗口不足时由 `MessageCollector.recallWindow` 用 `agent.session.messages()` 补足，与池内条目按消息号（缺号时按身份与正文）判重。补充的条目 `origin` 记为 `backfill`。
- **轮询入池有延迟**：`prepareStep` 每步拉一次缓冲，消息在两次拉取之间不可见。原生 memory 也是这个粒度，判定为可接受；如果某条消息在会话结束前都没有触发下一步，它不会入池。
- `prepareStep` 内等待召回会把模型调用加进热路径。召回有 6 次调用上限与间隔门禁，正常情况下只在小部分轮次触发；真实延迟需要跑起来之后测。
- `chat_observer` 不提供“消息已入池”事件，旁听场景下插件对消息的感知完全依赖轮询，与 M05 已确认的“未触发回复的消息也要入池”在实现上仍有差距。
- **旁听提取没有独立的触发点**：v1 的旁听模式在 `character_middleware.ts` 的 `message_collect` 里逐条消息 `captureCursor` 并 `queueExtraction`，因此能在 bot 未被触发时按阈值提取。v2 的提取触发只有 `chatluna/agent-turn`（`reason === 'completed'`）一处，旁听消息本身不产生触发。`extractionIncludeOverheard` 因此在 v2 只剩切块阶段的语义——关闭时剥掉核心窗口之外的闲聊，开启时保留并允许末尾纯用户段成块；「从首条消息开始累计」的触发行为不再成立。配置说明按 `790c89c` 恢复后的语义口径重写，不再描述 v1 的 Character 触发。
- **机器人回声的双份记录**：观察层把机器人实际发出的消息记成 `self` 回声（渲染后文本），本轮回复从 `agent.session.messages()` 取（模型输出文本），两者不是同一条记录。处理方式是不采集 `self` 回声，回复只在轮次结束时记一次。
- **群名来源**：`AgentOptions.location` 只有群号。提取来源标签的群名取 `ctx.chat.environmentOf(sessionId)?.guildName`——`chat` 打开 agent 时从 `session.event.guild.name` 写入，与提示词渲染同源；取不到时用群号代替展示名。

## Implementation

已落地，对应上文的 Proposal 三步：

| 文件 | 变更 |
| --- | --- |
| `src/index.ts` | `inject` 去掉 `chatluna_collector`，加入 `agents` |
| `src/service/message_collector.ts` | 改为拉取 `chat_observer.recentOfConversation`；跳过 `self` 回声；`recordReplies` 记本轮回复；`recallWindow` 支持会话历史补足 |
| `src/service/transcript/message_log/session_history.ts`（新增） | `ChatMessage` → 日志条目，跳过带 `form` 的注入消息 |
| `src/service/transcript/message_log/message_log_registry.ts` | 新增 `has()` |
| `src/service/session_hooks.ts`（新增） | `prepareStep(order: 870)` + `chatluna/agent-turn` |
| `src/service.ts` | 构造采集层注入 `ctx.chat_observer`；注册会话钩子 |
| `src/contracts/framework.ts` | 删除 `ChatLunaCollector` 声明；保留 M05-C1 其余形状作为框架需求 |

`prepareStep` 只在 `stepNumber === 1` 注入与召回：`contribute` 的结果并进请求，后续步再注入会让同一段快照在一条请求里重复出现。原生 memory 的提取钩子（890）每步都跑，读到的消息池已由本插件在本步之前同步。