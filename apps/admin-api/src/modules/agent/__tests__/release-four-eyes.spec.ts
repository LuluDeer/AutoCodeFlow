import { AppError } from "../../../common/errors/app-error";
import { UserRole } from "../../users/entities/user.entity";
import { AgentController } from "../agent.controller";
import type { AgentApproval } from "../entities/agent-approval.entity";
import type { AgentSession } from "../entities/agent-session.entity";
import {
  AgentApprovalsService,
  computeApprovalPolicyFingerprint,
} from "../runtime/agent-approvals.service";

/**
 * ADR-045：服务端强制四眼 + phrase 禁用发布审批单（最低级别：单测/内存替身）。
 *
 * 判据不是「代码里写了 if」，而是副作用：
 *   · grant 自批 ⇒ decide/queue 零调用、approval.status 仍 pending；
 *   · grant 主管 ⇒ decide 恰好一次、status granted；
 *   · phrase 发布单 ⇒ decideByPhrase 零调用、approval 未变；
 *   · 非发布单的既有配置四眼与 phrase 行为保持不变（控制组）。
 */

const SESSION = "11111111-1111-4111-8111-111111111111";
const KEY = "apr-11111111-1111-4111-8111-111111111111-cccccccccccccccc";

const applicant = { id: 1, username: "alice", role: UserRole.ADMIN } as never;
const supervisor = { id: 2, username: "bob", role: UserRole.ADMIN } as never;

const DEFAULT_POLICY = {
  writeRequiresApproval: false,
  dangerousRequiresApproval: true,
  allowDangerous: false,
  executableSourceGate: true,
};
const FP_DEFAULT = computeApprovalPolicyFingerprint(DEFAULT_POLICY);

function harness(
  options: {
    toolName?: string;
    createdBy?: string | null;
    status?: AgentApproval["status"];
    blockSelfApproval?: boolean;
  } = {},
) {
  const session = {
    id: SESSION,
    status: "waiting_input",
    totalSteps: 3,
    createdBy:
      options.createdBy === undefined ? "user:alice" : options.createdBy,
  } as Partial<AgentSession>;
  // 可变单据：decide/decideByPhrase 替身按真实语义就地推进状态，
  // 让「审批单未被改动」成为可断言的副作用而不是对 spy 的猜测。
  const approval = {
    approvalKey: KEY,
    sessionId: SESSION,
    toolName: options.toolName ?? "sop_publish",
    status: options.status ?? "pending",
  } as Partial<AgentApproval>;

  const sessions = {
    requireById: jest.fn(async () => session),
    findById: jest.fn(async () => session),
  };
  const approvals = {
    findByKey: jest.fn(async () => approval),
    decide: jest.fn(
      async (
        _key: string,
        decision: AgentApproval["status"],
        decidedBy: string,
      ) => {
        approval.status = decision;
        approval.decidedBy = decidedBy;
        return approval;
      },
    ),
    // true ⇒ grant 成功后不再入队，避免本 spec 涉及 resume 行为。
    hasPendingForSession: jest.fn(async () => true),
    decideByPhrase: jest.fn(async () => {
      approval.status = "granted";
      return approval;
    }),
  };
  const queue = { add: jest.fn(async () => undefined) };
  const config = {
    get: jest.fn((key: string) =>
      key === "agent.policy.blockSelfApproval"
        ? (options.blockSelfApproval ?? false)
        : undefined,
    ),
  };
  const ctl = new AgentController(
    sessions as never,
    { resolveBudget: jest.fn() } as never,
    approvals as unknown as AgentApprovalsService,
    queue as never,
    config as never,
  );
  return { ctl, approval, approvals, sessions, queue };
}

async function capture(promise: Promise<unknown>): Promise<AppError | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    return err as AppError;
  }
}

describe("ADR-045 · grant 路径的 sop_publish 服务端强制四眼", () => {
  it("申请人自己 approve（配置开关关闭）⇒ 403/SELF_DENIED，decide 零调用且单据仍 pending", async () => {
    const h = harness({ blockSelfApproval: false });
    const err = await capture(h.ctl.grantApproval(SESSION, KEY, applicant));

    expect(err?.errorCode).toBe("AGENT_APPROVAL_SELF_DENIED");
    expect(err?.getStatus()).toBe(403);
    expect(h.approvals.decide).not.toHaveBeenCalled();
    expect(h.queue.add).not.toHaveBeenCalled();
    expect(h.approval.status).toBe("pending");
  });

  it("主管（不同 username）approve ⇒ decide 恰好一次，单据落 granted", async () => {
    const h = harness({ blockSelfApproval: false });
    const out = await h.ctl.grantApproval(SESSION, KEY, supervisor);

    expect(out).toMatchObject({ ok: true });
    expect(h.approvals.decide).toHaveBeenCalledTimes(1);
    expect(h.approvals.decide).toHaveBeenCalledWith(KEY, "granted", "bob");
    expect(h.approval.status).toBe("granted");
    expect(h.approval.decidedBy).toBe("bob");
  });

  it("控制组：非 sop_publish + 开关关闭 ⇒ 自批仍放行（既有配置四眼逐字不变）", async () => {
    const h = harness({ toolName: "update_task", blockSelfApproval: false });
    const out = await h.ctl.grantApproval(SESSION, KEY, applicant);

    expect(out).toMatchObject({ ok: true });
    expect(h.approvals.decide).toHaveBeenCalledTimes(1);
    expect(h.approval.status).toBe("granted");
  });

  it("控制组：非 sop_publish + 开关开启 ⇒ 自批仍被既有配置四眼拦住", async () => {
    const h = harness({ toolName: "update_task", blockSelfApproval: true });
    const err = await capture(h.ctl.grantApproval(SESSION, KEY, applicant));

    expect(err?.errorCode).toBe("AGENT_APPROVAL_SELF_DENIED");
    expect(h.approvals.decide).not.toHaveBeenCalled();
    expect(h.approval.status).toBe("pending");
  });
});

describe("ADR-045 · phrase 路径禁用 sop_publish 发布审批单", () => {
  it("发布审批单的 approvalKey ⇒ 显式失败，decideByPhrase 零调用且单据未变", async () => {
    const h = harness();
    const err = await capture(
      h.ctl.decideApprovalByPhrase(
        SESSION,
        KEY,
        { phrase: "allow" },
        supervisor,
      ),
    );

    expect(err?.errorCode).toBe("VALIDATION_FAILED");
    expect(err?.message).toContain("发布审批必须用 grant 端点、不支持短语");
    expect(h.approvals.decideByPhrase).not.toHaveBeenCalled();
    expect(h.approvals.decide).not.toHaveBeenCalled();
    expect(h.approval.status).toBe("pending");
    expect(h.approval.decidedBy).toBeUndefined();
  });

  it("控制组：非 sop_publish 的 phrase 审批行为保持不变（服务端指纹 + 登录署名）", async () => {
    const h = harness({ toolName: "update_task" });
    const out = await h.ctl.decideApprovalByPhrase(
      SESSION,
      KEY,
      { phrase: "allow" },
      supervisor,
    );

    expect(out).toMatchObject({ ok: true });
    expect(h.approvals.decideByPhrase).toHaveBeenCalledTimes(1);
    expect(h.approvals.decideByPhrase).toHaveBeenCalledWith(
      KEY,
      "allow",
      "bob",
      FP_DEFAULT,
    );
    expect(h.approval.status).toBe("granted");
  });
});
