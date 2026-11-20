/**
 * R286 · 切片 A：**「滞后的 blocked 工单」观测面的判据钉子**（单测级）。
 *
 * 逐条对应 brief 的七条验收：
 * ① `blocked` 且超 TTL ⇒ 计入；
 * ② `blocked` 但未超 TTL ⇒ **不计**；
 * ③ `in_progress` / `completed` **不计**；
 * ④ 仓储抛错 ⇒ `total: null` + `degraded`（**不允许 0**）；
 * ⑤ `sopName` 读不到 ⇒ `null` 不退回 uuid；
 * ⑥ `hours` 越界/非法 ⇒ 安全回落**不 400**；
 * ⑦ 装配缺失 ⇒ 503。
 *
 * 另钉三条契约细节（都是本仓踩过的形态）：
 *  · `total` 必须来自**独立 `getCount()`**：`find`/`getMany` 的长度只是 `returned`，
 *    把两者混同会让「被行数上限截断」与「一共就这么多」同形；
 *  · `truncated` 在 `total === null` 时只能是 false（「未知」由 `degraded` 表达）；
 *  · SOP 标题与升级澄清都用**一次** `In(...)` 批量取（N+1 的反证：指派数从 1 变 3，
 *    查询次数不变）。
 *
 * ⚠️ **反证（brief 要求）**：把口径里的 `status='blocked'` 改成 `in_progress`
 * ⇒ ①②③ 必须红。反证不靠改源码，而是靠下面的假仓储**执行**谓词绑定：
 * `makeAssignmentRepo` 真按 `where` 里的 `:status` 参数过滤，`hours` 窗口也真按
 * `:cutoff` 过滤。这样「谓词写错了」会在断言上现形，而不是只比对 SQL 字符串。
 */
import { ServiceUnavailableException } from "@nestjs/common";

import {
  SopAssignmentLagService,
  clampLagHours,
  LAG_HOURS_DEFAULT,
  LAG_HOURS_MAX,
  LAG_HOURS_MIN,
  LAG_ROW_LIMIT,
} from "../sop-assignment-lag.service";
import { AppError } from "../../../common/errors/app-error";
import type { SopAssignment } from "../entities/sop-assignment.entity";
import { SopController } from "../sop.controller";

const ASG_1 = "a1111111-1111-4111-8111-111111111111";
const ASG_2 = "a2222222-2222-4222-8222-222222222222";
const ASG_3 = "a3333333-3333-4333-8333-333333333333";
const SOP_1 = "51111111-1111-4111-8111-111111111111";
const SOP_2 = "52222222-2222-4222-8222-222222222222";
const CLAR_1 = "c1111111-1111-4111-8111-111111111111";
const CLAR_2 = "c2222222-2222-4222-8222-222222222222";

/** 固定"现在"：`updatedAt` 的年龄都是相对它的，单测不该依赖真实时钟。 */
const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function asg(over: Partial<SopAssignment> = {}): SopAssignment {
  return {
    id: ASG_1,
    sopId: SOP_1,
    sopVersion: "v1",
    status: "blocked",
    clarificationRound: 5,
    maxRounds: 5,
    updatedAt: new Date(NOW - 30 * HOUR),
    ...over,
  } as SopAssignment;
}

/**
 * 假仓储的**谓词执行器**：真的按 `status` 与 `cutoff` 过滤。
 *
 * 反证能成立全靠这一步——把口径改成 `in_progress` 时这里会返回 0 行，
 * ①②③ 的断言立刻红；若只断言 SQL 字符串，改错谓词也能"绿"。
 *
 * ⚠️ `updatedAt` **不可解析 ⇒ 视同进入窗口**：脏值确实会从驱动层漏进来
 * （手工改库 / 驱动回不可解析字符串），假仓储不该替被测代码把它挡掉——
 * 否则「脏数据防御」那条用例就成了空转。
 */
function inWindow(
  rows: SopAssignment[],
  status: string | undefined,
  cutoff: Date | undefined,
): SopAssignment[] {
  return rows.filter((r) => {
    if (r.status !== status) return false;
    if (!cutoff) return true;
    const t = new Date(r.updatedAt).getTime();
    return Number.isNaN(t) ? true : t <= cutoff.getTime();
  });
}

/**
 * 假指派仓储：`createQueryBuilder` 返回的链式桩**真的执行**谓词。
 *
 * 这是反证的基础：把 status 口径改成 `in_progress` 时，`getMany()`/`getCount()`
 * 会返回 0 行，①②③ 三条断言立刻红——而不是"SQL 字符串长得不一样"这种弱断言。
 */
function makeAssignmentRepo(
  rows: SopAssignment[],
  opts: { failItems?: boolean; failCount?: boolean; total?: number } = {},
) {
  const calls = { qb: 0, items: 0, count: 0 };
  /** 每次 `createQueryBuilder` 记下的谓词参数（断言口径用）。 */
  const qbLog: Array<{
    status?: string;
    cutoff?: Date;
    limit?: number;
    orderBy?: unknown;
  }> = [];

  function makeQb() {
    const log: { status?: string; cutoff?: Date; limit?: number } = {};
    qbLog.push(log);
    const qb = {
      where: jest.fn((_sql: string, params: { status?: string }) => {
        log.status = params.status;
        return qb;
      }),
      andWhere: jest.fn((_sql: string, params: { cutoff?: Date }) => {
        log.cutoff = params.cutoff;
        return qb;
      }),
      orderBy: jest.fn(() => qb),
      addOrderBy: jest.fn(() => qb),
      limit: jest.fn((n: number) => {
        log.limit = n;
        return qb;
      }),
      getMany: jest.fn(async () => {
        calls.items += 1;
        if (opts.failItems) throw new Error("items down");
        return (
          inWindow(rows, log.status, log.cutoff)
            // 假仓储也要**执行** ORDER BY：否则「服务端已排好序」这条断言是空转的。
            .slice()
            .sort((x, y) => {
              const dx = new Date(x.updatedAt).getTime();
              const dy = new Date(y.updatedAt).getTime();
              if (dx !== dy) return dx - dy; // updatedAt ASC（卡得最久的在前）
              return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
            })
            .slice(0, log.limit ?? Number.POSITIVE_INFINITY)
        );
      }),
      getCount: jest.fn(async () => {
        calls.count += 1;
        if (opts.failCount) throw new Error("count down");
        // ⚠️ 默认回**与 rows 不等**的数：任何「把 rows.length 当 total」的实现
        // 都会在这条默认值上露馅。
        if (opts.total !== undefined) return opts.total;
        return inWindow(rows, log.status, log.cutoff).length;
      }),
    };
    return qb;
  }

  return {
    calls,
    qbLog,
    createQueryBuilder: jest.fn(() => {
      calls.qb += 1;
      return makeQb();
    }),
  };
}

function harness(
  opts: {
    assignments?: SopAssignment[];
    total?: number;
    failItems?: boolean;
    failCount?: boolean;
    sops?: Array<{ id: string; title: string | null }>;
    clarifications?: Array<{
      id: string;
      assignmentId: string;
      round: number;
      resolution: string;
    }>;
    failSopTitles?: boolean;
    failEscalations?: boolean;
    omit?: Array<"assignments" | "sops" | "clarifications">;
  } = {},
) {
  const rows = opts.assignments ?? [];
  const repo = makeAssignmentRepo(rows, {
    failItems: opts.failItems,
    failCount: opts.failCount,
    total: opts.total,
  });

  const calls = { sopTitles: 0, escalations: 0 };
  const sops = {
    find: jest.fn(async () => {
      calls.sopTitles += 1;
      if (opts.failSopTitles) throw new Error("sops down");
      return opts.sops ?? [];
    }),
  };
  const clarifications = {
    find: jest.fn(async () => {
      calls.escalations += 1;
      if (opts.failEscalations) throw new Error("clarifications down");
      return (opts.clarifications ?? [])
        .filter((c) => c.resolution === "escalated_to_human")
        .slice()
        .sort((a, b) => b.round - a.round);
    }),
  };

  const svc = new SopAssignmentLagService(
    opts.omit?.includes("assignments") ? (undefined as never) : (repo as never),
    opts.omit?.includes("sops") ? (undefined as never) : (sops as never),
    opts.omit?.includes("clarifications")
      ? (undefined as never)
      : (clarifications as never),
  );

  return { svc, repo, sops, clarifications, calls };
}

describe("R286 · 滞留 blocked 口径（GET /sop/assignments/lagging）", () => {
  it("① blocked 且超 TTL（30h > 24h）⇒ 计入，且 blockedSince = updatedAt", async () => {
    const h = harness({
      assignments: [asg({ updatedAt: new Date(NOW - 30 * HOUR) })],
    });
    const res = await h.svc.lagging({ hours: 24, now: NOW });

    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      assignmentId: ASG_1,
      sopId: SOP_1,
      status: "blocked",
      blockedSince: new Date(NOW - 30 * HOUR).toISOString(),
    });
    expect(res.total).toBe(1);
    expect(res.returned).toBe(1);
    expect(res.truncated).toBe(false);
    expect(res.degraded).toBe(false);
  });

  it("② blocked 但未超 TTL（1h < 24h）⇒ 不计入（列表与 total 同时为 0，不是只藏列表）", async () => {
    const h = harness({
      assignments: [asg({ updatedAt: new Date(NOW - 1 * HOUR) })],
    });
    const res = await h.svc.lagging({ hours: 24, now: NOW });

    expect(res.items).toHaveLength(0);
    // 关键：total 也必须同步为 0 —— 「列表空、徽标 1」正是两处口径漂移的形态。
    expect(res.total).toBe(0);
    expect(res.degraded).toBe(false);
  });

  it("③ in_progress / completed / stalled 一律不计入（只有 blocked）", async () => {
    const h = harness({
      assignments: [
        asg({ id: ASG_1, status: "in_progress" as never }),
        asg({ id: ASG_2, status: "completed" as never }),
        asg({ id: ASG_3, status: "stalled" as never }),
      ],
    });
    const res = await h.svc.lagging({ hours: 24, now: NOW });

    expect(res.items).toHaveLength(0);
    expect(res.total).toBe(0);
  });

  it("①②③ 反证：谓词若从 blocked 漂成 in_progress，本组必须红", async () => {
    // 真按口径走 ⇒ 两条 blocked（30h/40h）+ 一条 in_progress（40h）里只应命中 2 条。
    const fixture = [
      asg({ id: ASG_1, updatedAt: new Date(NOW - 30 * HOUR) }),
      asg({ id: ASG_2, updatedAt: new Date(NOW - 40 * HOUR) }),
      asg({
        id: ASG_3,
        status: "in_progress" as never,
        updatedAt: new Date(NOW - 40 * HOUR),
      }),
    ];
    const { svc: svcOk } = harness({ assignments: fixture });
    const ok = await svcOk.lagging({ hours: 24, now: NOW });
    expect(ok.total).toBe(2);
    expect(ok.items.map((i) => i.assignmentId)).toEqual([ASG_2, ASG_1]);

    // 反证：同一份数据、把 status 口径换成 in_progress，命中集合完全互换。
    const { svc: svcWrong } = harness({
      assignments: fixture.map((r) => ({
        ...r,
        status: "in_progress" as never,
      })),
    });
    const wrong = await svcWrong.lagging({ hours: 24, now: NOW });
    // 若实现真的漏成 in_progress，这条会得到 3 而不是 0 ⇒ ①③ 的断言即红。
    expect(wrong.total).toBe(0);
    expect(wrong.items).toHaveLength(0);
  });

  it("④ 计数仓储抛错 ⇒ total:null + degraded（**不允许 0**），列表仍可用", async () => {
    const h = harness({
      assignments: [asg({ updatedAt: new Date(NOW - 30 * HOUR) })],
      failCount: true,
    });
    const res = await h.svc.lagging({ hours: 24, now: NOW });

    // 这就是本仓的主导缺陷类：把「没读到」渲染成「没有」。
    expect(res.total).toBeNull();
    expect(res.degraded).toBe(true);
    // 列表没失败，行照常返回——部分可用不等于整页失败。
    expect(res.returned).toBe(1);
    // total 未知 ⇒ 截断与否也不可知 ⇒ 只能 false。
    expect(res.truncated).toBe(false);
  });

  it("④b items 抛错 ⇒ items 空 + degraded，但 total 仍是真数（不连坐）", async () => {
    const h = harness({
      assignments: [asg({ updatedAt: new Date(NOW - 30 * HOUR) })],
      failItems: true,
    });
    const res = await h.svc.lagging({ hours: 24, now: NOW });

    expect(res.items).toHaveLength(0);
    expect(res.returned).toBe(0);
    expect(res.total).toBe(1);
    expect(res.degraded).toBe(true);
    // total 有值 ⇒ truncated 可以真判（0 < 1）。
    expect(res.truncated).toBe(true);
  });

  it("⑤ sopName 读不到 ⇒ null，绝不退回 uuid", async () => {
    const h = harness({
      assignments: [asg({ updatedAt: new Date(NOW - 30 * HOUR) })],
      sops: [], // 标题行不存在
    });
    const res = await h.svc.lagging({ hours: 24, now: NOW });

    expect(res.items[0].sopName).toBeNull();
    // 这条断言就是「不许退回 uuid」本身：uuid 不是给人看的标题。
    expect(res.items[0].sopName).not.toBe(SOP_1);
    expect(res.degraded).toBe(false);
  });

  it("⑤b 空白标题视同没有标题 ⇒ null（不渲染空白标题行）", async () => {
    const h = harness({
      assignments: [asg({ updatedAt: new Date(NOW - 30 * HOUR) })],
      sops: [{ id: SOP_1, title: "   " }],
    });
    const res = await h.svc.lagging({ hours: 24, now: NOW });

    expect(res.items[0].sopName).toBeNull();
  });

  it("⑤c 标题子查询抛错 ⇒ sopName:null + degraded，行仍保留（不因此丢工单）", async () => {
    const h = harness({
      assignments: [asg({ updatedAt: new Date(NOW - 30 * HOUR) })],
      failSopTitles: true,
    });
    const res = await h.svc.lagging({ hours: 24, now: NOW });

    expect(res.items).toHaveLength(1);
    expect(res.items[0].sopName).toBeNull();
    expect(res.degraded).toBe(true);
  });

  it("⑥ hours：未传 ⇒ 默认 24（30h 计入 / 23h 不计入，恰好卡在边界两侧）", async () => {
    const older = harness({
      assignments: [asg({ updatedAt: new Date(NOW - 30 * HOUR) })],
    });
    expect((await older.svc.lagging({ now: NOW })).total).toBe(1);

    const newer = harness({
      assignments: [asg({ updatedAt: new Date(NOW - 23 * HOUR) })],
    });
    expect((await newer.svc.lagging({ now: NOW })).total).toBe(0);
  });

  it("⑥b hours 越界/非法 ⇒ 钳制或回落默认，结论仍然 200（不抛 400）", async () => {
    const ages = [0.5, 2, 25, 500, 5000];
    for (const hours of [0, -5, 9999, Number.NaN, Number.POSITIVE_INFINITY]) {
      // 每个非法值都对应一条「一定落在窗口外」的行（ages 里挑最老的一条）。
      const h = harness({
        assignments: [
          asg({ id: ASG_1, updatedAt: new Date(NOW - ages[0] * HOUR) }),
          asg({ id: ASG_2, updatedAt: new Date(NOW - ages[4] * HOUR) }),
        ],
      });
      const res = await h.svc.lagging({ hours, now: NOW }); // 不抛 = 不 400
      // 非法值一律回落 24（`9999` 钳到 720）：5000h 的那条仍超窗口 ⇒ 计入。
      expect(res.total).toBe(1);
      expect(res.items[0].assignmentId).toBe(ASG_2);
    }
  });

  it("⑥c clampLagHours 逐条钉住（纯函数，含小数截断）", () => {
    expect(clampLagHours(undefined)).toBe(LAG_HOURS_DEFAULT);
    expect(clampLagHours(null)).toBe(LAG_HOURS_DEFAULT);
    expect(clampLagHours(Number.NaN)).toBe(LAG_HOURS_DEFAULT);
    expect(clampLagHours(Number.POSITIVE_INFINITY)).toBe(LAG_HOURS_DEFAULT);
    expect(clampLagHours(0)).toBe(LAG_HOURS_MIN);
    expect(clampLagHours(-1)).toBe(LAG_HOURS_MIN);
    expect(clampLagHours(3.9)).toBe(3);
    expect(clampLagHours(24)).toBe(24);
    expect(clampLagHours(9999)).toBe(LAG_HOURS_MAX);
    // 默认值本身必须在钳制面内，否则「不传」与「传默认」会走出不同窗口。
    expect(LAG_HOURS_DEFAULT).toBeGreaterThanOrEqual(LAG_HOURS_MIN);
    expect(LAG_HOURS_DEFAULT).toBeLessThanOrEqual(LAG_HOURS_MAX);
  });

  it("⑦ 装配缺失 ⇒ 503 DEPENDENCY_UNAVAILABLE（绝不回 200 空信封）", async () => {
    for (const omit of [
      ["assignments"],
      ["sops"],
      ["clarifications"],
    ] as const) {
      const h = harness({ omit: omit as never });
      const err = await h.svc.lagging({ hours: 24, now: NOW }).catch((e) => e);
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect((err as AppError).errorCode).toBe("DEPENDENCY_UNAVAILABLE");
    }
  });

  it("total 来自独立 getCount()，不是 getMany().length（截断场景直接区分两者）", async () => {
    // 列表回 1 行、count 回 7 ⇒ 若实现取 `rows.length`，total 会是 1。
    const h = harness({
      assignments: [asg({ updatedAt: new Date(NOW - 30 * HOUR) })],
      total: 7,
    });
    const res = await h.svc.lagging({ hours: 24, now: NOW });

    expect(res.total).toBe(7);
    expect(res.returned).toBe(1);
    expect(res.truncated).toBe(true);
    expect(h.repo.calls.count).toBe(1);
  });

  it("items 与 total 走同一份谓词（同一 status / 同一 cutoff），且带行数上限", async () => {
    const h = harness({
      assignments: [asg({ updatedAt: new Date(NOW - 30 * HOUR) })],
    });
    await h.svc.lagging({ hours: 24, now: NOW });

    expect(h.repo.qbLog).toHaveLength(2);
    const [a, b] = h.repo.qbLog;
    // 两处口径必须一模一样：改一处忘另一处会得到「列表 7 行、总数 3」。
    expect(a.status).toBe("blocked");
    expect(b.status).toBe("blocked");
    expect(a.cutoff?.toISOString()).toBe(b.cutoff?.toISOString());
    expect(a.cutoff?.toISOString()).toBe(
      new Date(NOW - 24 * HOUR).toISOString(),
    );
    // count 查询不该带 limit（带了会把计数压到行数上限）。
    expect(b.limit).toBeUndefined();
    // items 查询带服务端常量上限（不是可传参数）。
    expect(a.limit).toBe(LAG_ROW_LIMIT);
  });

  it("N+1 反证：指派数 1 → 3，SOP / 澄清各只查一次", async () => {
    const one = harness({
      assignments: [asg({ updatedAt: new Date(NOW - 30 * HOUR) })],
      sops: [{ id: SOP_1, title: "部署 SOP" }],
      clarifications: [
        {
          id: CLAR_1,
          assignmentId: ASG_1,
          round: 6,
          resolution: "escalated_to_human",
        },
      ],
    });
    await one.svc.lagging({ hours: 24, now: NOW });

    const three = harness({
      assignments: [
        asg({ id: ASG_1, sopId: SOP_1, updatedAt: new Date(NOW - 30 * HOUR) }),
        asg({ id: ASG_2, sopId: SOP_2, updatedAt: new Date(NOW - 40 * HOUR) }),
        asg({ id: ASG_3, sopId: SOP_1, updatedAt: new Date(NOW - 50 * HOUR) }),
      ],
      sops: [
        { id: SOP_1, title: "部署 SOP" },
        { id: SOP_2, title: "巡检 SOP" },
      ],
      clarifications: [
        {
          id: CLAR_1,
          assignmentId: ASG_1,
          round: 6,
          resolution: "escalated_to_human",
        },
        {
          id: CLAR_2,
          assignmentId: ASG_2,
          round: 3,
          resolution: "escalated_to_human",
        },
      ],
    });
    await three.svc.lagging({ hours: 24, now: NOW });

    // 行数 1 → 3，查询次数不变。
    expect(one.calls.sopTitles).toBe(1);
    expect(three.calls.sopTitles).toBe(1);
    expect(one.calls.escalations).toBe(1);
    expect(three.calls.escalations).toBe(1);
    // 同一 SOP 的两条指派 ⇒ 标题只取一次（`In` 批量的去重效果）。
    expect(three.sops.find).toHaveBeenCalledTimes(1);
  });

  it("升级澄清：取该指派的最高轮（round）与其 id；无澄清 ⇒ 两者皆 null", async () => {
    const h = harness({
      assignments: [
        asg({ id: ASG_1, updatedAt: new Date(NOW - 30 * HOUR) }),
        asg({ id: ASG_2, sopId: SOP_2, updatedAt: new Date(NOW - 40 * HOUR) }),
      ],
      clarifications: [
        {
          id: CLAR_1,
          assignmentId: ASG_1,
          round: 3,
          resolution: "escalated_to_human",
        },
        {
          id: CLAR_2,
          assignmentId: ASG_1,
          round: 6,
          resolution: "escalated_to_human",
        },
      ],
    });
    const res = await h.svc.lagging({ hours: 24, now: NOW });

    const byId = new Map(res.items.map((i) => [i.assignmentId, i] as const));
    // ASG_1 有两条 ⇒ 取最大轮 6 的那条（不是最早那条）。
    expect(byId.get(ASG_1)).toMatchObject({
      staleClarificationId: CLAR_2,
      round: 6,
    });
    // ASG_2 没有任何升级澄清 ⇒ 两者皆 null（**未知/无**，不是「第 0 轮」）。
    expect(byId.get(ASG_2)?.staleClarificationId).toBeNull();
    expect(byId.get(ASG_2)?.round).toBeNull();
  });

  it("升级澄清子查询抛错 ⇒ round/staleClarificationId 为 null + degraded（行不丢）", async () => {
    const h = harness({
      assignments: [asg({ updatedAt: new Date(NOW - 30 * HOUR) })],
      failEscalations: true,
    });
    const res = await h.svc.lagging({ hours: 24, now: NOW });

    expect(res.items).toHaveLength(1);
    expect(res.items[0].staleClarificationId).toBeNull();
    expect(res.items[0].round).toBeNull();
    expect(res.degraded).toBe(true);
    // total 仍来自独立计数 ⇒ 必须是真数而不是 null。
    expect(res.total).toBe(1);
  });

  it("脏数据：updatedAt 不可解析 ⇒ 该行丢弃 + degraded（不编假时长、不 500）", async () => {
    const h = harness({
      assignments: [
        asg({ id: ASG_1, updatedAt: new Date("not-a-date" as never) }),
        asg({ id: ASG_2, updatedAt: new Date(NOW - 30 * HOUR) }),
      ],
    });
    const res = await h.svc.lagging({ hours: 24, now: NOW });

    // 关键：`new Date('x').toISOString()` 会抛 RangeError —— 这里必须不抛。
    expect(res.items.map((i) => i.assignmentId)).toEqual([ASG_2]);
    expect(res.degraded).toBe(true);
  });

  it("空结果 ⇒ items 空 / total 0 / degraded false（事实是零，不是读不到）", async () => {
    const h = harness({ assignments: [] });
    const res = await h.svc.lagging({ hours: 24, now: NOW });

    expect(res).toEqual({
      items: [],
      total: 0,
      returned: 0,
      truncated: false,
      degraded: false,
    });
    // 空集 ⇒ 不该发起批量查询（`In([])` 会退化成全表扫描）。
    expect(h.calls.sopTitles).toBe(0);
    expect(h.calls.escalations).toBe(0);
  });
});

describe("R286 · controller 薄路由（GET /sop/assignments/lagging）", () => {
  function controllerHarness(
    // `null` = 显式「服务缺席」（传 `undefined` 会命中默认参数，测不到缺席分支）。
    lag: Record<string, unknown> | null = {
      lagging: jest.fn(async () => ({
        items: [],
        total: 0,
        returned: 0,
        truncated: false,
        degraded: false,
      })),
    },
  ) {
    const ctl = new SopController(
      {} as never,
      {} as never,
      {} as never,
      undefined as never,
      lag as never,
    );
    return { ctl, lag };
  }

  it("hours 从 query 字符串转数字后透传", async () => {
    const { ctl, lag } = controllerHarness();
    await ctl.listLaggingAssignments("48");
    expect((lag as { lagging: jest.Mock }).lagging).toHaveBeenCalledWith({
      hours: 48,
    });
  });

  it("缺省 hours ⇒ undefined（由 service 回落默认，不在 controller 抄第二份默认）", async () => {
    const { ctl, lag } = controllerHarness();
    await ctl.listLaggingAssignments(undefined);
    expect((lag as { lagging: jest.Mock }).lagging).toHaveBeenCalledWith({
      hours: undefined,
    });
  });

  it("非法 hours（'abc'）⇒ NaN 透传，由 service 回落默认（不 400）", async () => {
    const { ctl, lag } = controllerHarness();
    await ctl.listLaggingAssignments("abc");
    const arg = (lag as { lagging: jest.Mock }).lagging.mock.calls[0][0] as {
      hours: number;
    };
    expect(Number.isNaN(arg.hours)).toBe(true);
  });

  it("服务缺席 ⇒ 503（不回 200 空信封）", async () => {
    const { ctl } = controllerHarness(null);
    const err = await ctl.listLaggingAssignments().catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as AppError).errorCode).toBe("DEPENDENCY_UNAVAILABLE");
  });

  it("既有 3 参 / 4 参装配仍然可用（@Optional 末位 —— 不让既有 spec 错位）", async () => {
    // 这就是「插在中间会让既有 spec 全线错位」的直接反证。
    const ctl3 = new SopController({} as never, {} as never, {} as never);
    expect(typeof ctl3.list).toBe("function");
    const err3 = await ctl3.listLaggingAssignments().catch((e) => e);
    expect((err3 as AppError).errorCode).toBe("DEPENDENCY_UNAVAILABLE");

    const ctl4 = new SopController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const err4 = await ctl4.listLaggingAssignments().catch((e) => e);
    expect((err4 as AppError).errorCode).toBe("DEPENDENCY_UNAVAILABLE");
  });

  /**
   * R286 · **装配层反证**：`total:null` 必须一路穿到 controller 的返回值。
   *
   * 上面那些 controller 用例把 `lagging()` 打了桩 —— 桩直接返回手写的
   * `total: null`，于是「controller 或装配层把 null 洗成 0」这一类缺陷**抓不到**
   * （R286 由前端切片 `fe-assignment-lag` 实测暴露：它的页面层用例 mock 了
   * `loadInbox` 返回值，反证只红了一条，补了端到端链路才红两条）。
   *
   * 本条把**真 service** 塞进真 controller：仓储失败 ⇒ service 产出
   * `total:null` ⇒ controller 原样返回。中间任何一层把它变成 `0`（`?? 0`、
   * `Number(total)`、`total || 0` 都算）都会立刻红。
   */
  it("装配层反证：仓储读失败 ⇒ 经真 service + 真 controller，total 仍是 null（不是 0）", async () => {
    const broken = harness({
      // ⚠️ 这里**必须**相对真时钟造夹具（`Date.now()`），不能用上面的固定 `NOW`：
      // 走 controller 就是走生产路径，service 内的 `now` 是真实 `Date.now()`。
      // 若夹具锚在 `NOW`（固定 2026-11-20），那么一旦在**早于**该时刻的机器上
      // 跑（CI 时钟、回拨的容器、本地改过系统时间），`updatedAt = NOW-30h`
      // 会落在"未来" ⇒ 不满足 `updatedAt <= now - 24h` ⇒ returned=0 ⇒ 假红。
      // 相对真时钟造 -30h ⇒ 无论机器时间是多少，它都恒在窗口外。
      assignments: [asg({ updatedAt: new Date(Date.now() - 30 * HOUR) })],
      failCount: true,
    });
    const ctl = new SopController(
      {} as never,
      {} as never,
      {} as never,
      undefined as never,
      broken.svc as never,
    );

    const res = await ctl.listLaggingAssignments("24");

    expect(res.total).toBeNull();
    expect(res.degraded).toBe(true);
    // 上面那条是本用例的全部价值：`toBeNull` 不会被 `toBe(0)` 通过。
    expect(res.total).not.toBe(0);
    expect(res.truncated).toBe(false);
    expect(res.returned).toBe(1);
  });

  /**
   * R286 · **窗口默认值的单一事实源**（切片 B 提的同类风险，在此钉住）。
   *
   * B 反馈它前端曾有「两个 24」：签名默认 `hours ?? 24` + 模块常量，常量一改
   * 方法就静默用旧窗口——而窗口是**筛选条件**，改了会改变「哪些工单出现在本节」
   * 且**不报错**。服务端这边的风险点是同形的：controller 若写
   * `hours: hours ? parseInt(hours, 10) : 24`，默认值就在两处（controller 字面量
   * + `LAG_HOURS_DEFAULT`）⇒ 改常量不生效、且没有任何测试会红。
   *
   * 本条把「controller **不抄**默认值」钉成断言：不传 `hours` 时透传的必须是
   * `undefined`（让 service 唯一决定窗口），而不是任何具体数字。
   */
  it("窗口默认值只有一处：controller 不传时透传 undefined，绝不自己填 24", async () => {
    const { ctl, lag } = controllerHarness();
    await ctl.listLaggingAssignments(undefined);

    const arg = (lag as { lagging: jest.Mock }).lagging.mock.calls[0][0] as {
      hours?: number;
    };
    expect(arg.hours).toBeUndefined();
    // 直接反证「抄了一份默认值」这个具体写法：
    expect(arg.hours).not.toBe(LAG_HOURS_DEFAULT);
    expect(arg.hours).not.toBe(24);
  });
});
