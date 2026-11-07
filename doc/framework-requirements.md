# ChatLuna v2 框架侧接口需求

更新：2026-11-07。核对源码 `5e2fdce`。消息读取使用现有公开接口，插件不依赖框架补丁。

## 1—3. 消息历史、交付与会话边界（M05、M02、M06）

消息正文来自 `ctx.chat_observer.recentOfConversation(conversationKey, limit)`，与原生 memory 共用入口。接口按频道返回当前缓冲，插件不设置 200 条上限。超出宿主容量的旧消息和只通过冷启动回填事件交给 Agent 的消息读不到；插件不从模型日志补写。

`chatluna/observed` 通知旁听进度。`send` 中的 `chatSent.reply` 提供会话、预设、轮次和平台消息 ID，用于从缓冲中认出真正发出的回复。一次发送返回多个 ID 时只算一次；分段发送分别计数。普通提取等待本轮渲染和回复观察完成，命令通知、工具和思考不计入阈值。

预设生效与会话切换通知用于重设消费起点，边界取当时缓冲末尾。具体限制与验收见[消息来源与消费](message-pool.md)。

## 4—6. 对话规则、调度和任务

LivingMemory 在框架的 `rules.capabilities` 注册独立的 `livingmemory` 区块。规则由框架匹配、继承和保存。消息与会话接入继续使用上面的公共接口。

提取、召回、Dream 与任务审计均由插件管理。专用页读取仓储，通过 `livingmemory/job-change` 刷新，直接展示 `partial` 等业务状态；卸载时停止在途工作。原 M01-C1/C2/C3 的原生调度让出、跨后端取消和任务页投影要求已撤销。

## 7. 工具参数 schema 字段说明（M04）

`8d9848f` 的 `packages/core/schema/src/json-schema.ts` 已统一输出 `meta.description`，带说明的常量选项保持 `oneOf`，保留各分支说明。旧框架丢说明的结论已过时。

插件原有工具描述规避仍保留。本次不扩展调整工具提示词。模板包同步后验证 `toolSpec().parameters`、`describe()` 的字段说明和模型实际收到的参数 schema。

## 实施状态与依赖

| 项 | 插件侧 | 框架侧 |
| --- | --- | --- |
| 1 聊天历史 | 已移除消息池，改为无缓存读取 | 官方 observer 频道缓冲与观察通知 |
| 2 真实交付 | 已移除末条 assistant 补写 | 官方 send 提供实际回复归属 |
| 3 生命周期 | 已接入消费边界 | 官方预设、会话变化事件 |
| 4 对话规则 | 独立命名空间 livingmemory | schemas 与 routing |
| 5—6 自动调度与管理页 | 由插件负责 | 无原生 memory 接入要求 |
| 7 schema 说明 | 保留既有提示词，待同步包后复验 | 上游已实现 |

实际宿主的跨引擎运行验收见[实施阶段](migration-stages.md)。
