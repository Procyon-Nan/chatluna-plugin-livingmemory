# Agent Note: Standalone memory and conversation rules

Status: implemented

English | [中文](2026-11-07-standalone-memory.zh.md)

## Problem

LivingMemory schedules extraction, Dream and profile generation. These tasks need to run independently of native memory while sharing the framework’s conversation rules and chat history.

## Decision

LivingMemory starts, stops, stores data and schedules its own work. Its task page subscribes to its repository and retains partially completed Dream results. Both plugins may run at the same time and process their own memories.

The framework owns the `livingmemory` conversation rule section. Group chats match by platform, bot and guild or channel; direct chats match by their conversation address. Everyone at the same address shares the settings for recall, isolation, injection, extraction windows, overheard messages and post-extraction Dream. Models, tool registration and profile generation belong to the instance. Rules govern how a trigger is handled; the [official observer](2026-11-07-official-observer-window.md) still provides shared channel history. The sender, mentions and message text do not participate in this match.

## Alternatives considered

**An optional backend.** The native task page could list both implementations, at the cost of maintaining two routes and task status mappings. The dedicated page already presents the complete business state.

**Per-channel plugin configuration.** This would reproduce override and inheritance logic outside the framework's conversation rule editor.

## Consequences

A conversation with an extraction interval of zero skips automatic extraction. To enable it only in selected chats, set the global interval to zero and override it for those chats. Replies and batches already submitted to the extractor retain their trigger settings; subsequent triggers use the new rules. Routing tests cover inheritance and live changes, and repository and WebUI tests cover job notifications and partial results.
