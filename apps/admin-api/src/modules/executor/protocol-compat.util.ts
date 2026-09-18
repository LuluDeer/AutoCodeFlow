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
