# Agent Note: 从官方 observer 读取聊天

Status: implemented

## Problem

[统一消息来源的决定](2026-11-06-framework-chat-history.md)需要一个已发布的读取入口。原生 memory 从频道缓冲读取历史。Session 日志分页实验要求修改框架，也给插件引入了未发布的依赖。

## Decision

提取和召回只用 `chat_observer.recentOfConversation(key, limit)` 读取正文。用户输入按本轮消息 ID 定位；机器人的消息按实际发送事件的轮次、预设和平台 ID 确认归属。旁听沿用同一接口。消费位置仅在插件本次运行内有效，缓冲滚动不改变仍在其中的消息的位置。

## Alternatives considered

从 Agent 的模型上下文拼接历史会带入未发送内容，并漏掉旁听。另存回填消息或扩展 Session 都会形成第二个聊天来源。

## Consequences

只消费官方缓冲保留的记录；冷启动回填事件没有写入该缓冲的正文不会补入。未进入 observer 的入口也没有可读历史。提取窗口大于可读聊天数时，阈值不会达到。切换历史后的上下文从切换处开始，不能重建分支祖先的聊天。预设切换、重启、失败批次和卸载规则见[实施与验收](../../../../doc/message-pool.md)。
