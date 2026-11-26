/**
 * GCO §5 · role=user 的「待我审批 / 待我处理」读面钉子（单测级 + 内存替身）。
 *
 * 验收四件事：
 *  ① 方法级 @Roles 覆盖类级 ADMIN，只放 approvals/pending 与 inbox/counts；
 *  ② 非 ADMIN viewer 只看到 `AgentSession.createdBy` 归属自己的审批单；
 *  ③ items / total / sessionTotal / truncated 与 counts.pendingApprovals 同谓词；
 *  ④ phrase 处置仍是 ADMIN-only，直调 403 时不触碰 agent_approvals 行。
 *
 * 本文件不启动 Nest/DB；断言的是「副作用缺失」（没有他人 preview、没有写面调用）。
 */
import { ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { ROLES_KEY } from "../../../common/decorators/roles.decorator";
import { RolesGuard } from "../../../common/guards/roles.guard";
import type { AuthUser } from "../../../common/interfaces/auth-user.interface";
import { UserRole } from "../../users/entities/user.entity";
import { AgentController } from "../agent.controller";
import type { AgentApproval } from "../entities/agent-approval.entity";
import { AgentInboxService } from "../runtime/agent-inbox.service";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";

const U1 = {
  id: 11,
  username: "u1",
  email: "u1@example.test",
  role: UserRole.USER,
  isActive: true,
} as AuthUser;
const U2 = {
  id: 22,
  username: "u2",
  email: "u2@example.test",
  role: UserRole.USER,
  isActive: true,
} as AuthUser;
const ADMIN = {
  id: 1,
  username: "admin",
  email: "admin@example.test",
  role: UserRole.ADMIN,
  isActive: true,
} as AuthUser;

function approval(over: Partial<AgentApproval> = {}): AgentApproval {
  return {
    id: "row-" + (over.approvalKey ?? "x"),
    approvalKey: over.approvalKey ?? "apr-x",
    sessionId: S1,
    toolName: "update_task",
    reason: "默认理由",
    argsDigest: "a".repeat(64),
    preview: "{}",
    status: "pending",
    scope: "once",
    policyFingerprint: null,
    expiresAt: null,
    decidedBy: null,
    decidedAt: null,
    consumedAt: null,
    createdAt: new Date("2026-11-27T00:00:00.000Z"),
    ...over,
  } as AgentApproval;
}

function whereIds(op: unknown): string[] {
  const value = (op as { value?: unknown } | undefined)?.value;
  return Array.isArray(value) ? (value as string[]) : [];
}

function inboxHarness(opts: { failOwnerLookup?: boolean } = {}) {
  const approvalRows: AgentApproval[] = [
    approval({
      approvalKey: "apr-u1",
      sessionId: S1,
      reason: "U1-私密理由",
      preview: '{"args":"U1-私密参数"}',
      createdAt: new Date("2026-11-27T00:00:01.000Z"),
    }),
    approval({
      approvalKey: "apr-u2",
      sessionId: S2,
      reason: "U2-私密理由",
      preview: '{"args":"U2-私密参数"}',
      createdAt: new Date("2026-11-27T00:00:02.000Z"),
    }),
  ];
  const sessionRows = [
    { id: S1, title: "U1 的会话", createdBy: "user:u1" },
    { id: S2, title: "U2 的会话", createdBy: "user:u2" },
  ];

  const approvals = {
    find: jest.fn(
      async (args: { where?: Record<string, unknown>; take?: number }) => {
        const w = args?.where ?? {};
        let rows = approvalRows.filter(
          (r) => r.status === w.status && r.scope === w.scope,
        );
        if (w.sessionId) {
          const ids = whereIds(w.sessionId);
          rows = rows.filter((r) => ids.includes(r.sessionId));
        }
        return rows.slice(0, args?.take ?? 100);
      },
    ),
    count: jest.fn(async (args: { where?: Record<string, unknown> }) => {
      const w = args?.where ?? {};
      let rows = approvalRows.filter(
        (r) => r.status === w.status && r.scope === w.scope,
      );
      if (w.sessionId) {
        const ids = whereIds(w.sessionId);
        rows = rows.filter((r) => ids.includes(r.sessionId));
      }
      return rows.length;
    }),
    createQueryBuilder: jest.fn(() => {
      const params: Record<string, unknown> = {};
      const predicates: string[] = [];
      const qb: {
        select: jest.Mock;
        where: jest.Mock;
        andWhere: jest.Mock;
        getRawOne: jest.Mock;
      } = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn((_sql: string, p?: Record<string, unknown>) => {
          if (p) Object.assign(params, p);
          return qb;
        }),
        andWhere: jest.fn((sql: string, p?: Record<string, unknown>) => {
          predicates.push(sql);
          if (p) Object.assign(params, p);
          return qb;
        }),
        getRawOne: jest.fn(async () => {
          const ids = params.sessionIds as string[] | undefined;
          const rows = ids
            ? approvalRows.filter((r) => ids.includes(r.sessionId))
            : approvalRows;
          return { n: String(new Set(rows.map((r) => r.sessionId)).size) };
        }),
      };
      return qb;
    }),
  };

  const sessionRepo = {
    find: jest.fn(async (args: { where?: Record<string, unknown> }) => {
      if (args?.where?.createdBy) {
        if (opts.failOwnerLookup) throw new Error("session repo down");
        const tokens = whereIds(args.where.createdBy);
        return sessionRows
          .filter((s) => tokens.includes(s.createdBy))
          .map((s) => ({ id: s.id, createdBy: s.createdBy }));
      }
      const ids = whereIds(args?.where?.id);
      return sessionRows
        .filter((s) => !ids.length || ids.includes(s.id))
        .map((s) => ({ id: s.id, title: s.title }));
    }),
    count: jest.fn(async () => 0),
  };
  const sessionService = {
    list: jest.fn(async () => ({ items: [], total: 0 })),
  };
  const backlog = {
    findBacklogged: jest.fn(async () => ({
      sessionIds: [],
      count: 0,
      probed: 0,
      truncated: false,
    })),
  };
  const queueStall = {
    inspect: jest.fn(async () => ({
      stalled: false,
      reason: null,
      pendingJobs: 0,
      degraded: false,
      degradedCounts: false,
      workersKnown: true,
      snapshot: {},
    })),
  };
  const deployments = {
    findAll: jest.fn(async () => ({ data: [], total: 0 })),
  };

  const svc = new AgentInboxService(
    approvals as never,
    sessionRepo as never,
    sessionService as never,
    backlog as never,
    queueStall as never,
    deployments as never,
    null,
  );
  return { svc, approvals, sessionRepo, approvalRows };
}

function phraseHarness() {
  const rows = [approval({ approvalKey: "apr-phrase", sessionId: S1 })];
  const approvals = {
    findByKey: jest.fn(async () => rows[0]),
    decideByPhrase: jest.fn(async () => {
      rows[0] = { ...rows[0], status: "granted", decidedBy: "u1" };
      return rows[0];
    }),
  };
  const ctl = new AgentController(
    { requireById: jest.fn(async () => ({ id: S1 })) } as never,
    {} as never,
    approvals as never,
    {} as never,
  );
  return { ctl, approvals, rows };
}

const guard = new RolesGuard(new Reflector());
const context = (handler: object, user: AuthUser) =>
  ({
    getHandler: () => handler,
    getClass: () => AgentController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as never;

async function invokeWithGuard(
  handler: object,
  user: AuthUser,
  run: () => Promise<unknown>,
): Promise<unknown> {
  if (!guard.canActivate(context(handler, user))) {
    throw new ForbiddenException("Forbidden resource");
  }
  return run();
}

describe("GCO §5 · 读端点放行 / 写面保持 ADMIN", () => {
  it("类级 ADMIN 保留；只有两个只读端点的方法级元数据放行给 USER", () => {
    expect(Reflect.getMetadata(ROLES_KEY, AgentController)).toEqual([
      UserRole.ADMIN,
    ]);
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        AgentController.prototype.listPendingApprovals,
      ),
    ).toEqual([UserRole.ADMIN, UserRole.USER]);
    expect(
      Reflect.getMetadata(ROLES_KEY, AgentController.prototype.inboxCounts),
    ).toEqual([UserRole.ADMIN, UserRole.USER]);
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        AgentController.prototype.decideApprovalByPhrase,
      ),
    ).toEqual([UserRole.ADMIN]);
    expect(
      Reflect.getMetadata(ROLES_KEY, AgentController.prototype.exportSession),
    ).toBeUndefined();
  });

  it("RolesGuard：USER 过两个读端点；phrase / export 仍 403", () => {
    expect(
      guard.canActivate(
        context(AgentController.prototype.listPendingApprovals, U1),
      ),
    ).toBe(true);
    expect(
      guard.canActivate(context(AgentController.prototype.inboxCounts, U1)),
    ).toBe(true);
    expect(
      guard.canActivate(
        context(AgentController.prototype.decideApprovalByPhrase, U1),
      ),
    ).toBe(false);
    expect(
      guard.canActivate(context(AgentController.prototype.exportSession, U1)),
    ).toBe(false);
  });

  it("U1 直调 phrase 得 403，且 agent_approvals 行未变、decideByPhrase 未被调用", async () => {
    const h = phraseHarness();
    const before = JSON.stringify(h.rows);
    await expect(
      invokeWithGuard(
        AgentController.prototype.decideApprovalByPhrase,
        U1,
        () =>
          h.ctl.decideApprovalByPhrase(
            S1,
            "apr-phrase",
            { phrase: "allow" },
            U1,
          ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.approvals.decideByPhrase).not.toHaveBeenCalled();
    expect(JSON.stringify(h.rows)).toBe(before);
  });
});

describe("GCO §5 · 按会话归属过滤的读面", () => {
  it("U1 的 pending items 全属 createdBy=user:u1 的会话，U2 不进 items/total", async () => {
    const { svc } = inboxHarness();
    const res = await svc.pending({ viewer: U1 });

    expect(res.items.map((i) => i.approvalKey)).toEqual(["apr-u1"]);
    expect(res.items.every((i) => i.sessionId === S1)).toBe(true);
    expect(res.total).toBe(1);
    expect(res.sessionTotal).toBe(1);
    expect(res.returned).toBe(1);
    expect(res.degraded).toBe(false);
    expect(JSON.stringify(res)).not.toContain("U2-私密理由");
    expect(JSON.stringify(res)).not.toContain("U2-私密参数");
  });

  it("U2 视域对称：只看得到 createdBy=user:u2 的会话", async () => {
    const { svc } = inboxHarness();
    const res = await svc.pending({ viewer: U2 });
    expect(res.items.map((i) => i.approvalKey)).toEqual(["apr-u2"]);
    expect(res.total).toBe(1);
    expect(JSON.stringify(res)).not.toContain("U1-私密参数");
  });

  it("counts.pendingApprovals 与过滤后 total 相等，ADMIN viewer 看全量", async () => {
    const { svc, sessionRepo } = inboxHarness();
    const mine = await svc.pending({ viewer: U1 });
    const counts = await svc.counts({ viewer: U1 });
    expect(counts.pendingApprovals).toBe(mine.total);
    expect(counts.pendingApprovals).toBe(1);

    sessionRepo.find.mockClear();
    const all = await svc.pending({ viewer: ADMIN });
    expect(all.items.map((i) => i.approvalKey)).toEqual(["apr-u1", "apr-u2"]);
    expect(all.total).toBe(2);
    expect(all.sessionTotal).toBe(2);
    // ADMIN 短路：sessionRepo.find 只被批量标题用了一次，没有归属查询。
    expect(sessionRepo.find).toHaveBeenCalledTimes(1);
    expect(
      sessionRepo.find.mock.calls.every(([a]) => !a?.where?.createdBy),
    ).toBe(true);
  });

  it("归属读失败时 fail-closed：items 空、total null（未知 ≠ 0）、degraded", async () => {
    const { svc } = inboxHarness({ failOwnerLookup: true });
    const res = await svc.pending({ viewer: U1 });
    expect(res.items).toEqual([]);
    expect(res.total).toBeNull();
    expect(res.sessionTotal).toBeNull();
    expect(res.degraded).toBe(true);
  });

  it("控制组：不传 viewer 仍保持旧的全局聚合（ADMIN/内部调用契约不变）", async () => {
    const { svc } = inboxHarness();
    const res = await svc.pending();
    expect(res.total).toBe(2);
    expect(res.items).toHaveLength(2);
  });
});
