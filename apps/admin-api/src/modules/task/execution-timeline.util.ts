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
  /**
   * 本段耗时（毫秒，加性可选字段）：started=排队等待（created→started），
   * finished=运行时长（started→finished）。端点缺失/非法/时序倒挂时该键不出现，
   * 旧调用方（含严格断言对象形状的单测）逐字节兼容。
   */
  durationMs?: number;
  /**
   * 阶段时长汇总（仅 finished 段、且三段均齐全时出现，加性可选字段）。
   * queueWaitMs=排队等待，runDurationMs=运行时长，totalDurationMs=端到端。
   */
  queueWaitMs?: number;
  runDurationMs?: number;
  totalDurationMs?: number;
}

/** 阶段时长汇总的独立读面（与 buildExecutionTimeline 同源计算）。 */
export interface ExecutionTimelineDurations {
  queueWaitMs: number | null;
  runDurationMs: number | null;
  totalDurationMs: number | null;
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

function toMillis(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  const t = d.getTime();
  return Number.isNaN(t) ? null : t;
}

/** 两时刻齐全且时序不倒挂时返回非负毫秒差，否则 null（绝不抛错）。 */
function diffMs(from: number | null, to: number | null): number | null {
  if (from === null || to === null || to < from) return null;
  return to - from;
}

/**
 * 阶段时长汇总——与 buildExecutionTimeline 同源计算。
 * queueWaitMs=created→started（排队），runDurationMs=started→finished（运行），
 * totalDurationMs=created→finished（端到端）；缺失/非法/倒挂均为 null。
 */
export function getExecutionTimelineDurations(
  e: ExecutionTimelineSource,
): ExecutionTimelineDurations {
  return {
    queueWaitMs: diffMs(toMillis(e.createdAt), toMillis(e.startTime)),
    runDurationMs: diffMs(toMillis(e.startTime), toMillis(e.endTime)),
    totalDurationMs: diffMs(toMillis(e.createdAt), toMillis(e.endTime)),
  };
}

/**
 * 执行行 → 三段时间线。绝不抛错：任一字段缺失/非法都落为 null 段，
 * 让 UI 永远能渲染出骨架（空时刻显示「—」）。
 *
 * 增强：started/finished 段新增可选 durationMs，finished 段在三段齐全时
 * 新增 queueWaitMs/runDurationMs/totalDurationMs。所有键仅在值可计算时出现，
 * 既有严格对象断言与前端字段面逐字节兼容。
 */
export function buildExecutionTimeline(
  e: ExecutionTimelineSource,
): ExecutionTimelineEntry[] {
  const { queueWaitMs, runDurationMs, totalDurationMs } =
    getExecutionTimelineDurations(e);
  const started: ExecutionTimelineEntry = {
    phase: "started",
    at: toIso(e.startTime),
    detail: e.executorAddress ? `executor=${e.executorAddress}` : undefined,
  };
  if (queueWaitMs !== null) started.durationMs = queueWaitMs;
  const finished: ExecutionTimelineEntry = {
    phase: "finished",
    at: toIso(e.endTime),
    detail: e.status ? `status=${e.status}` : undefined,
  };
  if (runDurationMs !== null) finished.durationMs = runDurationMs;
  if (
    queueWaitMs !== null &&
    runDurationMs !== null &&
    totalDurationMs !== null
  ) {
    finished.queueWaitMs = queueWaitMs;
    finished.runDurationMs = runDurationMs;
    finished.totalDurationMs = totalDurationMs;
  }
  return [
    {
      phase: "created",
      at: toIso(e.createdAt),
      detail: e.triggerType ? `trigger=${e.triggerType}` : undefined,
    },
    started,
    finished,
  ];
}
