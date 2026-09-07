/**
 * OBS-04: 执行时间线映射（纯函数，供 TaskService.getExecutionReport 使用）。
 *
 * 分段语义与 packages/mcp-server/src/tools.ts 的 buildExecutionTimeline
 * （ECO-03）对齐：created → started → finished 三段，缺省时刻 at=null，
 * 前端渲染为「—」。数据源是 task_executions 行自身的时间戳列
 * （createdAt/startTime/endTime——writer 分别为行创建 / task.processor
 * RUNNING 落库 / handleCallback 终态落库），保证展示与 DB 一致；
 * duration 为 DB 毫秒数原样透出（不做二次计算）。
 */

/** timeline 单段：phase 固定三值；at 为 ISO 字符串或 null（执行未到达该阶段）。 */
export interface ExecutionTimelineEntry {
  phase: "created" | "started" | "finished";
  /** DB 时间戳 ISO 串；null = 该阶段尚未发生（前端显示「—」） */
  at: string | null;
  detail?: string;
}

/** 最小字段面：与 task_executions 列对齐，便于单测构造与前端复用。 */
export interface ExecutionTimelineSource {
  status?: string | null;
  triggerType?: string | null;
  executorAddress?: string | null;
  createdAt?: Date | string | null;
  startTime?: Date | string | null;
  endTime?: Date | string | null;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * 执行行 → 三段时间线。绝不抛错：任一字段缺失/非法都落为 null 段，
 * 让 UI 永远能渲染出骨架（空时刻显示「—」）。
 */
export function buildExecutionTimeline(
  e: ExecutionTimelineSource,
): ExecutionTimelineEntry[] {
  const startedAt = toIso(e.startTime);
  const finishedAt = toIso(e.endTime);
  return [
    {
      phase: "created",
      at: toIso(e.createdAt),
      detail: e.triggerType ? `trigger=${e.triggerType}` : undefined,
    },
    {
      phase: "started",
      at: startedAt,
      detail: e.executorAddress ? `executor=${e.executorAddress}` : undefined,
    },
    {
      phase: "finished",
      at: finishedAt,
      detail: e.status ? `status=${e.status}` : undefined,
    },
  ];
}
