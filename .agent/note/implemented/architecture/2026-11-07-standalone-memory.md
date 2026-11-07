# Agent Note: Standalone memory and conversation rules

Status: implemented

English | [中文](2026-11-07-standalone-memory.zh.md)

## Problem

LivingMemory already owns automatic extraction, Dream, profiles and legacy imports. Making it a native memory backend introduced a second owner for scheduling and task presentation, and disabling native memory prevented the plugin from loading. The conversation rules and chat history are the parts that need to be shared.

## Decision

LivingMemory starts, stops, stores data and schedules its own work. Its task page subscribes to its repository and retains partially completed Dream results. Both plugins may run at the same time and process their own memories. This replaces D01 in the [migration plan](../../../../doc/migration-plan.md) and the backend entry point in the [v1 behavior proposal](../../proposed/architecture/2026-11-04-v1-behavior-preservation.md) and [extraction window proposal](../../proposed/architecture/2026-11-03-extraction-window-and-chunking.md); their business rules still apply.

The framework owns the `livingmemory` conversation rule section. The triggering user, platform, guild and channel determine recall, isolation, injection, extraction window, overheard handling and post-extraction Dream. Models, tool registration, profile generation and the extraction allowlist belong to the instance. Rules govern how a trigger is handled; the [official observer](2026-11-07-official-observer-window.md) still provides shared channel history. Transient message conditions such as text matches are outside this identity-based lookup.

## Alternatives considered

**An optional backend.** The native task page could list both implementations, at the cost of maintaining two routes and task status mappings. The dedicated page already presents the complete business state.

**Per-channel plugin configuration.** This would reproduce override and inheritance logic outside the framework's conversation rule editor.

## Consequences

Existing overrides for the nine conversation settings must move to the global rule. The instance allowlist continues to constrain all automatic extraction. Replies and batches already submitted to the extractor retain their trigger settings; subsequent triggers use the new rules. Routing tests cover inheritance and live changes, and repository and WebUI tests cover job notifications and partial results. Cross-engine acceptance on a real platform with models is tracked in the [stage checklist](../../../../doc/migration-stages.md).
