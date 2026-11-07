# Agent Note: 使用框架聊天历史，移除 LivingMemory 自建消息池

Status: implemented

## Problem

v1 建消息池是为了让不同引擎共用聊天来源。v2 已有统一观察服务，插件再复制聊天、拼接 Agent 历史会产生两套记录。

## Decision

由框架提供聊天正文。LivingMemory 只负责转写、计数、分块、在途批次和结果处理。输入保留用户聊天及实际发出的助手回复，以 `[时间] 昵称：正文` 呈现；不从工具步骤或未交付的模型文本推断聊天。

## Alternatives considered

保留 v1 消息池需要插件持续采集、去重、回填与清理。曾尝试扩展宿主 Session 提供分页聊天日志；这一实验已由[官方近期窗口](2026-11-07-official-observer-window.md)取代。

## Consequences

切换预设或重启重新计数，已形成记忆的来源仍随记忆保存。提取、召回和验收进度见[消息来源与消费](../../../../doc/message-pool.md)。
