/**
 * N22（strategy §12.3）：SLA 计量的机器可判纯函数层。
 *
 * 对齐 docs/plan/agent-workbench-ops-runbook.md §2 的四条 SLA 契约，并沿用
 * scripts/metrics-health.mjs::evaluateHealth 的诚实口径：没有起算样本就是
 * no_data（met=false 语义），绝不把缺失补成达标。
 *
 * 本文件零 Nest / DB / 时钟依赖：所有时刻由调用方以 epoch ms 传入，
 * 纯函数只做判定，审核流水线的接线不在本层。
 */

// ── 时长常量（全部毫秒）──────────────────────────────────────────────────────
export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
/** 1 工作日 = 周一至周五 09:00–18:00 共 9 小时工作窗（非 24 小时连续时间）。 */
export const BUSINESS_DAY_MS = 9 * HOUR_MS;

/** 四类 SLA 目标；capability_review 用 business 钟，其余三类用 wall 钟。 */
export const SLA_LIMITS = {
  capability_review: BUSINESS_DAY_MS, // ≤1 工作日
  quota_alert: 2 * HOUR_MS, // ≤2h
  generation_invalidation: HOUR_MS, // ≤1h
  audit_query: 5 * MINUTE_MS, // ≤5min
} as const;

export type SlaStatus = "met" | "breached" | "pending" | "no_data";

export interface SlaVerdict {
  status: SlaStatus;
  elapsedMs: number;
  limitMs: number;
  /** limitMs - elapsedMs；违约时为负，直观给出超时量。no_data 时为 0（无样本不造数值）。 */
  remainingMs: number;
}

/** 简单工作日历配置；窗口按 UTC 墙钟解释，不读取宿主时区。 */
export interface BusinessCalendarConfig {
  /** 每日起始分钟（0..1440），默认 540 = 09:00 UTC。 */
  workStartMinute?: number;
  /** 每日结束分钟（0..1440），默认 1080 = 18:00 UTC。 */
  workEndMinute?: number;
  /** getUTCDay() 语义：0=周日 … 6=周六；默认 [1,2,3,4,5]。 */
  workDays?: readonly number[];
}

export type SlaClock = "wall" | "business";

export interface EvaluateSlaInput {
  /** 起算时刻（epoch ms）；null/undefined/NaN ⇒ no_data，不猜起点。 */
  startedAt: number | null | undefined;
  /** 完成时刻（epoch ms）；空值表示仍在跑，用 nowMs 观察。 */
  completedAt: number | null | undefined;
  limitMs: number;
  nowMs: number;
  /** 默认 "wall"；能力审核传 "business"，耗时改由 businessElapsedMs 累计。 */
  clock?: SlaClock;
  /** 仅 clock="business" 生效；不传即用 Mon–Fri 09:00–18:00 UTC 简单窗口。 */
  calendar?: BusinessCalendarConfig;
}

const DAY_MS = 24 * HOUR_MS;

function windowMinute(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(1440, Math.max(0, Math.trunc(value)));
}

/**
 * 只累计“周一至周五 09:00–18:00（UTC）”窗口内的毫秒数。
 *
 * 诚实边界：**不含法定节假日、不读本地时区、不做 DST 换算**——仓库里没有
 * 工作日历/节假日数据，这里不虚构。需要真实日历的调用方通过 config 注入
 * 工作日与窗口；本函数只保证简单窗口的确定性语义。
 */
export function businessElapsedMs(
  start: number,
  end: number,
  config: BusinessCalendarConfig = {},
): number {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    return 0;

  const startMinute = windowMinute(config.workStartMinute, 9 * 60);
  const endMinute = windowMinute(config.workEndMinute, 18 * 60);
  if (endMinute <= startMinute) return 0;

  const workDays = (config.workDays ?? [1, 2, 3, 4, 5]).filter(
    (d) => Number.isInteger(d) && d >= 0 && d <= 6,
  );

  let total = 0;
  let dayStart = Math.floor(start / DAY_MS) * DAY_MS;
  const lastDayStart = Math.floor(end / DAY_MS) * DAY_MS;
  while (dayStart <= lastDayStart) {
    if (workDays.includes(new Date(dayStart).getUTCDay())) {
      const from = Math.max(start, dayStart + startMinute * MINUTE_MS);
      const to = Math.min(end, dayStart + endMinute * MINUTE_MS);
      if (to > from) total += to - from;
    }
    dayStart += DAY_MS;
  }
  return total;
}

/**
 * SLA 判定：无 startedAt ⇒ no_data（met=false 语义）；未完成且未超 ⇒ pending；
 * 超 limit ⇒ breached；完成且未超 ⇒ met。判定用完成时刻，不用观察时刻。
 */
export function evaluateSla(input: EvaluateSlaInput): SlaVerdict {
  const { startedAt, limitMs } = input;
  if (
    startedAt === null ||
    startedAt === undefined ||
    !Number.isFinite(startedAt)
  ) {
    return { status: "no_data", elapsedMs: 0, limitMs, remainingMs: 0 };
  }

  const completedAt =
    typeof input.completedAt === "number" && Number.isFinite(input.completedAt)
      ? input.completedAt
      : null;
  const observedAt = completedAt ?? input.nowMs;
  if (!Number.isFinite(observedAt)) {
    return { status: "no_data", elapsedMs: 0, limitMs, remainingMs: 0 };
  }

  // 时钟回拨不产生负耗时。
  const end = Math.max(startedAt, observedAt);
  const elapsedMs =
    input.clock === "business"
      ? businessElapsedMs(startedAt, end, input.calendar)
      : end - startedAt;
  const remainingMs = limitMs - elapsedMs;

  let status: SlaStatus;
  if (elapsedMs > limitMs) status = "breached";
  else if (completedAt !== null) status = "met";
  else status = "pending";

  return { status, elapsedMs, limitMs, remainingMs };
}
