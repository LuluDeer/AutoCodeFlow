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
}

/** 最小字段面：与后端 TaskExecution 序列化形状对齐 */
export interface TimelineSource {
  status?: string | null;
  triggerType?: string | null;
  executorAddress?: string | null;
  createdAt?: string | null;
  startTime?: string | null;
  endTime?: string | null;
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

/** 执行行 → 三段时间线；绝不抛错，非法/缺失字段一律落 null 段。 */
export function buildExecutionTimeline(e: TimelineSource): TimelineEntry[] {
  return [
    {
      phase: "created",
      at: toIsoOrNull(e.createdAt),
      detail: e.triggerType ? `trigger=${e.triggerType}` : undefined,
    },
    {
      phase: "started",
      at: toIsoOrNull(e.startTime),
      detail: e.executorAddress ? `executor=${e.executorAddress}` : undefined,
    },
    {
      phase: "finished",
      at: toIsoOrNull(e.endTime),
      detail: e.status ? `status=${e.status}` : undefined,
    },
  ];
}
