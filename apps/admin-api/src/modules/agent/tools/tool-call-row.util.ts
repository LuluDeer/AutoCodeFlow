/**
 * R99（ADR-031 步骤 4）：**台账行的纯构造器** —— 无副作用、无 db、无审批状态。
 *
 * ## 为什么要有这个文件
 *
 * `execute`（当时 578 行）里同一形状的「不执行」落库块重复了 **8 处**（`status: "denied"`
 * 各 ~10–13 行），每处都手写 `sessionId / stepId / toolCallId / toolName / tier / args /
 * status / approvalId / errorMessage` 九个字段。字段是一样的，只有 2–3 个值不同。
 *
 * 本模块把它们收成**纯函数构造器**：
 *   `deniedRow(ids, tier, args, errorMessage, approvalId?)` → `RecordToolCallInput`
 *   `awaitingRow(ids, tier, args, approvalId, errorMessage)` → `RecordToolCallInput`
 *   `tierOf(toolName)` → 该工具的分级（找不到时回落 `read`）
 *
 * ## 边界（Lead 裁决：事务边界不跨函数）
 *
 * ⚠ 本模块**只构造对象**：不调用 `persist`、不碰 sessions/approvals、不做 IO。
 * 「查审批 → 三分支 → 闸门 → 领取审批单」那条链**仍完整留在 `execute` 内**——
 * 本模块只负责把「这一行长什么样」算出来，行**写不写、往哪写**由 `execute` 的
 * `persist` 闭包决定（R60/R61 的「单判据 + 结清」语义因此不受影响）。
 *
 * 纯函数 ⇒ 可以直接单测（见 `__tests__/tool-call-row.util.spec.ts`）。
 */
import { ALL_AGENT_TOOL_SPECS } from "./tool-registry";
import type { RecordToolCallInput } from "../runtime/agent-session.service";

/** 一次调用的**身份四元组**（整条调用期间不变）。 */
export interface ToolCallRowIds {
  sessionId: string;
  stepId: string | null;
  toolCallId: string;
  toolName: string;
}

/** 台账行的分级取值类型（从 `RecordToolCallInput` 取，避免再导一份枚举）。 */
type RowTier = RecordToolCallInput["tier"];

/**
 * 该工具的分级；工具不在注册表里时回落 `read`（与既有行为逐字一致）。
 *
 * 纯函数：只读静态注册表。
 */
export function tierOf(toolName: string): RowTier {
  return ALL_AGENT_TOOL_SPECS.find((s) => s.name === toolName)?.tier ?? "read";
}

/**
 * 「本次调用未执行」的拒绝行（`status: "denied"`）。
 *
 * `approvalId` 仅在**本次拒绝可归因到某张审批单**时给（如「已被人拒」「一张单只放行一次」
 * 「领取失败」）——否则为 `null`（既有行为：不写 approvalId）。
 */
export function deniedRow(
  ids: ToolCallRowIds,
  tier: RowTier,
  args: Record<string, unknown> | null,
  errorMessage: string,
  approvalId: string | null = null,
): RecordToolCallInput {
  return {
    sessionId: ids.sessionId,
    stepId: ids.stepId,
    toolCallId: ids.toolCallId,
    toolName: ids.toolName,
    tier,
    args,
    status: "denied",
    ...(approvalId === null ? {} : { approvalId }),
    errorMessage,
  };
}

/**
 * 「已挂起等待人工审批」的行（`status: "awaiting_approval"`）。
 *
 * 与 `deniedRow` 分开命名（而不是加 `status` 参数）：两处的必填字段集不同
 * （本函数 `approvalId` 必填），分成两个函数能让「调用方漏传单号」变成编译错误。
 */
export function awaitingRow(
  ids: ToolCallRowIds,
  tier: RowTier,
  args: Record<string, unknown> | null,
  approvalId: string,
  errorMessage: string,
): RecordToolCallInput {
  return {
    sessionId: ids.sessionId,
    stepId: ids.stepId,
    toolCallId: ids.toolCallId,
    toolName: ids.toolName,
    tier,
    args,
    status: "awaiting_approval",
    approvalId,
    errorMessage,
  };
}
