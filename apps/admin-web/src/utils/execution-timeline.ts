/**
 * OBS-04: 执行时间线映射（纯函数，无 React 依赖）。
 *
 * 数据源是后端 report 端点返回的 execution 行（task_executions 表的
 * createdAt/startTime/endTime 时间戳列），前端不做任何二次推算——
 * 展示与 DB 时间戳一致的验收契约在这里落地：缺省时刻渲染为 null，
 * 由 UI 层显示「—」。分段语义与 admin-api execution-timeline.util.ts
 * 及 mcp-server buildExecutionTimeline（ECO-03）三端对齐。
 *
 * N-04 收尾：阶段文案不再保留中文映射表（timeline.phase.* zh/en 双侧成对），
 * t 可选——传参走调用方的 t，缺省回落 i18n 单例（非组件文件直引单例，
 * 与 api/tasks.ts 同模式；测试环境默认 zh，输出与旧中文基线逐字一致）。
 */

import i18n from '../i18n';

export interface TimelineEntry {
  phase: "created" | "started" | "finished";
  /** 事件时刻；null = 未到达该阶段（UI 显示「—」） */
  at: string | null;
  detail?: string;
  /**
   * B3-②：阶段耗时（毫秒，前端由相邻 DB 时间戳派生，非后端列）。
   * - started 段：排队等待 = startTime − createdAt；
   * - finished 段：运行耗时 = endTime − startTime；
   * - 缺时刻 / 非法 / 时钟回退 ⇒ null（UI 不显示耗时，不猜数）。
   */
  durationMs?: number | null;
}

/** 最小字段面：与后端 TaskExecution 序列化形状对齐 */
export interface TimelineSource {
  status?: string | null;
  triggerType?: string | null;
  executorAddress?: string | null;
  createdAt?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  /** B3-②：失败归类（终态段失败点高亮用；无归类为 null） */
  failureReason?: string | null;
  /** B3-②：原始错误信息（终态段失败点展开用） */
  errorMessage?: string | null;
  /** B3-②：链内重试序号（0 = 原始尝试），用于「第 N 次尝试」元信息 */
  retryCount?: number | null;
}

/** 阶段文案工厂：传 t 时走调用方的 t；缺省回落 i18n 单例。 */
export function TIMELINE_PHASE_LABELS(
  t?: (k: string) => string,
): Record<TimelineEntry["phase"], string> {
  const T = t ?? ((k: string) => i18n.t(k));
  return {
    created: T('timeline.phase.created'),
    started: T('timeline.phase.started'),
    finished: T('timeline.phase.finished'),
  };
}

function toIsoOrNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * 相邻两时刻差值（毫秒）。任一缺失/非法、或后值早于前值（时钟回退/脏数据）
 * ⇒ null，绝不产出负耗时或 NaN。
 */
function diffMs(fromIso: string | null, toIso: string | null): number | null {
  if (!fromIso || !toIso) return null;
  const a = new Date(fromIso).getTime();
  const b = new Date(toIso).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return b - a;
}

/**
 * 执行行 → 三段时间线；绝不抛错，非法/缺失字段一律落 null 段。
 * durationMs 为前端派生的相邻段耗时（见 TimelineEntry.durationMs 注释）。
 */
export function buildExecutionTimeline(e: TimelineSource): TimelineEntry[] {
  const createdAt = toIsoOrNull(e.createdAt);
  const startedAt = toIsoOrNull(e.startTime);
  const finishedAt = toIsoOrNull(e.endTime);
  return [
    {
      phase: "created",
      at: createdAt,
      detail: e.triggerType ? `trigger=${e.triggerType}` : undefined,
    },
    {
      phase: "started",
      at: startedAt,
      detail: e.executorAddress ? `executor=${e.executorAddress}` : undefined,
      durationMs: diffMs(createdAt, startedAt),
    },
    {
      phase: "finished",
      at: finishedAt,
      detail: e.status ? `status=${e.status}` : undefined,
      durationMs: diffMs(startedAt, finishedAt),
    },
  ];
}
