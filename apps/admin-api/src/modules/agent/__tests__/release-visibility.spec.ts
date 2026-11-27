import { AuditService } from "../../audit/audit.service";
import { AgentController } from "../agent.controller";
import {
  SOP_RELEASE_AUDIT_ACTIONS,
  SOP_RELEASE_RETRY_HINT,
} from "../runtime/release-outcome.audit";
import {
  RELEASE_PUBLISHED_BY,
  RELEASE_TOOL_NAME,
  ReleaseApprovalService,
} from "../../workbench/release-approval.service";

/**
 * ADR-045 发布链 warn-only 缺口反证：
 * 主管 grant 之后「系统代理发布」失败/抛错/成功都必须留审计；
 * 非发布审批零回归；审计 detail 不带任何密钥样式字段或异常文案。
 */
const KEY = "apr-s-1-sop-publish";

interface ReleaseOutcome {
  published: boolean;
  reason?: string;
}

function harness(options: {
  outcome?: ReleaseOutcome;
  releaseError?: Error;
  auditError?: Error;
  toolName?: string;
  decision?: "granted" | "denied";
  releaseAvailable?: boolean;
  auditAvailable?: boolean;
}) {
  const toolName = options.toolName ?? RELEASE_TOOL_NAME;
  const decision = options.decision ?? "granted";
  const session = {
    id: "s-1",
    status: "running",
    totalSteps: 0,
    createdBy: "user:bob",
  };
  const approval = {
    approvalKey: KEY,
    sessionId: "s-1",
    toolName,
    status: "pending",
  };
  const approveRow = {
    ...approval,
    status: decision,
    decidedBy: "alice",
    decidedAt: new Date(),
  };

  const sessions = {
    requireById: jest.fn(async () => session),
    findById: jest.fn(async () => session),
    hasPendingForSession: jest.fn(async () => false),
    settleToolCallByApprovalId: jest.fn(async () => 1),
    findEventSeqByRef: jest.fn(async () => null),
    listToolCalls: jest.fn(async () => []),
    tryAppendEvent: jest.fn(async () => 1),
  };
  const approvals = {
    findByKey: jest.fn(async () => approval),
    decide: jest.fn(async () => approveRow),
    hasPendingForSession: jest.fn(async () => false),
  };
  const queue = { add: jest.fn(async () => undefined) };
  const audit = { log: jest.fn(async () => undefined) };
  if (options.auditError) audit.log.mockRejectedValueOnce(options.auditError);
  const release = {
    releaseByApprovalKey: jest.fn(async () => {
      if (options.releaseError) throw options.releaseError;
      return options.outcome ?? ({ published: true } satisfies ReleaseOutcome);
    }),
  };
  const moduleRef = {
    get: jest.fn((token: unknown) => {
      if (token === ReleaseApprovalService) {
        return options.releaseAvailable === false ? undefined : release;
      }
      if (token === AuditService) {
        return options.auditAvailable === false ? undefined : audit;
      }
      return undefined;
    }),
  };

  const ctl = new AgentController(
    sessions as never,
    { resolveBudget: jest.fn() } as never,
    approvals as never,
    queue as never,
    { get: () => false } as never,
    // backlog … confirmation：既有 spec 的定位参数位，本用例全缺席。
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    moduleRef as never,
  );
  return { ctl, sessions, approvals, queue, audit, release, moduleRef };
}

const admin = { id: 1, username: "alice", role: "admin" } as never;

function auditPayload(audit: { log: jest.Mock }): Record<string, any> {
  expect(audit.log).toHaveBeenCalledTimes(1);
  return audit.log.mock.calls[0][0];
}

function assertNoSecrets(detail: unknown): void {
  expect(JSON.stringify(detail)).not.toMatch(
    /api[-_]?key|token|secret|password|credential/i,
  );
}

describe("ADR-045 · 发布结果审计可见性", () => {
  it("① granted + sop_publish + published:false ⇒ 一条失败审计，detail 带原因与重试入口", async () => {
    const h = harness({
      outcome: { published: false, reason: "content_changed" },
    });

    const result = await h.ctl.grantApproval("s-1", KEY, admin);

    expect(result).toMatchObject({
      ok: true,
      approval: { status: "granted", decidedBy: "alice" },
    });
    expect(h.release.releaseByApprovalKey).toHaveBeenCalledWith(KEY, null);
    const payload = auditPayload(h.audit);
    expect(payload.action).toBe(SOP_RELEASE_AUDIT_ACTIONS.failed);
    expect(payload.result).toBe("failure");
    expect(payload).toMatchObject({
      resource: "agent_approval",
      resourceId: KEY,
      detail: {
        approvalKey: KEY,
        sessionId: "s-1",
        toolName: RELEASE_TOOL_NAME,
        published: false,
        reason: "content_changed",
      },
    });
    expect(payload.detail.retry).toBe(SOP_RELEASE_RETRY_HINT);
    expect(payload.detail.retry).toContain("重新提交发布审批");
    assertNoSecrets(payload.detail);
  });

  it("② releaseByApprovalKey 抛错 ⇒ 仍落审计、批准不被吞掉、异常文案不进 detail", async () => {
    const h = harness({
      releaseError: new Error("boom apiKey=super-secret token=abc"),
    });

    const result = await h.ctl.grantApproval("s-1", KEY, admin);

    expect(result).toMatchObject({ ok: true, approval: { status: "granted" } });
    expect(h.approvals.decide).toHaveBeenCalledTimes(1);
    const payload = auditPayload(h.audit);
    expect(payload.action).toBe(SOP_RELEASE_AUDIT_ACTIONS.failed);
    expect(payload.detail.reason).toBe("publish_failed");
    assertNoSecrets(payload.detail);
  });

  it("③ 发布成功 ⇒ 一条 release_succeeded 审计（含 publishedBy）", async () => {
    const h = harness({ outcome: { published: true } });

    await h.ctl.grantApproval("s-1", KEY, admin);

    const payload = auditPayload(h.audit);
    expect(payload.action).toBe(SOP_RELEASE_AUDIT_ACTIONS.succeeded);
    expect(payload.result).toBe("success");
    expect(payload).toMatchObject({
      resourceId: KEY,
      detail: {
        approvalKey: KEY,
        sessionId: "s-1",
        toolName: RELEASE_TOOL_NAME,
        published: true,
        publishedBy: RELEASE_PUBLISHED_BY,
      },
    });
    assertNoSecrets(payload.detail);
  });

  it("④ 非发布审批（granted + update_task）⇒ 零新审计、零发布调用", async () => {
    const h = harness({ toolName: "update_task" });

    const result = await h.ctl.grantApproval("s-1", KEY, admin);

    expect(result.ok).toBe(true);
    expect(h.release.releaseByApprovalKey).not.toHaveBeenCalled();
    expect(h.audit.log).not.toHaveBeenCalled();
    expect(h.moduleRef.get).not.toHaveBeenCalled();
  });

  it("⑤ 审计写入失败只 warn，不改批准语义", async () => {
    const h = harness({
      outcome: { published: false, reason: "publish_failed" },
      auditError: new Error("audit down"),
    });
    const warn = jest
      .spyOn((h.ctl as any).logger, "warn")
      .mockImplementation(() => undefined);

    const result = await h.ctl.grantApproval("s-1", KEY, admin);
    await new Promise((resolve) => setImmediate(resolve));

    expect(result).toMatchObject({ ok: true, approval: { status: "granted" } });
    expect(h.audit.log).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("sop_publish audit append failed"),
    );
    warn.mockRestore();
  });

  it("⑥ 发布依赖缺席 ⇒ 仍按 published:false 落失败审计，不咽掉批准", async () => {
    const h = harness({ releaseAvailable: false });

    const result = await h.ctl.grantApproval("s-1", KEY, admin);

    expect(result.ok).toBe(true);
    const payload = auditPayload(h.audit);
    expect(payload.action).toBe(SOP_RELEASE_AUDIT_ACTIONS.failed);
    expect(payload.detail.reason).toBe("dependency_unavailable");
    assertNoSecrets(payload.detail);
  });
});
