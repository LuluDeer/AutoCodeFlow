/**
 * 成本归责第一步：按 sessionId 取真实 token 的「诚实采样端口」契约（DTO）。
 *
 * 本文件只声明形状与中文描述，不做任何取值、估算或系数换算：
 * - 无关联 / 零样本 / 缺样本一律以 null 标缺，绝不编造 0 或估算值；
 * - currencyValue 在所有路径恒为 null（本切片不产出金额、单价、RU 或相对预算）；
 * - sessionId 原值回显，不改写、不补前缀、不做命名空间推断。
 *
 * 生成物说明：本 DTO 的中文描述为手写原文，未跑 swagger 导出（导出由主控统一执行）。
 */

/** 与 scripts/agent-context-token-audit.mjs 同源同值（本地常量，不 import 脚本避免副作用）。 */
export const MIN_SAMPLES = 30;

/** 固定文案：禁止出现金额、单价或数字估算。 */
export const TOKEN_SAMPLE_NOTE =
  "无可用 token 样本时标缺、不折算金额；仅 provider 实测 usage 计入样本，0 不是成本。";

/** 采样结论状态。 */
export type TokenSampleStatus =
  "ok" | "no_link" | "zero_sample" | "pruned" | "insufficient";

/** 缺样本原因码；「健康 ok」不编造原因码，置 null。 */
export type TokenSampleReasonCode =
  | "NO_SESSION_ID"
  | "SOP_ID_NAMESPACE"
  | "NO_AGENT_SESSION_ROW"
  | "ALL_STEPS_ZERO"
  | "STEPS_PRUNED"
  | "BELOW_MIN_SAMPLES";

/** token 口径来源；无可用样本时为 none。 */
export type TokenSampleBasis =
  "agent_sessions.totals" | "agent_steps.provider_usage" | "none";

/**
 * 单会话诚实采样视图。
 *
 * 字段语义：
 * - sessionId：原值回显（含空串 / SOP id），不做任何改写；
 * - resolvedAgentSessionId：命中 agent_sessions 的行 id，未命中恒 null；
 * - status：ok / no_link / zero_sample / pruned / insufficient；
 * - reasonCode：缺样本原因码，健康 ok 为 null；
 * - note：固定中文文案，禁止出现金额、单价、数字估算；
 * - tokensIn / tokensOut：可用真实 token 计数，缺样本恒 null（不是 0）；
 * - measuredStepCount：provider 实测且 token 为正的步数，无样本为 0；
 * - basis：token 取值口径，none 表示未取到可用样本；
 * - currencyValue：恒 null，本端口不产出金额。
 */
export interface TokenSampleView {
  readonly sessionId: string | null;
  readonly resolvedAgentSessionId: string | null;
  readonly status: TokenSampleStatus;
  readonly reasonCode: TokenSampleReasonCode | null;
  readonly note: string;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly measuredStepCount: number | null;
  readonly basis: TokenSampleBasis;
  readonly currencyValue: null;
}
