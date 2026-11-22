/**
 * 「等待审批」waitingFor 文本的**唯一事实源**（PM 决策 4，R321 §7.4）。
 *
 * 三处共同消费这一份定义，避免前缀漂移：
 *   · tool-executor 的 `markWaiting(sessionId, waitingForApproval(approvalKey))`；
 *   · `AgentApprovalWakeupService.probe` 的前缀判据；
 *   · sweep（`sweepAbandonedWaitingInput`）对审批等待会话的识别。
 *
 * 不要把 `等待审批` 字面量复制到以上任何一处——本文件是唯一的落点。
 */

/** `waitingFor` 中「等待审批」段的前缀（不含后面的空格与 approvalKey）。 */
export const WAITING_FOR_APPROVAL_PREFIX = "等待审批";

/** 构造审批挂起原因：`等待审批 ${approvalKey}`。 */
export function waitingForApproval(approvalKey: string): string {
  return `${WAITING_FOR_APPROVAL_PREFIX} ${approvalKey}`;
}
