/**
 * CORE-02: 重试退避抖动（jitter）纯函数。
 *
 * 指数退避在多任务同周期失败时会让所有重试"整齐地"落在同一时刻
 * （thundering herd），±20% 的抖动把重试时刻摊开。这里不做 BullMQ 的
 * backoff 函数注入（函数化 backoff 会让重试延迟在 UI/日志侧不可预算），
 * 而是在四个 enqueue 边界（task.service trigger/rollback、scheduler
 * enqueue、executor.service scheduleRetryAfterRecovery）直接算好整数
 * 毫秒传给 BullMQ 的 { type: "exponential", delay }。
 */

/** 默认抖动幅度 ±20%。 */
export const RETRY_JITTER_RATIO = 0.2;

/**
 * 计算带 ±ratio 抖动的指数退避延迟（整数毫秒）。
 *
 * base = retryDelay * 1000 * 2^(attempt-1)，返回值均匀分布在
 * [base * (1 - ratio), base * (1 + ratio)] 闭区间内。
 *
 * 确定性：随机源由参数注入，单测可固定；生产用默认 Math.random。
 *
 * @param retryDelaySec  任务配置的重试延迟（秒，>=0）
 * @param attempt        BullMQ 即将进行的尝试序号（1 起；0 视为 1）
 * @param random         [0,1) 随机源，测试注入用
 * @param ratio          抖动幅度（默认 0.2），0 = 关闭抖动
 * @returns 整数毫秒延迟；retryDelaySec<=0 或非有限值返回 0（= 不延迟，
 *          与既有 backoff: undefined 语义一致，调用方据 0 省略 backoff）
 */
export function jitteredRetryDelayMs(
  retryDelaySec: number | null | undefined,
  attempt: number,
  random: () => number = Math.random,
  ratio: number = RETRY_JITTER_RATIO,
): number {
  const delaySec =
    typeof retryDelaySec === "number" &&
    Number.isFinite(retryDelaySec) &&
    retryDelaySec > 0
      ? retryDelaySec
      : 0;
  if (delaySec === 0) return 0;

  const effectiveAttempt =
    typeof attempt === "number" && Number.isFinite(attempt) && attempt >= 1
      ? Math.floor(attempt)
      : 1;
  const base = delaySec * 1000 * Math.pow(2, effectiveAttempt - 1);

  const safeRatio =
    typeof ratio === "number" && Number.isFinite(ratio) && ratio >= 0
      ? Math.min(ratio, 1)
      : RETRY_JITTER_RATIO;

  // random 理论上 ∈ [0,1)，但宿主环境可能注入越界值（某些 runtime/旧引擎
  // 可返回 1，mock 注入更不受控）——先夹取随机源再映射，保证输出严格落在
  // [base*(1-ratio), base*(1+ratio)] 闭区间内。
  const clampedRandom = Math.min(Math.max(random(), 0), 1);
  const factor = 1 + (clampedRandom * 2 - 1) * safeRatio;
  return Math.round(base * factor);
}
