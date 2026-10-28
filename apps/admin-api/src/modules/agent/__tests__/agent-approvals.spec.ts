import { ConflictException, NotFoundException } from "@nestjs/common";

import { AgentController } from "../agent.controller";
import type { AgentApproval } from "../entities/agent-approval.entity";
import type { AgentSession } from "../entities/agent-session.entity";
import { AgentApprovalsService } from "../runtime/agent-approvals.service";

/**
 * A1 审批闭环（实施轮 #12）：grant/deny 端点 + AgentApprovalsService 的
 * 状态机。重点钉三件事：
 *   ① 处置是条件写——并发处置后到者收 409（结论唯一，ADR-026 精神）；
 *   ② 归属校验——审批单不属于 URL 里的会话就拒绝；
 *   ③ grant 后只有挂起会话被 resume（reason=resume:approval），其余状态不动。
 */
function harness(options: {
  session: Partial<AgentSession> | null;
  approval?: Partial<AgentApproval> | null;
  decideResult?: Partial<AgentApproval> | null;
  /** 处置后是否仍有其它待审批单（grant 的恢复前置）。 */
  hasPending?: boolean;
}) {
  const approvals = {
    findByKey: jest.fn(async () => options.approval ?? null),
    decide: jest.fn(async () => options.decideResult ?? null),
    listForSession: jest.fn(async () => []),
    request: jest.fn(),
    hasPendingForSession: jest.fn(async () => options.hasPending ?? false),
  };
  const sessions = {
    requireById: jest.fn(async () => {
      // 对齐真实 requireById 的语义：找不到就抛 AppError（404 原型映射）。
      if (!options.session) throw new NotFoundException();
      return options.session;
    }),
    create: jest.fn(),
    list: jest.fn(),
    budget: jest.fn(),
    settleToolCallByApprovalId: jest.fn(async () => 1),
  };
  const queue = {
    add: jest.fn(async () => undefined),
  } as unknown as QueueLike;
  const ctl = new AgentController(
    sessions as never,
    { resolveBudget: jest.fn() } as never,
    approvals as unknown as AgentApprovalsService,
    queue as never,
  );
  return { ctl, approvals, sessions, queue };
}
type QueueLike = {
  add: (name: string, data: unknown, opts?: unknown) => Promise<void>;
};

const admin = { id: 1, username: "alice", role: "admin" } as never;

const pendingApproval = {
  approvalKey: "apr-s-1-1700000000000",
  sessionId: "s-1",
  toolName: "update_task",
  status: "pending",
} as Partial<AgentApproval>;

const grantedRow = {
  ...pendingApproval,
  status: "granted",
  decidedBy: "alice",
  decidedAt: new Date(),
} as Partial<AgentApproval>;

describe("AgentApprovalsService · decide 条件写（结论唯一）", () => {
  it("pending → granted：条件 UPDATE 命中后返回新行", async () => {
    const rows: Array<Partial<AgentApproval>> = [{ ...pendingApproval }];
    const repo = {
      create: jest.fn((x) => x),
      save: jest.fn(async (x) => x),
      update: jest.fn(async () => ({ affected: 1 })),
      findOne: jest.fn(async () => grantedRow),
      find: jest.fn(async () => []),
    };
    const svc = new AgentApprovalsService(repo as never);
    const out = await svc.decide(
      pendingApproval.approvalKey!,
      "granted",
      "alice",
    );
    expect(out?.status).toBe("granted");
    expect(repo.update).toHaveBeenCalledWith(
      { approvalKey: pendingApproval.approvalKey, status: expect.anything() },
      expect.objectContaining({ status: "granted", decidedBy: "alice" }),
    );
    void rows;
  });

  it("并发处置：条件写命中 0 行 → 读回已是终态 → 409（APPROVAL_ALREADY_DECIDED）", async () => {
    const repo = {
      update: jest.fn(async () => ({ affected: 0 })),
      findOne: jest.fn(async () => ({ ...pendingApproval, status: "granted" })),
      find: jest.fn(async () => []),
    };
    const svc = new AgentApprovalsService(repo as never);
    await expect(
      svc.decide(pendingApproval.approvalKey!, "denied", "bob"),
    ).rejects.toThrow(ConflictException);
  });

  it("request 幂等：唯一约束冲突（23505）返回既有单，不抛", async () => {
    const conflict = Object.assign(new Error("duplicate key"), {
      code: "23505",
    });
    const repo = {
      create: jest.fn((x) => x),
      save: jest.fn(async () => {
        throw conflict;
      }),
      findOne: jest.fn(async () => ({ ...pendingApproval })),
      find: jest.fn(async () => []),
    };
    const svc = new AgentApprovalsService(repo as never);
    await expect(
      svc.request({
        approvalKey: pendingApproval.approvalKey!,
        sessionId: "s-1",
        toolName: "update_task",
        reason: "r",
      }),
    ).resolves.toMatchObject({ approvalKey: pendingApproval.approvalKey });
  });
});

describe("AgentController · grant/deny（A1 审批闭环）", () => {
  it("grant：单不存在 → 404", async () => {
    const h = harness({
      session: { id: "s-1", status: "waiting_input" } as Partial<AgentSession>,
    });
    await expect(
      (
        h.ctl as unknown as {
          grantApproval: (a: string, b: string, c: unknown) => Promise<unknown>;
        }
      ).grantApproval("s-1", "apr-missing", admin),
    ).rejects.toThrow(NotFoundException);
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it("归属校验：审批单属于别的会话 → 409（SESSION_MISMATCH）", async () => {
    const h = harness({
      session: { id: "s-1", status: "waiting_input" } as Partial<AgentSession>,
      approval: {
        ...pendingApproval,
        sessionId: "s-OTHER",
      } as Partial<AgentApproval>,
    });
    await expect(
      (
        h.ctl as unknown as {
          grantApproval: (a: string, b: string, c: unknown) => Promise<unknown>;
        }
      ).grantApproval("s-1", pendingApproval.approvalKey!, admin),
    ).rejects.toThrow(ConflictException);
    expect(h.approvals.decide).not.toHaveBeenCalled();
  });

  it("grant：挂起会话 → 条件写 + 复用 resume 链路（reason=resume:approval）", async () => {
    const h = harness({
      session: { id: "s-1", status: "waiting_input" } as Partial<AgentSession>,
      approval: pendingApproval as Partial<AgentApproval>,
      decideResult: grantedRow as Partial<AgentApproval>,
    });
    const out = (await (
      h.ctl as unknown as {
        grantApproval: (a: string, b: string, c: unknown) => Promise<unknown>;
      }
    ).grantApproval("s-1", pendingApproval.approvalKey!, admin)) as {
      ok: boolean;
      resumed: boolean;
    };
    expect(out.ok).toBe(true);
    expect(out.resumed).toBe(true);
    expect(h.approvals.decide).toHaveBeenCalledWith(
      pendingApproval.approvalKey,
      "granted",
      "alice",
    );
    expect(h.queue.add).toHaveBeenCalledWith(
      "run",
      { sessionId: "s-1", reason: "resume:approval" },
      expect.objectContaining({ attempts: 1 }),
    );
  });

  it("deny：**不**自动 resume；按审批单把调用行落成 denied（实施轮 #14 语义反转）", async () => {
    const h = harness({
      session: { id: "s-1", status: "waiting_input" } as Partial<AgentSession>,
      approval: pendingApproval as Partial<AgentApproval>,
      decideResult: {
        ...pendingApproval,
        status: "denied",
        decidedBy: "alice",
      } as Partial<AgentApproval>,
    });
    const out = (await (
      h.ctl as unknown as {
        denyApproval: (a: string, b: string, c: unknown) => Promise<unknown>;
      }
    ).denyApproval("s-1", pendingApproval.approvalKey!, admin)) as {
      ok: boolean;
      resumed: boolean;
    };
    // 原实现 deny 也 resume：模型手里没有「被拒绝」的事实，下一轮必然重提
    // 同一调用 → 再生成一张单 → 管理员只能无限拒绝（可持续驱动的执行循环）。
    expect(out.resumed).toBe(false);
    expect(h.queue.add).not.toHaveBeenCalled();
    expect(h.approvals.decide).toHaveBeenCalledWith(
      pendingApproval.approvalKey,
      "denied",
      "alice",
    );
    expect(
      h.sessions.settleToolCallByApprovalId,
    ).toHaveBeenCalledWith(
      pendingApproval.approvalKey,
      "denied",
      expect.stringContaining("alice"),
    );
  });

  it("grant：仍有其它 pending 单 → 先不恢复（恢复只会立刻再次挂起）", async () => {
    const h = harness({
      session: { id: "s-1", status: "waiting_input" } as Partial<AgentSession>,
      approval: pendingApproval as Partial<AgentApproval>,
      decideResult: grantedRow as Partial<AgentApproval>,
      hasPending: true,
    });
    const out = (await (
      h.ctl as unknown as {
        grantApproval: (a: string, b: string, c: unknown) => Promise<unknown>;
      }
    ).grantApproval("s-1", pendingApproval.approvalKey!, admin)) as {
      resumed: boolean;
    };
    expect(out.resumed).toBe(false);
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it("resume：会话仍有 pending 审批单 → 409（审批不能被绕过）", async () => {
    const h = harness({
      session: { id: "s-1", status: "waiting_input" } as Partial<AgentSession>,
      hasPending: true,
    });
    await expect(
      (h.ctl as unknown as { resume: (id: string) => Promise<unknown> }).resume(
        "s-1",
      ),
    ).rejects.toThrow(ConflictException);
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it("非挂起会话（如已被 sweep 终态化）→ 只翻转审批单，不入队", async () => {
    const h = harness({
      session: { id: "s-1", status: "failed" } as Partial<AgentSession>,
      approval: pendingApproval as Partial<AgentApproval>,
      decideResult: grantedRow as Partial<AgentApproval>,
    });
    const out = (await (
      h.ctl as unknown as {
        grantApproval: (a: string, b: string, c: unknown) => Promise<unknown>;
      }
    ).grantApproval("s-1", pendingApproval.approvalKey!, admin)) as {
      resumed: boolean;
    };
    expect(out.resumed).toBe(false);
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it("listApprovals：会话不存在 → 404（requireById 前置）", async () => {
    const h = harness({ session: null });
    await expect(
      (
        h.ctl as unknown as { listApprovals: (id: string) => Promise<unknown> }
      ).listApprovals("missing"),
    ).rejects.toThrow(NotFoundException);
  });
});

describe("AgentApprovalsService · 确定性键与一次性领取（实施轮 #14）", () => {
  it("同会话 + 同工具 + 同参数（键序不同）→ 同一键（重试幂等的前提）", () => {
    const svc = new AgentApprovalsService({} as never);
    const a = svc.buildKey("s-1", "update_task", { taskId: "t-1", name: "n" });
    const b = svc.buildKey("s-1", "update_task", { name: "n", taskId: "t-1" });
    expect(a).toBe(b);
    expect(a).toMatch(/^apr-s-1-[0-9a-f]{16}$/);
  });

  it("参数/工具/会话任一不同 → 不同键（不同调用各自申请）", () => {
    const svc = new AgentApprovalsService({} as never);
    const base = svc.buildKey("s-1", "update_task", { taskId: "t-1" });
    expect(svc.buildKey("s-1", "update_task", { taskId: "t-2" })).not.toBe(base);
    expect(svc.buildKey("s-1", "deploy_application", { taskId: "t-1" })).not.toBe(base);
    expect(svc.buildKey("s-2", "update_task", { taskId: "t-1" })).not.toBe(base);
    // 原实现用 Date.now()：同一调用两次执行必然不同键（此断言把它钉死）
    expect(svc.buildKey("s-1", "update_task", { taskId: "t-1" })).toBe(base);
  });

  it("数组保序：参数顺序不同是不同调用", () => {
    const svc = new AgentApprovalsService({} as never);
    expect(svc.buildKey("s", "t", { ids: ["a", "b"] })).not.toBe(
      svc.buildKey("s", "t", { ids: ["b", "a"] }),
    );
  });

  it("consume：条件写 granted → consumed，命中 0 行即未领取", async () => {
    const repo = {
      update: jest.fn(async () => ({ affected: 1 })),
    };
    const svc = new AgentApprovalsService(repo as never);
    await expect(svc.consume("apr-s-1-x")).resolves.toBe(true);
    expect(repo.update).toHaveBeenCalledWith(
      { approvalKey: "apr-s-1-x", status: "granted" },
      { status: "consumed" },
    );

    const lost = new AgentApprovalsService(
      { update: jest.fn(async () => ({ affected: 0 })) } as never,
    );
    await expect(lost.consume("apr-s-1-x")).resolves.toBe(false);
  });
});
