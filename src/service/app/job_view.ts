import type { MemoryJob, MemoryTrigger } from '@chatluna/memory'
import type { MemoryJobRecord } from '../../contracts/memory.ts'

/**
 * LivingMemory 任务行到原生 `MemoryJob` 的投影。
 *
 * 原生任务页只读取 `listJobs(presetId)` 与 `chatluna/memory-job` 事件，字段形状
 * 由 `packages/memory/core/src/types.ts` 的 `MemoryJob` 固定。这里把迁移保留的
 * 审计行映射成该形状，供框架把后端任务并入同一次执行记录（M01-C3）。
 *
 * 映射规则：
 * - `id`、`presetId`、`kind`、`status`、`error` 原样保留；`scope` 由预设与任务
 *   行的会话组成。
 * - 未开始的 `pending` 行没有开始时间，以 `createdAt` 顶替，保证页面按开始时间
 *   排序与服务端一致。
 * - `trigger` 由任务输入推导（见 `resolveTrigger`）。
 * - `stats` 与 `operations` 留空：v1 把统计写在 `detail` 文本里，操作明细由 Dream
 *   会话记录持有，两者都不是原生页面逐条对比条目的语义。
 */
export const toNativeJob = (record: MemoryJobRecord): MemoryJob => ({
    id: record.id,
    kind: record.kind,
    // 取消态是本项目新增的终态。框架侧 MemoryJobStatus 补齐前按原值传递，
    // 页面以任务错误列展示取消原因；需求见 doc/framework-requirements.md 第 5 项。
    status: record.status as MemoryJob['status'],
    presetId: record.presetId,
    scope: {
        presetId: record.presetId,
        conversationId: record.conversationId
    },
    trigger: resolveTrigger(record),
    stats: {},
    ...(record.error === null ? {} : { error: record.error }),
    startedAt: (record.startedAt ?? record.createdAt).getTime(),
    ...(record.finishedAt === null
        ? {}
        : { finishedAt: record.finishedAt.getTime() })
})

/**
 * 触发原因：Dream 任务以 `<trigger>:<presetId>` 写入输入；提取与召回只在失败时
 * 落任务行，其输入是模型输入正文；索引任务以 `<操作>: <原因>` 写入，没有独立
 * 的触发来源，按手动处理。
 */
const resolveTrigger = (record: MemoryJobRecord): MemoryTrigger => {
    switch (record.kind) {
        case 'dream':
            return record.input.startsWith('post-extraction:')
                ? 'window'
                : 'manual'
        case 'extract':
        case 'recall':
            return 'window'
        case 'index':
            return 'manual'
    }
}