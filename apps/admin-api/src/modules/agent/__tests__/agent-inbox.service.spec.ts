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
  resolveFailedWindowHours,
  FAILED_SESSION_WINDOW_HOURS_DEFAULT,
} from "../runtime/agent-inbox.service";
import { AppError } from "../../../common/errors/app-error";
import type { AgentApproval } from "../entities/agent-approval.entity";
import { AgentController } from "../agent.controller";

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
      | "sessionCount"
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
    /** R279：窗口内失败会话数（独立 count() 的返回值）。 */
    failedSessions?: number;
    /** R279：配置读到的窗口小时数（省略 ⇒ 模拟「配置缺席」）。 */
    windowHours?: number;
    omit?: Array<"approvals" | "sessionRepo" | "sessionService" | "config">;
  } = {},
) {
  const fail = (key: string) => {
    if (opts.fail?.includes(key as never)) throw new Error(`${key} down`);
  };

  const calls = {
    find: 0,
    count: 0,
    distinct: 0,
    titles: 0,
    sessionCount: 0,
  };
  /** 最近一次 `sessionRepo.count()` 的入参（用于断言谓词本身）。 */
  let lastSessionCountArgs: { where?: Record<string, unknown> } | undefined;
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
    /**
     * R279：失败会话计数走**独立 `count()`**（不是 `find().length`）。
     *
     * 刻意与 `find()` 分开配置：若被测代码把 `find().length` 当总数，下面的
     * 「count=3 而 find 返回 0 行」用例会立刻把它抓出来。
     */
    count: jest.fn(async (args: { where?: Record<string, unknown> }) => {
      calls.sessionCount += 1;
      lastSessionCountArgs = args;
      fail("sessionCount");
      return opts.failedSessions ?? 0;
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
    // R279：末位可选参数（既有用例不传 ⇒ 窗口回落默认 24h，旧行为不变）。
    opts.omit?.includes("config")
      ? null
      : opts.windowHours === undefined
        ? null
        : ({ get: jest.fn(() => opts.windowHours) } as never),
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
    /** R279：最近一次失败计数查询的入参（断言谓词用）。 */
    lastSessionCountArgs: () => lastSessionCountArgs,
  };
}

/**
 * R279 · controller 的最小装配（只用于钉 `since` 这个 **HTTP 边界**参数）。
 *
 * 为什么单独一个 harness 而不是复用 `agent.controller.spec.ts`：那边用**定位参数**
 * 装配 `AgentController`，而本文件要断言的是 `list()` 把 `since` 解析成什么。
 * 只装一个 `sessions.list` 替身即可 —— 参数解析与「旧行为不变」都发生在这一层，
 * 不需要真仓储（那是 `counts()` 的用例面）。
 */
function controllerHarness() {
  const sessions = { list: jest.fn(async () => ({ items: [], total: 0 })) };
  const ctl = new AgentController(
    sessions as never,
    { resolveBudget: jest.fn() } as never,
    {} as never,
    {} as never,
  );
  return { ctl, sessions };
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

/**
 * R279 · 「Agent 会话失败」小节的服务端计数。
 *
 * 钉住 brief §五 的四条判据，逐条对应一个用例：
 *  ① `failed` + `budget_exceeded` 计入、`aborted` **不计**（后者是人主动停的）；
 *  ② 窗口外的不计（谓词必须带 `createdAt >= now - windowHours`）；
 *  ③ 仓储抛错 ⇒ `failedSessions:null` + `degraded`，**不允许 0**；
 *  ④ `since` 缺省 = 不筛（旧行为一字不变）。
 *
 * 另钉三条契约细节：
 *  · `failedSessions` 走**独立 `count()`**，不是 `find().length` 的别名；
 *  · `failedWindowHours` 是**配置而非事实** ⇒ 读不到回默认 24，**永不 null**；
 *  · `failedSessions` **不参与**任何会话求和（独立显示项，与 D3 一致）。
 */
describe("R279 · 失败会话计数（GET /agent/inbox/counts 的 failedSessions）", () => {
  it("① 口径 = failed + budget_exceeded，且 aborted 不在谓词里（不计）", async () => {
    const { svc, lastSessionCountArgs } = harness({ failedSessions: 3 });

    const res = await svc.counts();

    expect(res.failedSessions).toBe(3);
    expect(res.degraded).toBe(false);

    // 谓词本身：`status` 必须是恰好两项的 `In([...])`，且**不含 `aborted`**。
    const where = lastSessionCountArgs()?.where as {
      status?: { value?: string[] };
      createdAt?: unknown;
    };
    expect(where?.status?.value).toEqual(["failed", "budget_exceeded"]);
    expect(where?.status?.value).not.toContain("aborted");
    // 反证：`succeeded` 同样不计（它不是待办）。
    expect(where?.status?.value).not.toContain("succeeded");
    // 时间窗谓词必须在（② 的另一半：没有它这条会退化成「全 history 计数」）。
    expect(where?.createdAt).toBeDefined();
  });

  it("② 窗口下界来自配置：默认 24h 时 `since ≈ now-24h`（用 createdAt 不是 updatedAt）", async () => {
    const before = Date.now();
    const { svc, lastSessionCountArgs } = harness({ failedSessions: 1 });

    const res = await svc.counts();
    const after = Date.now();

    expect(res.failedWindowHours).toBe(FAILED_SESSION_WINDOW_HOURS_DEFAULT);
    expect(res.failedWindowHours).toBe(24);

    // `MoreThanOrEqual` 实例：TypeORM 把值挂在 `_value` 上（不依赖私有实现细节的
    // 写法是只看区间是否落在 now-24h 附近）。
    const createdAt = lastSessionCountArgs()?.where?.createdAt as {
      _value?: Date;
    };
    const at = createdAt?._value?.getTime?.();
    expect(typeof at).toBe("number");
    const expectedLo = before - 24 * 3600 * 1000;
    const expectedHi = after - 24 * 3600 * 1000;
    expect(at as number).toBeGreaterThanOrEqual(expectedLo - 1000);
    expect(at as number).toBeLessThanOrEqual(expectedHi + 1000);
  });

  it("②b 窗口可配：配置给 1 小时 ⇒ failedWindowHours:1 且下界随之前移", async () => {
    const before = Date.now();
    const { svc, lastSessionCountArgs } = harness({
      failedSessions: 2,
      windowHours: 1,
    });

    const res = await svc.counts();

    expect(res.failedWindowHours).toBe(1);
    const createdAt = lastSessionCountArgs()?.where?.createdAt as {
      _value?: Date;
    };
    const at = createdAt?._value?.getTime?.() as number;
    expect(at).toBeGreaterThanOrEqual(before - 3600 * 1000 - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() - 3600 * 1000 + 1000);
  });

  it("③ 仓储抛错 ⇒ failedSessions:null + degraded:true，绝不渲染成 0", async () => {
    const { svc } = harness({ fail: ["sessionCount"] });

    const res = await svc.counts();

    expect(res.failedSessions).toBeNull();
    expect(res.degraded).toBe(true);
    // ⚠️ 语义断言：null 与 0 必须可区分 —— 这条是 `toBeNull()`，不是 `toBe(0)`。
    expect(res.failedSessions).not.toBe(0);
    // 窗口是配置 ⇒ 同一请求里仍必须是数字（不跟着降级）。
    expect(res.failedWindowHours).toBe(24);
  });

  it("③b 独立 count()：find 返回 0 行而 count=3 ⇒ failedSessions 仍是 3", async () => {
    const { svc, sessionRepo, calls } = harness({
      failedSessions: 3,
      titles: [],
    });

    const res = await svc.counts();

    expect(res.failedSessions).toBe(3);
    // `count()` 真的被调用过（不是 find().length —— 那会是 0）。
    expect(calls.sessionCount).toBe(1);
    expect(sessionRepo.count).toHaveBeenCalledTimes(1);
    // `find()` **没有**被用来数失败会话（它只用于 pending 的标题批量取）。
    expect(calls.titles).toBe(0);
  });

  it("③c 失败是独立显示项：不参与任何会话求和（不污染 waitingSessions）", async () => {
    const { svc } = harness({
      failedSessions: 9,
      waitingTotal: 2,
      stalledTotal: 1,
    });

    const res = await svc.counts();

    // 三个会话计数互为独立事实，谁都不把别人加进来。
    expect(res.failedSessions).toBe(9);
    expect(res.waitingSessions).toBe(2);
    expect(res.stalled).toBe(1);
  });

  it("④ 实为 0 时回 0（真实零 ≠ 未知）：这是唯一允许出现 0 的分支", async () => {
    const { svc } = harness({ failedSessions: 0 });

    const res = await svc.counts();

    expect(res.failedSessions).toBe(0);
    expect(res.failedSessions).not.toBeNull();
    expect(res.degraded).toBe(false);
  });

  it("⑤ 窗口是配置而非事实：非法/缺失/0/负数 ⇒ 一律回落默认 24，绝不 null", async () => {
    expect(resolveFailedWindowHours(undefined)).toBe(24);
    expect(resolveFailedWindowHours(null)).toBe(24);
    expect(resolveFailedWindowHours(Number.NaN)).toBe(24);
    expect(resolveFailedWindowHours(0)).toBe(24);
    expect(resolveFailedWindowHours(-5)).toBe(24);
    expect(resolveFailedWindowHours(Number.POSITIVE_INFINITY)).toBe(24);
    expect(resolveFailedWindowHours("abc")).toBe(24);
    // 合法值原样透出（截断成整数）。
    expect(resolveFailedWindowHours(72)).toBe(72);
    expect(resolveFailedWindowHours(1)).toBe(1);
    expect(resolveFailedWindowHours(2.9)).toBe(2);

    // 配置服务缺席（既有 spec 用定位参数装配本 service 时就是这样）⇒ 仍回数字。
    const { svc } = harness({ omit: ["config"], failedSessions: 4 });
    const res = await svc.counts();
    expect(res.failedWindowHours).toBe(24);
    expect(res.failedSessions).toBe(4);
  });
});

describe("R279 · sessions 列表的 since 参数（缺省 = 不筛 = 旧行为）", () => {
  it("① 缺省 ⇒ list() 收到的 since 是 undefined（不筛，旧行为一字不变）", async () => {
    const { ctl, sessions } = controllerHarness();

    await ctl.list();

    expect(sessions.list).toHaveBeenCalledWith(
      expect.objectContaining({ since: undefined }),
    );
    // 反证：既有参数一个没变（这是「只追加」的判据）。
    expect(sessions.list).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: undefined,
        status: undefined,
        stalled: undefined,
        page: undefined,
        pageSize: undefined,
      }),
    );
  });

  it("② 合法 ISO ⇒ 透传成 Date（收件箱失败小节用它取窗口内的行）", async () => {
    const { ctl, sessions } = controllerHarness();

    await ctl.list(
      undefined,
      "failed",
      undefined,
      undefined,
      undefined,
      undefined,
      "2026-11-18T00:00:00.000Z",
    );

    const arg = (sessions.list.mock.calls as unknown[][])[0][0] as {
      since?: Date;
      status?: string;
    };
    expect(arg.status).toBe("failed");
    expect(arg.since).toBeInstanceOf(Date);
    expect(arg.since?.toISOString()).toBe("2026-11-18T00:00:00.000Z");
  });

  it("③ 非法值 ⇒ 回落 undefined（不筛 / 不 400）：坏 query 不该让整页 500", async () => {
    const { ctl, sessions } = controllerHarness();

    await ctl.list(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "not-a-date",
    );

    const arg = (sessions.list.mock.calls as unknown[][])[0][0] as {
      since?: Date;
    };
    expect(arg.since).toBeUndefined();
    // 没有把 NaN Date 交给 TypeORM（那会打成 SQL 语法错）。
    expect(sessions.list).toHaveBeenCalledTimes(1);
  });
});
