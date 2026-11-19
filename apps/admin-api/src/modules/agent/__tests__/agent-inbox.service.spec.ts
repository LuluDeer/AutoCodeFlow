/**
 * R278 · S1 服务端聚合的**判据钉子**（单测级）。
 *
 * 本文件钉住 brief §五 的五条验收判据，逐条对应一个 describe：
 *
 *  ① 一会话 2 单 ⇒ `total=2`、`sessionTotal=1`（口径不是「会话数」，也不是
 *     `items.length` 的别名）；
 *  ② `total > limit` ⇒ `truncated:true`，且 `total` 来自**独立 `count()`**
 *     （把 `items.length` 当 total 时这条必红 —— 这正是要防的那一类）；
 *  ③ 仓储抛错 ⇒ 对应字段 `null` + `degraded:true`，**绝不允许 0**；
 *  ④ 会话无标题 ⇒ `sessionTitle:null`，**不退回 uuid**；
 *  ⑤ `limit` 越界 ⇒ 钳到 1..200。
 *
 * 另钉两条契约细节：
 *  · `total` 为 null 时 `truncated` 只能是 false（「未知」由 `degraded` 表达）；
 *  · 装配缺失 ⇒ 503（`DEPENDENCY_UNAVAILABLE`），**不**回 200 空信封；
 *  · 批量取标题用一次 `In(...)`（消除 N+1：会话数从 1 变 5，查询次数不变）。
 */
import { ServiceUnavailableException } from "@nestjs/common";

import {
  AgentInboxService,
  clampPendingApprovalLimit,
} from "../runtime/agent-inbox.service";
import { AppError } from "../../../common/errors/app-error";
import type { AgentApproval } from "../entities/agent-approval.entity";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";

function row(over: Partial<AgentApproval> = {}): AgentApproval {
  return {
    id: "row-1",
    approvalKey: "apr-k-1",
    sessionId: SESSION_A,
    toolName: "update_task",
    reason: "写操作需人工放行",
    argsDigest: "a".repeat(64),
    preview: '{"truncated":false,"args":"{}"}',
    status: "pending",
    scope: "once",
    policyFingerprint: null,
    expiresAt: null,
    decidedBy: null,
    decidedAt: null,
    consumedAt: null,
    createdAt: new Date("2026-11-19T01:00:00.000Z"),
    ...over,
  } as AgentApproval;
}

/**
 * 假仓储：**逐个方法可注入失败**，且记录调用次数（N+1 的反证靠它）。
 *
 * `count()` 刻意与 `find()` **独立配置** —— 若被测代码把 `find().length` 当
 * total，下面的「total=7 / 返回 2 行」用例会立刻把它抓出来。
 */
function harness(
  opts: {
    rows?: AgentApproval[];
    total?: number;
    sessionTotal?: number;
    titles?: Array<{ id: string; title: string | null }>;
    fail?: Array<
      | "find"
      | "count"
      | "distinct"
      | "titles"
      | "sessions"
      | "backlog"
      | "stall"
      | "deployments"
    >;
    waitingTotal?: number;
    stalledTotal?: number;
    backlog?: {
      sessionIds?: string[];
      count: number;
      probed?: number;
      truncated: boolean;
    };
    stall?: { stalled: boolean; degraded: boolean };
    deploymentTotal?: number;
    omit?: Array<"approvals" | "sessionRepo" | "sessionService">;
  } = {},
) {
  const fail = (key: string) => {
    if (opts.fail?.includes(key as never)) throw new Error(`${key} down`);
  };

  const calls = { find: 0, count: 0, distinct: 0, titles: 0 };
  const approvals = {
    find: jest.fn(async () => {
      calls.find += 1;
      fail("find");
      return opts.rows ?? [];
    }),
    count: jest.fn(async () => {
      calls.count += 1;
      fail("count");
      return opts.total ?? (opts.rows ?? []).length;
    }),
    createQueryBuilder: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn(async () => {
        calls.distinct += 1;
        fail("distinct");
        return { n: opts.sessionTotal ?? 1 };
      }),
    })),
  };

  const sessionRepo = {
    find: jest.fn(async () => {
      calls.titles += 1;
      fail("titles");
      return opts.titles ?? [];
    }),
  };

  const sessionService = {
    list: jest.fn(async (args: { status?: string; stalled?: unknown }) => {
      fail("sessions");
      if (args?.stalled) return { items: [], total: opts.stalledTotal ?? 0 };
      if (args?.status === "waiting_input")
        return { items: [], total: opts.waitingTotal ?? 0 };
      return { items: [], total: 0 };
    }),
  };

  const backlog = {
    findBacklogged: jest.fn(async () => {
      fail("backlog");
      return (
        opts.backlog ?? {
          sessionIds: [],
          count: 0,
          probed: 0,
          truncated: false,
        }
      );
    }),
  };

  const queueStall = {
    inspect: jest.fn(async () => {
      fail("stall");
      return {
        stalled: opts.stall?.stalled ?? false,
        reason: null,
        pendingJobs: 0,
        degraded: opts.stall?.degraded ?? false,
        degradedCounts: false,
        workersKnown: true,
        snapshot: {},
      };
    }),
  };

  const deployments = {
    findAll: jest.fn(async () => {
      fail("deployments");
      return { data: [], total: opts.deploymentTotal ?? 0 };
    }),
  };

  const svc = new AgentInboxService(
    opts.omit?.includes("approvals") ? null : (approvals as never),
    opts.omit?.includes("sessionRepo") ? null : (sessionRepo as never),
    opts.omit?.includes("sessionService") ? null : (sessionService as never),
    backlog as never,
    queueStall as never,
    deployments as never,
  );
  return {
    svc,
    approvals,
    sessionRepo,
    sessionService,
    backlog,
    queueStall,
    deployments,
    calls,
  };
}

describe("R278 · 待审批单聚合（GET /agent/approvals/pending）", () => {
  it("① 一个会话挂 2 张待审单 ⇒ total=2、sessionTotal=1（口径不是 items.length 的别名）", async () => {
    const { svc } = harness({
      rows: [
        row({ approvalKey: "apr-1" }),
        row({ approvalKey: "apr-2", id: "row-2" }),
      ],
      total: 2,
      sessionTotal: 1,
    });

    const res = await svc.pending();

    expect(res.items).toHaveLength(2);
    expect(res.total).toBe(2);
    expect(res.sessionTotal).toBe(1);
    expect(res.returned).toBe(2);
    expect(res.truncated).toBe(false);
    expect(res.degraded).toBe(false);
  });

  it("② total 取自独立 count()：返回 2 行而 total=7 ⇒ truncated:true（不是 2/2）", async () => {
    const { svc, approvals, calls } = harness({
      rows: [row({ approvalKey: "apr-1" }), row({ approvalKey: "apr-2" })],
      total: 7,
      sessionTotal: 5,
    });

    const res = await svc.pending({ limit: 2 });

    expect(res.returned).toBe(2);
    expect(res.total).toBe(7);
    expect(res.truncated).toBe(true);
    // `count()` 真的被调用过，且谓词与 find 一致（status=pending + scope=once）。
    expect(calls.count).toBe(1);
    expect(approvals.count).toHaveBeenCalledWith({
      where: { status: "pending", scope: "once" },
    });
  });

  it("③ 仓储抛错 ⇒ total:null + degraded:true，绝不渲染成 0", async () => {
    const { svc } = harness({
      rows: [row()],
      fail: ["count", "distinct"],
    });

    const res = await svc.pending();

    expect(res.total).toBeNull();
    expect(res.sessionTotal).toBeNull();
    expect(res.degraded).toBe(true);
    // items 读成功 ⇒ 仍然返回（部分可用，HTTP 200）。
    expect(res.items).toHaveLength(1);
    // ⚠️ 语义断言：total 未知时 truncated 只能是 false（「未知」由 degraded 表达）。
    expect(res.truncated).toBe(false);
  });

  it("③b 连 items 都读不到 ⇒ items 空 + degraded，且不把 0 当成事实", async () => {
    const { svc } = harness({ fail: ["find", "count", "distinct"] });

    const res = await svc.pending();

    expect(res.items).toEqual([]);
    expect(res.returned).toBe(0);
    expect(res.total).toBeNull();
    expect(res.degraded).toBe(true);
  });

  it("④ 会话无标题 ⇒ sessionTitle:null，绝不退回 uuid", async () => {
    const { svc } = harness({
      rows: [
        row({ approvalKey: "apr-1", sessionId: SESSION_A }),
        row({ approvalKey: "apr-2", sessionId: SESSION_B }),
      ],
      total: 2,
      sessionTotal: 2,
      // SESSION_A 有标题；SESSION_B 在库里没有行 / 标题为空 ⇒ null
      titles: [{ id: SESSION_A, title: "审批演示会话" }],
    });

    const res = await svc.pending();

    expect(res.items[0].sessionTitle).toBe("审批演示会话");
    expect(res.items[1].sessionTitle).toBeNull();
    // 反证：不是 uuid 字符串
    expect(res.items[1].sessionTitle).not.toBe(SESSION_B);
  });

  it("④b 标题为空串/空白 ⇒ 同样 null（不渲染空白标题）", async () => {
    const { svc } = harness({
      rows: [row({ sessionId: SESSION_A })],
      total: 1,
      sessionTotal: 1,
      titles: [{ id: SESSION_A, title: "   " }],
    });

    const res = await svc.pending();

    expect(res.items[0].sessionTitle).toBeNull();
  });

  it("④c 标题批量取一次 In(...)：会话数 1 → 5 时标题查询次数不变（消除 N+1）", async () => {
    const oneSession = harness({
      rows: [row({ sessionId: SESSION_A })],
      total: 1,
      titles: [{ id: SESSION_A, title: "A" }],
    });
    await oneSession.svc.pending();

    const manyRows = Array.from({ length: 5 }, (_, i) =>
      row({ approvalKey: `apr-${i}`, sessionId: `session-${i}` }),
    );
    const manySessions = harness({ rows: manyRows, total: 5 });
    await manySessions.svc.pending();

    expect(oneSession.calls.titles).toBe(1);
    expect(manySessions.calls.titles).toBe(1);
    // 一次 `In(...)` 批量：谓词里的 id 集合 == 本次所有会话 id（不是逐条查）
    const titleArgs = (
      manySessions.sessionRepo.find.mock.calls as unknown[][]
    )[0][0] as {
      where: { id: { value: string[] } };
      select: Record<string, boolean>;
    };
    expect(titleArgs.where.id.value).toEqual(manyRows.map((r) => r.sessionId));
    // 只投影 id/title（不搬 contextJson/resultJson 大字段）
    expect(titleArgs.select).toEqual({ id: true, title: true });
    // find 也只调用一次（不是每会话一次）
    expect(manySessions.calls.find).toBe(1);
  });

  it("⑤ limit 越界钳到 1..200（超界 200、下界 1、非法值回落默认 100）", async () => {
    expect(clampPendingApprovalLimit(1000)).toBe(200);
    expect(clampPendingApprovalLimit(0)).toBe(1);
    expect(clampPendingApprovalLimit(-5)).toBe(1);
    expect(clampPendingApprovalLimit(Number.NaN)).toBe(100);
    expect(clampPendingApprovalLimit(undefined)).toBe(100);
    expect(clampPendingApprovalLimit(37)).toBe(37);

    const { svc, approvals } = harness({ rows: [], total: 0 });
    await svc.pending({ limit: 1000 });
    expect(approvals.find).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200 }),
    );
  });

  it("⑥ preview / argsDigest 直接透出既有列（不新增序列化逻辑）", async () => {
    const { svc } = harness({
      rows: [
        row({
          preview: '{"truncated":true,"args":"{\\"token\\":\\"[REDACTED]\\"}"}',
          argsDigest: "b".repeat(64),
        }),
      ],
      total: 1,
      titles: [],
    });

    const res = await svc.pending();

    expect(res.items[0].preview).toBe(
      '{"truncated":true,"args":"{\\"token\\":\\"[REDACTED]\\"}"}',
    );
    expect(res.items[0].argsDigest).toBe("b".repeat(64));
  });

  it("⑦ 装配缺失 ⇒ 503 DEPENDENCY_UNAVAILABLE（不回 200 空信封）", async () => {
    const { svc } = harness({ omit: ["approvals"] });

    // `AppError` 构造后把原型挂到内置异常类上（保住既有 `instanceof` 断言），
    // 故按 503 的内置类断言 + 用 `errorCode` 钉码（两件事都要）。
    const err = await svc.pending().catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as AppError).errorCode).toBe("DEPENDENCY_UNAVAILABLE");
    expect((err as AppError).getStatus()).toBe(503);
  });

  it("⑧ createdAt 输出 ISO 字符串（不是 Date 对象）", async () => {
    const { svc } = harness({
      rows: [row({ createdAt: new Date("2026-11-19T01:02:03.000Z") })],
      total: 1,
    });

    const res = await svc.pending();

    expect(res.items[0].createdAt).toBe("2026-11-19T01:02:03.000Z");
  });
});

describe("R278 · 收件箱计数（GET /agent/inbox/counts）", () => {
  it("① 六个计数各自独立：口径 = 审批单数 + 会话数 + 积压 + 部署 + 停摆三态", async () => {
    const { svc, backlog } = harness({
      total: 3,
      waitingTotal: 2,
      stalledTotal: 1,
      backlog: { sessionIds: ["s1"], count: 4, probed: 4, truncated: true },
      stall: { stalled: true, degraded: false },
      deploymentTotal: 5,
    });

    const res = await svc.counts();

    expect(res.pendingApprovals).toBe(3);
    expect(res.waitingSessions).toBe(2);
    expect(res.stalled).toBe(1);
    expect(res.backlogged).toBe(4);
    // 对账有探测上限 ⇒ 必须说清这是**下界**
    expect(res.backlogTruncated).toBe(true);
    expect(res.deployments).toBe(5);
    expect(res.queueStall).toBe(1);
    expect(res.degraded).toBe(false);
    expect(backlog.findBacklogged).toHaveBeenCalledTimes(1);
  });

  it("② 队列停摆观测 degraded ⇒ queueStall:null（不是 0「正常」）", async () => {
    const { svc } = harness({ stall: { stalled: false, degraded: true } });

    const res = await svc.counts();

    expect(res.queueStall).toBeNull();
    expect(res.degraded).toBe(true);
  });

  it("③ 单字段读失败只让那一个字段 null，其它照常（部分可用 HTTP 200）", async () => {
    const { svc } = harness({
      total: 3,
      waitingTotal: 2,
      fail: ["backlog"],
    });

    const res = await svc.counts();

    expect(res.pendingApprovals).toBe(3);
    expect(res.waitingSessions).toBe(2);
    expect(res.backlogged).toBeNull();
    expect(res.backlogTruncated).toBe(false);
    expect(res.degraded).toBe(true);
  });

  it("③b 审批单计数失败 ⇒ pendingApprovals:null，绝不 0（否则徽标会显示「没有待办」）", async () => {
    const { svc } = harness({ fail: ["count"] });

    const res = await svc.counts();

    expect(res.pendingApprovals).toBeNull();
    expect(res.degraded).toBe(true);
  });

  it("④ 装配缺失 ⇒ 503（不回 200 全 null 信封）", async () => {
    const { svc } = harness({ omit: ["sessionService"] });

    const err = await svc.counts().catch((e) => e);
    expect((err as AppError).errorCode).toBe("DEPENDENCY_UNAVAILABLE");
    expect((err as AppError).getStatus()).toBe(503);
  });
});
