/**
 * 零会话用户 · **空可见视域谓词**的钉子（单测级，替身仓储）。
 *
 * ## 缺陷（真进程实测）
 *
 * `AgentInboxService.pendingWhere` 在空可见视域时用裸字符串哨兵
 * `'__no_visible_session__'` 去比 **uuid 列** `sessionId`
 * （`agent_approvals.sessionId` 是 `uuid NOT NULL`，见
 * `migrations/1790000000040-AddAgentRuntimeTables.ts`）。PG 在**参数解析期**就拒掉：
 *
 *   ERROR: invalid input syntax for type uuid: "__no_visible_session__"
 *
 * 三个子查询（items / total / sessionTotal）一起失败 ⇒ 响应变成
 * `items: null-ish / total: null / sessionTotal: null / degraded: true`。
 * 事实是「这个用户**一条待办都没有**」，不是「读不到」——而
 * `agent-inbox.service.ts` 的三条不变量之③ 明确写着「失败绝不渲染成 0」，
 * 于是「零」被永久表达成「未知」，零会话用户永远拿到 degraded 信封。
 *
 * ## 本文件断言什么
 *
 * ① 空视域生成的 where **不含裸字符串哨兵**（JSON 里搜不到那个旧字面量）；
 * ② 空视域的 `sessionId` 谓词是**类型正确**的全零 uuid（`In` 形态 + 值合法）；
 * ③ 空视域 ⇒ `items: []`、`total: 0`、`sessionTotal: 0`、`degraded` 不为 true；
 * ④ `counts` 的空视域 `pendingApprovals` 是 **0 而不是 null**；
 * ⑤ 非空视域行为**逐字不变**（`In([...真实 uuid])`，degraded 仍按子查询成败走）；
 * ⑥ 未知归属（`unknown`）这条**旧路径不变**：仍 `total: null + degraded: true`
 *    —— 「读不到归属」与「归属为空」是两件事，本改动不合并它们。
 *
 * 替身仓储按 uuid 语义工作：它会像 PG 一样**校验** `In(...)` 里的值是否为合法
 * uuid，不合法就抛 `invalid input syntax for type uuid`。因此本文件跑绿即证明
 * 新谓词不会再触发那类错误（真 PG 的 e2e 由主控跑）。
 */
import { In } from "typeorm";

import {
  AgentInboxService,
  NO_VISIBLE_SESSION_ID,
} from "../runtime/agent-inbox.service";
import type { AgentApproval } from "../entities/agent-approval.entity";
import type { AuthUser } from "../../../common/interfaces/auth-user.interface";
import { UserRole } from "../../users/entities/user.entity";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OLD_SENTINEL = "__no_visible_session__";

const S1 = "11111111-1111-4111-8111-111111111111";

const USER_NO_SESSIONS = {
  id: 77,
  username: "zero-session-user",
  email: "zero@example.test",
  role: UserRole.USER,
  isActive: true,
} as AuthUser;

function approval(over: Partial<AgentApproval> = {}): AgentApproval {
  return {
    id: "row-1",
    approvalKey: "apr-1",
    sessionId: S1,
    toolName: "update_task",
    reason: "r",
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

/** `FindOperator` / 裸值 → 值数组（两种形态都吃，断言因此不依赖实现细节）。 */
function valuesOf(op: unknown): unknown[] {
  if (Array.isArray(op)) return op;
  const v =
    (op as { value?: unknown; _value?: unknown } | undefined)?.value ??
    (op as { _value?: unknown } | undefined)?._value;
  return Array.isArray(v) ? v : [];
}

/** 打印用：把 where 里的 FindOperator 摊平成可 JSON 序列化的形状。 */
function flatten(op: unknown): unknown {
  if (op && typeof op === "object" && !Array.isArray(op)) {
    const o = op as { _type?: unknown; _value?: unknown; value?: unknown };
    if (typeof o._type === "string" || o.value !== undefined) {
      return { _type: o._type ?? "value", _value: o._value ?? o.value };
    }
  }
  return op;
}

/**
 * 替身仓储：**按 uuid 语义校验** `In(...)` 里的每个值。
 *
 * 这是本文件的核心：旧哨兵在这里会抛
 * `invalid input syntax for type uuid: "__no_visible_session__"`，
 * 于是 `read()` 把它吞成 `null + degraded` —— 与真 PG 的可观测行为一致。
 */
function harness(
  opts: { ownedSessionIds?: string[]; rows?: AgentApproval[] } = {},
) {
  const owned = opts.ownedSessionIds ?? [];
  const rows = opts.rows ?? [];
  const seen: Array<{ where?: Record<string, unknown> }> = [];

  const assertUuidValues = (where?: Record<string, unknown>) => {
    const op = where?.sessionId;
    if (!op) return;
    for (const v of valuesOf(op)) {
      if (typeof v !== "string" || !UUID_RE.test(v)) {
        throw new Error(
          `invalid input syntax for type uuid: ${JSON.stringify(v)}`,
        );
      }
    }
  };

  const approvals = {
    find: jest.fn(async (args: { where?: Record<string, unknown> }) => {
      seen.push(args);
      assertUuidValues(args?.where);
      const w = args?.where ?? {};
      return rows.filter(
        (r) =>
          r.status === w.status &&
          r.scope === w.scope &&
          (!w.sessionId || valuesOf(w.sessionId).includes(r.sessionId)),
      );
    }),
    count: jest.fn(async (args: { where?: Record<string, unknown> }) => {
      seen.push(args);
      assertUuidValues(args?.where);
      const w = args?.where ?? {};
      return rows.filter(
        (r) =>
          r.status === w.status &&
          r.scope === w.scope &&
          (!w.sessionId || valuesOf(w.sessionId).includes(r.sessionId)),
      ).length;
    }),
    createQueryBuilder: jest.fn(() => {
      const params: Record<string, unknown> = {};
      const sqls: string[] = [];
      const qb = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn((sql: string, p?: Record<string, unknown>) => {
          sqls.push(sql);
          if (p) Object.assign(params, p);
          return qb;
        }),
        getRawOne: jest.fn(async () => {
          const ids = params.sessionIds as string[] | undefined;
          if (ids) {
            for (const v of ids) {
              if (typeof v !== "string" || !UUID_RE.test(v)) {
                throw new Error(
                  `invalid input syntax for type uuid: ${JSON.stringify(v)}`,
                );
              }
            }
            const hit = rows.filter((r) => ids.includes(r.sessionId));
            return { n: String(new Set(hit.map((r) => r.sessionId)).size) };
          }
          return { n: String(new Set(rows.map((r) => r.sessionId)).size) };
        }),
      };
      return qb;
    }),
  };

  const sessionRepo = {
    // 归属查询：ownedSessionIds 为空 ⇒ 这个用户**零会话**（不是读失败）。
    find: jest.fn(async (args: { where?: Record<string, unknown> }) => {
      if (args?.where?.createdBy) {
        return owned.map((id) => ({ id, createdBy: "user:zero-session-user" }));
      }
      return [];
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
  return { svc, approvals, sessionRepo, seen };
}

describe("空可见视域谓词 · 类型正确（零会话用户）", () => {
  it("① pending 的 where 不含裸字符串哨兵，且 sessionId 谓词里全是合法 uuid", async () => {
    const { svc, seen } = harness({ ownedSessionIds: [] });

    const res = await svc.pending({ viewer: USER_NO_SESSIONS });

    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) {
      // ① 旧哨兵一个都不许出现（序列化后全文搜）。
      expect(JSON.stringify(call.where)).not.toContain(OLD_SENTINEL);
      const op = call.where?.sessionId;
      if (op) {
        const vals = valuesOf(op);
        expect(vals.length).toBeGreaterThan(0);
        for (const v of vals) {
          expect(typeof v).toBe("string");
          expect(v as string).toMatch(UUID_RE);
        }
      }
    }
    // 谓词形态与 `typeorm.In` 一致（真 `In` 的形状：`_type:"in"` + `_value`）。
    const first = seen[0].where?.sessionId as { _type?: string } | undefined;
    expect(first?._type).toBe("in");
    expect(res.degraded).not.toBe(true);
  });

  it("② 空视域 ⇒ items:[] / total:0 / sessionTotal:0 / degraded 不为 true", async () => {
    // 库里**有**别人的待审单：空视域必须一条都取不到（而不是全取）。
    const { svc } = harness({
      ownedSessionIds: [],
      rows: [approval({ approvalKey: "apr-other", sessionId: S1 })],
    });

    const res = await svc.pending({ viewer: USER_NO_SESSIONS });

    expect(res.items).toEqual([]);
    expect(res.returned).toBe(0);
    expect(res.total).toBe(0);
    expect(res.sessionTotal).toBe(0);
    expect(res.truncated).toBe(false);
    // 核心反证：零条**不是** degraded。
    expect(res.degraded).toBe(false);
    expect(res.total).not.toBeNull();
    expect(res.sessionTotal).not.toBeNull();
  });

  it("③ counts 的空视域 pendingApprovals = 0（不是 null）+ degraded 不为 true", async () => {
    const { svc } = harness({
      ownedSessionIds: [],
      rows: [approval({ approvalKey: "apr-other", sessionId: S1 })],
    });

    const res = await svc.counts({ viewer: USER_NO_SESSIONS });

    expect(res.pendingApprovals).toBe(0);
    expect(res.pendingApprovals).not.toBeNull();
    expect(res.degraded).toBe(false);
  });

  it("④ 空视域的全零哨兵就是 NO_VISIBLE_SESSION_ID 且不含旧字面量", async () => {
    const { svc, seen } = harness({ ownedSessionIds: [] });
    await svc.pending({ viewer: USER_NO_SESSIONS });

    expect(NO_VISIBLE_SESSION_ID).toBe("00000000-0000-0000-0000-000000000000");
    expect(NO_VISIBLE_SESSION_ID).toMatch(UUID_RE);
    const vals = valuesOf(seen[0].where?.sessionId);
    expect(vals).toEqual([NO_VISIBLE_SESSION_ID]);
    expect(JSON.stringify(flatten(seen[0].where?.sessionId))).not.toContain(
      OLD_SENTINEL,
    );
  });

  it("⑤ 非空视域逐字不变：In([真实 uuid])、命中自己的单、degraded=false", async () => {
    const mine = "33333333-3333-4333-8333-333333333333";
    const { svc, seen } = harness({
      ownedSessionIds: [mine],
      rows: [
        approval({ approvalKey: "apr-mine", sessionId: mine }),
        approval({ approvalKey: "apr-other", sessionId: S1 }),
      ],
    });

    const res = await svc.pending({ viewer: USER_NO_SESSIONS });

    expect(res.items.map((i) => i.approvalKey)).toEqual(["apr-mine"]);
    expect(res.total).toBe(1);
    expect(res.sessionTotal).toBe(1);
    expect(res.degraded).toBe(false);
    // 谓词里是真实 uuid，不是哨兵。
    expect(valuesOf(seen[0].where?.sessionId)).toEqual([mine]);
    expect(JSON.stringify(seen[0].where)).not.toContain(NO_VISIBLE_SESSION_ID);
    expect(JSON.stringify(seen[0].where)).not.toContain(OLD_SENTINEL);
  });

  it("⑥ 归属读失败（unknown）仍是 total:null + degraded:true —— 旧路径不被合并", async () => {
    const failing = harness({ ownedSessionIds: [] });
    // 让归属查询本身抛错（读失败 ≠ 零会话）。
    failing.sessionRepo.find.mockImplementation(
      async (args?: { where?: Record<string, unknown> }) => {
        if (args?.where?.createdBy) throw new Error("session repo down");
        return [];
      },
    );

    const res = await failing.svc.pending({ viewer: USER_NO_SESSIONS });

    expect(res.items).toEqual([]);
    expect(res.total).toBeNull();
    expect(res.sessionTotal).toBeNull();
    expect(res.degraded).toBe(true);
  });

  it("⑦ 无 viewer（ADMIN/内部调用）谓词不变：没有 sessionId 条件", async () => {
    const { svc, seen } = harness({
      ownedSessionIds: [],
      rows: [approval()],
    });

    const res = await svc.pending();

    expect(res.total).toBe(1);
    expect(seen[0].where).toEqual({ status: "pending", scope: "once" });
    expect(seen[0].where?.sessionId).toBeUndefined();
  });

  it("⑧ 空视域下 `In` 谓词的 `_value` 与 `In([NO_VISIBLE_SESSION_ID])` 同形", async () => {
    const { svc, seen } = harness({ ownedSessionIds: [] });
    await svc.pending({ viewer: USER_NO_SESSIONS });

    const actual = seen[0].where?.sessionId as {
      _type?: string;
      _value?: unknown;
    };
    const expected = In([NO_VISIBLE_SESSION_ID]) as unknown as {
      _type?: string;
      _value?: unknown;
    };
    expect(actual._type).toBe(expected._type);
    expect(actual._value).toEqual(expected._value);
  });
});
