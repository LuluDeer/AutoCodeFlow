/**
 * 审批拒绝后的会话自动恢复决策（W1-S2）。
 *
 * 主控批准的保守语义：deny 之后仅在「会话仍在 waiting_input 且没有任何剩余
 * pending 审批单」时才自动 resume，理由用 `resume:approval_denied`。有剩余
 * 审批单说明还有别的门要过，此时 resume 只会让模型在半开状态下继续推理；
 * 其他状态（running / 终态）一律不动。granted 路径不用本 helper，语义原样。
 */
import type { AgentSession } from "../entities/agent-session.entity";
import type { AgentSessionService } from "./agent-session.service";
import type { AgentApprovalsService } from "./agent-approvals.service";

/**
 * @returns 是否真的入队了恢复 job（写进响应 `resumed`）。
 * 重读/审批查询失败一律 fail-closed（不 resume），但 Aber 不抛出打断 deny 主链。
 */
export async function maybeResumeAfterDeny(
  sessions: Pick<AgentSessionService, "findById">,
  approvals: Pick<AgentApprovalsService, "hasPendingForSession">,
  enqueue: (session: AgentSession, reason: "resume:approval_denied") => Promise<unknown>,
  sessionId: string,
  sessionSnapshot: AgentSession,
): Promise<boolean> {
  let session = sessionSnapshot;
  try {
    const reread = await sessions.findById(sessionId);
    if (reread) session = reread;
    if (session.status !== "waiting_input") return false;
    if (await approvals.hasPendingForSession(sessionId)) return false;
    await enqueue(session, "resume:approval_denied");
    return true;
  } catch {
    // deny 已落库、台账已 settle——恢复是旁路，失败只记 false，不回滚决定。
    return false;
  }
}
