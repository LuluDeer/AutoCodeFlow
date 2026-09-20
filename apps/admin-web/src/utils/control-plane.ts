/**
 * ARCH-33（ADR-016）：pull 控制面可用性判定。
 *
 * ## 为什么需要这个判据
 *
 * UI-18 时代的判据是「`dispatchMode === 'pull'` → 禁用配置热更新」。当时的
 * 理由是硬事实：reload-config 是 admin→执行器的**入站 POST**，而 pull 执行器
 * （ARCH-32，NAT 内）零入站可达，点了必然超时。
 *
 * ADR-016 把控制面也搬上 pull 通道后，那条理由对协议 v2 执行器**不再成立**
 * ——它们能正常热更新。但判据不能简单删掉，因为对 v1 及未上报版本的 pull
 * 执行器**仍然成立**，且理由更强了：
 *
 * - v1 执行器不认识 pull 响应里的 `commands` 字段，会**静默忽略**；
 * - 中台发出后只能看到「已投递」，会把静默忽略误判成投递成功。
 *
 * 也就是说 v1 pull 执行器的问题从「可见的入站失败」变成了「静默丢操作」——
 * 前者用户能看到报错，后者不能。所以这批必须继续禁用。
 *
 * 判据必须是「pull **且** 协议 < 2」这个合取，而不是其中任一项：
 * - 只看 pull → 误伤 v2（新能力白做）；
 * - 只看协议 → 误伤 push 的 v1 执行器（它们走 HTTP，本来就能热更新）。
 */

/** 控制面命令通道所需的最低协议版本（与 admin-api PROTOCOL_CONTROL_PLANE_MIN 同值）。 */
export const CONTROL_PLANE_MIN_PROTOCOL = 2;

interface ControlPlaneTarget {
  dispatchMode?: 'push' | 'pull';
  protocolVersion?: number | null;
}

/**
 * 该执行器的控制面（配置热更新等）是否**不可用**。
 *
 * 返回 true 的执行器必须从「推送配置」类操作中剔除。
 *
 * 兜底方向：`protocolVersion` 缺失（null/undefined）= 存量旧执行器 →
 * **不可用**。这与 `versionCompliant` 的兜底方向刻意相反——那个是「不得剔除
 * 旧执行器」的兼容性红线（缺省 true），这个是「新增能力可用性」门槛
 * （缺省 false）。抄错方向会让全部存量执行器被误判为可用，进而静默丢命令。
 */
export function isControlPlaneUnavailable(ex: ControlPlaneTarget): boolean {
  if (ex.dispatchMode !== 'pull') return false; // push 执行器走 HTTP，照旧可用
  const v = ex.protocolVersion;
  if (v === null || v === undefined) return true; // 未上报 = v1 = 不认识 commands
  return !Number.isInteger(v) || v < CONTROL_PLANE_MIN_PROTOCOL;
}

/** 该执行器的控制面是否可用（`isControlPlaneUnavailable` 的取反，便于读）。 */
export function isControlPlaneAvailable(ex: ControlPlaneTarget): boolean {
  return !isControlPlaneUnavailable(ex);
}
