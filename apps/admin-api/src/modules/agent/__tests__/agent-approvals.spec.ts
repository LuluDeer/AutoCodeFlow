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
  /** G4 四眼原则开关（ConfigService 替身）。 */
  config?: { get: (k: string) => unknown };
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
    (options.config ?? { get: () => false }) as never,
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
    expect(h.sessions.settleToolCallByApprovalId).toHaveBeenCalledWith(
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
    expect(svc.buildKey("s-1", "update_task", { taskId: "t-2" })).not.toBe(
      base,
    );
    expect(
      svc.buildKey("s-1", "deploy_application", { taskId: "t-1" }),
    ).not.toBe(base);
    expect(svc.buildKey("s-2", "update_task", { taskId: "t-1" })).not.toBe(
      base,
    );
    // 原实现用 Date.now()：同一调用两次执行必然不同键（此断言把它钉死）
    expect(svc.buildKey("s-1", "update_task", { taskId: "t-1" })).toBe(base);
  });

  it("数组保序：参数顺序不同是不同调用", () => {
    const svc = new AgentApprovalsService({} as never);
    expect(svc.buildKey("s", "t", { ids: ["a", "b"] })).not.toBe(
      svc.buildKey("s", "t", { ids: ["b", "a"] }),
    );
  });

  it("深嵌套参数不爆栈（canonicalJson 递归有深度钳位——RangeError 不得在 boundary 深度闸之前逃出）", () => {
    const svc = new AgentApprovalsService({} as never);
    // 5 万层嵌套：boundary 的 MAX_SCAN_DEPTH=32 会拒它，但 buildKey 在闸门
    // **之前**执行——若无钳位，这里先以 RangeError 崩掉 tool-executor，
    // 异常沿运行时循环上逃、会话永久卡 running。
    let deep: unknown = "leaf";
    for (let i = 0; i < 50_000; i += 1) deep = [deep];
    expect(() => svc.buildKey("s", "t", { params: deep })).not.toThrow();
    // 键仍是确定性字符串（超深部分被截断为稳定占位串）
    expect(svc.buildKey("s", "t", { params: deep })).toMatch(
      /^apr-s-[0-9a-f]{16}$/,
    );
  });

  it("consume：条件写 granted → consumed，命中 0 行即未领取", async () => {
    const repo = {
      update: jest.fn(async () => ({ affected: 1 })),
    };
    const svc = new AgentApprovalsService(repo as never);
    await expect(svc.consume("apr-s-1-x")).resolves.toBe(true);
    // 状态与执行时刻必须是**同一条** UPDATE（两次写会留下「status=consumed、
    // consumedAt 为空」的窗口，而审计恰恰要区分这一格）
    expect(repo.update).toHaveBeenCalledWith(
      { approvalKey: "apr-s-1-x", status: "granted" },
      { status: "consumed", consumedAt: expect.any(Date) },
    );

    const lost = new AgentApprovalsService({
      update: jest.fn(async () => ({ affected: 0 })),
    } as never);
    await expect(lost.consume("apr-s-1-x")).resolves.toBe(false);
  });
});

/**
 * G4（OSS 对照审计）：四眼原则——发起人不能批准自己发起的会话的审批单。
 * 默认关闭（单人部署不被卡死），部署方显式开启后生效。
 */
describe("AgentController · 审批四眼原则（G4）", () => {
  const session = {
    id: "s-1",
    status: "waiting_input",
    createdBy: "user:alice",
    kind: "ops_watch",
  } as Partial<AgentSession>;

  it("开关开启：发起人批准自己的审批单 → 403，且不落任何处置", async () => {
    const h = harness({
      session,
      approval: pendingApproval,
      decideResult: grantedRow,
      config: { get: () => true },
    });
    await expect(
      h.ctl.grantApproval("s-1", pendingApproval.approvalKey!, admin),
    ).rejects.toMatchObject({ errorCode: "AGENT_APPROVAL_SELF_DENIED" });
    expect(h.approvals.decide).not.toHaveBeenCalled();
  });

  it("开关关闭（默认）：同一管理员仍可处置（行为与改动前一致）", async () => {
    const h = harness({
      session,
      approval: pendingApproval,
      decideResult: null,
      config: { get: () => false },
    });
    // decide 返回 null → 走既有的 NOT_FOUND 分支（证明没有被四眼原则拦住）
    await expect(
      h.ctl.grantApproval("s-1", pendingApproval.approvalKey!, admin),
    ).rejects.toMatchObject({ errorCode: "AGENT_APPROVAL_NOT_FOUND" });
  });

  it("存量会话 createdBy=NULL：不可判定 → 不拦（只 warn）", async () => {
    const h = harness({
      session: { ...session, createdBy: null },
      approval: pendingApproval,
      decideResult: null,
      config: { get: () => true },
    });
    await expect(
      h.ctl.grantApproval("s-1", pendingApproval.approvalKey!, admin),
    ).rejects.toMatchObject({ errorCode: "AGENT_APPROVAL_NOT_FOUND" });
  });
});
