/**
 * Executor lifecycle audit（P2-5）：执行器心跳"活性"判定的前端共享口径。
 *
 * 背景：后端 markStaleOffline() 用 `heartbeatInterval`（默认 30s）×
 * `heartbeatTimeoutMultiplier`（默认 3）= **90s** 作为 ONLINE→OFFLINE 的判死
 * 阈值；前端此前在列表页/详情页/卡片视图各自硬编码了 5 分钟与 2 分钟，于是
 * 后端判死后的最长约 3.5 分钟里，UI 同时显示「离线」徽章与绿色「刚刚」。
 *
 * 事实源：GET /executors/runtime-config 返回的 `heartbeatTimeoutMs`。
 * 该端点不可用时用下面的保守回退（与后端**默认值**对齐；配置被调大时只是
 * 提前标黄，不会把真正离线的节点涂绿）。
 */

/** runtime-config 拉取失败时的回退判死阈值 = 后端默认 30000ms × 3。 */
export const HEARTBEAT_TIMEOUT_FALLBACK_MS = 90_000;

/**
 * 列表页「有执行器已长期离线」横幅的产品提示阈值。它**不是**判死阈值
 * （判死以后端 heartbeatTimeoutMs 为准），刻意独立命名，避免下一位读者
 * 把两个语义合并回同一个常量。
 */
export const LONG_OFFLINE_BANNER_MS = 5 * 60_000;

/** 心跳列三档着色（与后端判死阈值同源）。 */
export type HeartbeatFreshness = 'fresh' | 'recent' | 'old';

/**
 * @param diffMs       now - lastHeartbeat（毫秒）
 * @param timeoutMs    后端有效判死阈值（runtime-config.heartbeatTimeoutMs）
 */
export function heartbeatFreshness(
  diffMs: number,
  timeoutMs: number,
): HeartbeatFreshness {
  // 判死窗口内 = 新鲜（绿）；超过判死阈值但不到 10 分钟 = 关注（黄）；
  // 更久 = 直接给绝对时间（红）。
  if (diffMs < timeoutMs) return 'fresh';
  if (diffMs < 10 * 60_000) return 'recent';
  return 'old';
}

/** 详情页数据新鲜度告警：心跳老于后端有效判死阈值即视为陈旧。 */
export function isHeartbeatStale(
  lastHeartbeatMs: number,
  nowMs: number,
  timeoutMs: number,
): boolean {
  return nowMs - lastHeartbeatMs > timeoutMs;
}
