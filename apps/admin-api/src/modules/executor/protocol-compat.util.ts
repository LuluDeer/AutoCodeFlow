/**
 * PROTOCOL-VER（B-3/U-2，中台↔执行器深度审查）：协议版本兼容性判定。
 *
 * 与 `version-compare.util.ts`（实现版本 EXECUTOR_MIN_VERSION 门禁）**解耦**：
 * - 实现版本门禁：低于下限 **403 拒绝注册**（能力缺失，例如没实现 interpreters
 *   上报的旧执行器）；
 * - 协议版本兼容：低于下限只 **warn + 按旧协议兜底**，**不拒绝注册**（兼容性
 *   红线：旧协议执行器不得因缺新字段被剔除，见 protocol.json `versioning` 段）。
 *
 * `PROTOCOL_SUPPORTED_MIN` 必须与协议单一事实源
 * `packages/executor-protocol/protocol.json` 的 `supportedMinProtocolVersion`
 * 保持同值（1）；协议演进时先改协议文件再同步此处。
 */
export const PROTOCOL_SUPPORTED_MIN = 1;

/**
 * ARCH-33（ADR-016）：**控制面命令通道**的最低协议版本。
 *
 * 协议 v2 新增 pull 响应的可选 `commands` 数组与结果上报端点。低于 v2 的
 * 执行器（含所有 v1 与未上报的存量执行器）会**忽略** `commands` 字段——若
 * 中台照发，命令就静默消失了：部署行停在 DEPLOYING 直到 cron sweep 判失败，
 * stop/uninstall 这类 best-effort 命令连痕迹都没有。
 *
 * 因此命令下发必须过这道门禁：`protocolVersion < 2` → 回退 push（对 NAT 执行
 * 器会失败，但那是**可见的**失败，且与今日行为一致；静默丢操作不可接受）。
 *
 * 与 `PROTOCOL_SUPPORTED_MIN` 的关系：后者是「不得剔除」的兼容性红线（保持
 * 1，旧执行器照常注册），本常量是「新增能力可用性」的门槛。两者语义正交。
 */
export const PROTOCOL_CONTROL_PLANE_MIN = 2;

/**
 * 兼容性判定：未上报（null）的存量旧执行器按基线协议 1 兜底（兼容），
 * 上报且低于下限的视为不兼容（不拒绝，仅 warn）。
 */
export function isProtocolCompliant(
  protocolVersion: number | null | undefined,
  supportedMin: number = PROTOCOL_SUPPORTED_MIN,
): boolean {
  if (protocolVersion === null || protocolVersion === undefined) return true;
  return Number.isInteger(protocolVersion) && protocolVersion >= supportedMin;
}

/**
 * ARCH-33: 该执行器是否支持控制面命令通道（协议 >= 2）。
 *
 * 未上报（null/undefined）= 存量旧执行器 → **不支持**。这与
 * `isProtocolCompliant` 的兜底方向**刻意相反**：那里兜底为「兼容」（不剔除
 * 旧执行器），这里兜底为「不支持」（不向不认识的执行器发新语义字段）。
 */
export function supportsControlPlane(
  protocolVersion: number | null | undefined,
): boolean {
  if (protocolVersion === null || protocolVersion === undefined) return false;
  return (
    Number.isInteger(protocolVersion) &&
    protocolVersion >= PROTOCOL_CONTROL_PLANE_MIN
  );
}
