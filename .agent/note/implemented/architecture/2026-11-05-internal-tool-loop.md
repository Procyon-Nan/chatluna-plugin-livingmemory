# Agent Note: 召回与 Dream 自行驱动工具循环

Status: implemented

## Problem

召回要等模型明确选择更新快照或跳过。Dream 要核对一批记忆的处理进度；一次工具调用成功，并不表示整批已经完成。

## Decision

两个流程共用 `LivingMemoryToolLoop.runRound()` 调用模型和执行内部工具，再分别判断是否结束。召回用 `runUntilConclusion()` 等待结束工具；Dream 每轮执行后查看剩余记忆，必要时把进度反馈给模型。内部工具绑定本次运行的状态，不注册到全局工具列表。

## Alternatives considered

**交给对话 Agent 自行结束。** 模型结束回答不能说明哪些记忆已经处理。Dream 仍需维护批次状态，内部任务也没有需要持久化的用户对话。

**两个流程分别实现工具循环。** 工具调用、结果记录和取消都要维护两次，实际差异只是成功条件和下一轮的输入。

## Consequences

召回最多调用模型六次，一次响应包含多个工具时要求模型重新选择。Dream 可以顺序执行多个工具，按剩余记忆推进；连续三轮无有效操作或满六十轮时跳过剩余项。相应边界由 `tests/agentic-recall.spec.ts` 和 `tests/dream-session.spec.ts` 覆盖。
