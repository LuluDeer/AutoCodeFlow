/**
 * 审批拒绝后的会话自动恢复决策（W1-S2）。
 *
 * 主控批准的保守语义：deny 之后仅在「会话仍在 waiting_input 且没有任何剩余
 * pending 审批单」时才自动 resume，理由用 `resume:approval_denied`。有剩余
 * 审批单说明还有别的门要过，此时 resume 只会让模型在半开状态下继续推理；
 * 其他状态（running / 终态）一律不动。granted 路径不用本 helper，语义原样。
 *
 * 失败不再被 `catch` 全吞成 false：任何重读 / 审批查询 / 入队异常都转成
 * `{ resumed: false, reason }` 返回，由 controller 把 reason 透出到响应
 * （`resumeReason`）。异常仍不抛出——deny 已落库、台账已 settle，恢复是旁路，
 * 不能因为旁路失败回滚人工决定或把 200 打成 500。
 */
import type { AgentSession } from "../entities/agent-session.entity";
import type { AgentSessionService } from "./agent-session.service";
import type { AgentApprovalsService } from "./agent-approvals.service";

export interface DenyResumeResult {
  /** 是否真的入队了恢复 job（写进响应 `resumed`）。 */
  resumed: boolean;
  /** 未恢复的具体原因；成功恢复时省略。 */
  reason?: string;
}

export async function maybeResumeAfterDeny(
  sessions: Pick<AgentSessionService, "findById">,
  approvals: Pick<AgentApprovalsService, "hasPendingForSession">,
  enqueue: (
    session: AgentSession,
    reason: "resume:approval_denied",
  ) => Promise<unknown>,
  sessionId: string,
  sessionSnapshot: AgentSession,
): Promise<DenyResumeResult> {
  let session = sessionSnapshot;
  try {
    const reread = await sessions.findById(sessionId);
    if (reread) session = reread;
    if (session.status !== "waiting_input") {
      return {
        resumed: false,
        reason: `会话不在 waiting_input（${session.status}），未自动恢复`,
      };
    }
    if (await approvals.hasPendingForSession(sessionId)) {
      return { resumed: false, reason: "仍有未处置的审批单，未自动恢复" };
    }
    await enqueue(session, "resume:approval_denied");
    return { resumed: true };
  } catch (err: unknown) {
    // 异常不抛出，但必须带原因回传：此前「catch 全吞 → false」让前端把
    // 「入队失败」和「按设计不恢复」看成同一件事，运维无从定位。
    const msg = err instanceof Error ? err.message : String(err);
    return { resumed: false, reason: `deny 后自动恢复失败：${msg}` };
  }
}
