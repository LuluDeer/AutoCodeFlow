/**
 * CORE-04: 超时策略分级——纯决策逻辑，零状态、零依赖。
 *
 * 背景：此前超时是单级树杀语义——执行器在 task.timeout 秒后强杀进程树并
 * 回调 failureReason=timeout，admin 侧把执行置 TIMEOUT 且绝不重试
 * （processor 的 UnrecoverableError 双派发护栏 + stale sweep 超时桶）。
 *
 * 本模块把「超时后做什么」从硬编码行为变成任务级可配置策略，分两块：
 *
 * ① timeoutAction（tasks.timeoutAction，可空 varchar）：
 *   - kill（缺省/null）：现状语义——执行器树杀 + 回调 timeout 终态。
 *   - kill_retry：同样树杀，但 admin 侧在超时终态落定后按任务既有重试
 *     预算（maxRetry/retryDelay）re-enqueue 一次新执行。预算判定与
 *     re-enqueue 复用 ExecutorService.hasRetryBudget /
 *     scheduleRetryAfterRecovery（executor-restart / stale sweep 同源），
 *     预算耗尽则退化为普通 kill（终态保持 TIMEOUT，不额外建行）。
 *   - notify_only：不向执行器下发任何终止指令（执行器自身的硬超时仍在，
 *     进程树仍会被执行器杀掉并回调——本策略只改变 admin 侧行为：不额外
 *     发 kill、终态照常入库、只保证超时告警发出）。适用"宁可跑完也别杀"
 *     的批任务；文档写明边界：notify_only ≠ 不超时，进程仍在执行器侧被杀。
 *
 * ② 超时预警（timeoutWarnRatio，可空 int，百分数 0-90）：
 *   执行已运行时长达到 timeout×ratio 时发送一次 WARNING 级预警通知
 *   （NotificationService.notifyTimeout），每个执行至多一次（调用方持
 *   warned 标记去重，本模块只做纯计算）。
 *
 * 纯函数 + 常量独立成文件：processor / TaskService 两处消费同一判定，
 * 语义永不漂移；无需 DB/网络即可全量单测。
 */

/** 超时动作值域（tasks.timeoutAction 可空 varchar；null/缺省 = kill 语义） */
export type TimeoutAction = "kill" | "kill_retry" | "notify_only";

export const TIMEOUT_ACTIONS: readonly TimeoutAction[] = [
  "kill",
  "kill_retry",
  "notify_only",
];

/** 缺省动作：与既有单级树杀行为完全一致（存量任务行为零变化） */
export const DEFAULT_TIMEOUT_ACTION: TimeoutAction = "kill";

/**
 * 预警比例缺省值（计划书 §4：warn 阈值 80%）。仅在执行显式配置了
 * timeoutWarnRatio 时启用预警——存量任务（null）零新通知。
 */
export const DEFAULT_TIMEOUT_WARN_RATIO = 80;

/** timeoutWarnRatio 允许的边界：0（入队即预警）~ 90（必须小于 100%） */
export const TIMEOUT_WARN_RATIO_MIN = 0;
export const TIMEOUT_WARN_RATIO_MAX = 90;

/**
 * 归一化任意运行时形态的 timeoutAction：
 * - 合法值原样返回；未知/缺失/null → kill（缺省语义）。
 * - 大小写不敏感、两侧空白容忍（表单/API 手滑输入的防御）。
 */
export function normalizeTimeoutAction(value: unknown): TimeoutAction {
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if ((TIMEOUT_ACTIONS as readonly string[]).includes(trimmed)) {
      return trimmed as TimeoutAction;
    }
  }
  return DEFAULT_TIMEOUT_ACTION;
}

/**
 * 归一化预警比例：整数 0..90 原样返回；其余（负数/超界/非整数/null）→
 * null = 未启用预警。合法但等于 0 表示"入队即预警"（测试/极短任务用）。
 */
export function normalizeTimeoutWarnRatio(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    if (value >= TIMEOUT_WARN_RATIO_MIN && value <= TIMEOUT_WARN_RATIO_MAX) {
      return value;
    }
  }
  return null;
}

/**
 * 预警判定：执行已运行 elapsedMs 是否已达到预警阈值
 * （timeout×ratio/100）。timeout<=0（不限时）或比例无效 → 永不预警。
 * 返回 null = 未达阈值；否则返回阈值毫秒数（日志/通知文案用）。
 */
export function timeoutWarnThresholdMs(
  timeoutSec: number | null | undefined,
  warnRatio: number | null | undefined,
  elapsedMs: number,
): number | null {
  const ratio = normalizeTimeoutWarnRatio(warnRatio);
  if (ratio === null) return null;
  if (!timeoutSec || timeoutSec <= 0) return null;
  if (elapsedMs < 0) return null;
  const thresholdMs = (timeoutSec * 1000 * ratio) / 100;
  return elapsedMs >= thresholdMs ? thresholdMs : null;
}
