/**
 * 后端自动流程归属声明（M01-C1）。
 *
 * `true` 表示该自动入口由后端负责：原生不再建游标、不建定时器、不做阈值判断，
 * 只保留手动入口（`ctx.memory.extract`、`ctx.memory.dream`）。`undefined` 视为
 * `false`，原生保持默认流程。
 *
 * LivingMemory 三个入口全部自有：提取走自己的窗口与分块，召回走自己的代理式
 * 召回，Dream 走批次状态机。声明以只读字段挂在后端实例上，框架落地后在
 * `MemoryBackend` 上读取同一字段。
 */
export interface MemoryBackendScheduling {
  readonly extract?: boolean
  readonly dream?: boolean
  readonly recall?: boolean
}

