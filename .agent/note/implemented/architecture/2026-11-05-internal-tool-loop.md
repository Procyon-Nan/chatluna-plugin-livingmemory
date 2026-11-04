# Agent Note: 内部工作流自行驱动模型调用，不使用 v2 的 Agent 层

Status: implemented

## Problem

LivingMemory 有三个内部工作流需要模型自行决定调用哪些记忆工具：代理式召回（检索记忆、更新快照、结束）、Dream 会话（逐批对记忆做合并、拆分、更新、删除、确认），以及它们的轮次上限与历史压缩。v2 提供了 `ctx.agents`，包含会话、工具检索、提示词组装与轮次驱动，是插件接入模型调用的官方入口。

核对 v2 的 Agent 层之后，有三条硬性约束：

1. `AgentRegistry` 的 `AGENT_INJECT` 要求 `agents`、`chatluna`、`ai`、`tools`、`prompt`、`sessions`、`trace`、`presets`、`tool_search` 九个服务同时在场。本插件只注入 `chatluna`、`memory`、`database`、`chatluna_collector` 四个；接 `agents` 会把插件依赖扩大到九个服务，宿主少装任何一个都会让整个插件不加载。
2. `chat-observer` 会索引每个带 `options.conversationKey` 的 agent。内部召回与 Dream 会话一旦注册，就会进入用户消息池，污染自动提取的素材边界与召回窗口。
3. Dream 需要按批次推进的状态机、每轮结束后的进度反馈消息、以及超过 20 万 token 时的历史压缩；这些都不是「给一句用户输入、等模型自然停止」的 turn driver 能表达的。

## Decision

插件自带一层最小的工具循环，直接驱动 `ctx.chatluna.chat`，不经过 `ctx.agents`。

`src/service/workflows/tool_call.ts` 定义内部工具契约：`{ name, description, args: Schema, run(input) }`，并把执行结果规范成给模型看的一段文本（成功、参数不合法、未知工具、执行失败四种）。`src/service/workflows/tool_loop.ts` 是循环本体：每步先按 `prepareMessages` 取消息，调用一次模型，把助手消息推入历史，零个或多个工具调用按策略处理，结果以 `tool-result` 块推回，命中结论工具或达到调用上限即结束。

召回与 Dream 共用这一个循环，差异全部由选项表达：

| 选项 | 召回 | Dream |
| --- | --- | --- |
| `maxModelCalls` | 6 | 1（外层按批最多 60 轮） |
| `multipleToolCalls` | 拒绝 | 顺序执行 |
| `conclusiveTools` | 检索之外的 pass 与快照更新 | 无 |
| `prepareMessages` | 无 | 按批次压缩历史后返回 |
| `onRound` | 无 | 上报本轮是否有效，驱动连续 3 轮无效即跳过 |

零个或多于一个工具调用时，助手消息不进入历史，只追加一条纠正提示，与 v1 的 scratchpad 语义一致。`signal.throwIfAborted()` 在每次模型调用与每次工具执行前检查。

工具不注册到 `ctx.tools`：它们的作用域与批次状态由闭包持有，只在本循环内可见，不出现在模型工具的全局清单里。

## Alternatives considered

**接入 `ctx.agents`**：能直接复用会话持久化、工具检索与 trace，代码量最小。放弃原因是上面三条约束：依赖面从 4 个服务扩到 9 个；内部会话进入 `chat-observer` 索引、污染用户消息池；turn driver 无法表达 Dream 的批次状态机与逐轮推进消息。

**把 Dream 拆成每批一个 agent 会话**：可以让每个会话自然结束，规避状态机。但提示词、人设与历史仍然要跨批次共享，拆分后每批都要重建历史，20 万 token 的压缩逻辑反而要写两遍。

**召回用 `ctx.agents`、Dream 自行驱动**：两种模型调用路径并存，日志、重试与取消语义要维护两套。收益只有召回一侧的代码量，不足以抵消分叉成本。

## Consequences

收益：插件保持四个服务的最小依赖；内部会话不进入观测层与用户消息池；Dream 的批次状态、跳过条件与历史压缩可以按 v1 语义逐条复刻，迁移期的行为对照有据可依。

代价：约 260 行循环代码由插件自己维护，v2 在 agent 层的改进（工具检索、重试策略、用量统计）不会自动惠及这里。工具 schema 到 JSON Schema 的转换、结果渲染、纠正提示措辞也都留在插件侧。

已验证：`agentic-recall`、`dream-session`、`dream-workflows`、`indexed-memory-mutations` 覆盖了工具执行、多调用拒绝、6 次上限、批次跳过与覆盖统计。

## Testing

- `tests/agentic-recall.spec.ts`：脚本化的模型返回驱动工具循环，断言系统提示转义、工具结果文本、6 次调用耗尽、去重与多调用拒绝。
- `tests/dream-session.spec.ts`：批次推进、连续 3 轮无效跳过、历史压缩触发条件。
- `tests/dream-workflows.spec.ts`：端到端 Dream 流程与覆盖统计。
- `tests/indexed-memory-mutations.spec.ts`：会话工具在索引失败、目标失效时的记录与告警语义。