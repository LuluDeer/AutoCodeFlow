/**
 * R280 · S1 聚合读面的**判据钉子**（单测级）。
 *
 * 逐条对应 brief §五 的 S1 验收：① `escalated_to_human` 计入、`resolution IS NULL`
 * **不计**；② `completed` / `cancelled` **不计**，而 **`failed` 要计**（执行器用
 * `failed + outcome=escalated_to_human` 表达「请在 Admin Web 处理后重派」——
 * 排除它会让这条升级在任何地方都不可见，见 service 常量注释）；
 * ③ 仓储抛错 ⇒ `total: null` + `degraded`（**不允许 0**）；④ `sopName` 读不到 ⇒
 * `null` 不退回 uuid；⑤ `limit` 越界钳制；⑥ 装配缺失 ⇒ 503。
 *
 * 另钉三条契约细节（都是本仓踩过的形态）：
 *  · `total` 必须来自**独立 `getCount()`**：`find` 的长度只是 `returned`，
 *    把两者混同会让「被 limit 截断」与「一共就这么多」同形；
 *  · `truncated` 在 `total === null` 时只能是 false（「未知」由 `degraded` 表达）；
 *  · SOP 标题用**一次** `In(...)` 批量取（N+1 的反证：SOP 数从 1 变 3，查询次数不变）。
 */
import { ServiceUnavailableException } from "@nestjs/common";

import {
  SopClarificationInboxService,
  clampPendingClarificationLimit,
  SOP_PENDING_CLARIFICATION_LIMIT_DEFAULT,
  SOP_PENDING_CLARIFICATION_LIMIT_MAX,
} from "../sop-clarification-inbox.service";
import { AppError } from "../../../common/errors/app-error";
import type { SopAssignment } from "../entities/sop-assignment.entity";
import type { SopClarification } from "../entities/sop-clarification.entity";
import { SopController } from "../sop.controller";

const CLAR_1 = "c1111111-1111-4111-8111-111111111111";
const CLAR_2 = "c2222222-2222-4222-8222-222222222222";
const CLAR_3 = "c3333333-3333-4333-8333-333333333333";
const ASG_1 = "a1111111-1111-4111-8111-111111111111";
const ASG_2 = "a2222222-2222-4222-8222-222222222222";
const ASG_3 = "a3333333-3333-4333-8333-333333333333";
const SOP_1 = "51111111-1111-4111-8111-111111111111";
const SOP_2 = "52222222-2222-4222-8222-222222222222";

function clar(over: Partial<SopClarification> = {}): SopClarification {
  return {
    id: CLAR_1,
    clientClarificationId: null,
    assignmentId: ASG_1,
    round: 2,
    question: "这一步的验收命令找不到 artifacts 目录，怎么办？",
    questionContextJson: null,
    answer: null,
    resolution: "escalated_to_human",
    newSopVersion: null,
    mediaRefsJson: null,
    reviewSessionId: null,
    createdAt: new Date("2026-11-19T01:00:00.000Z"),
    updatedAt: new Date("2026-11-19T01:00:00.000Z"),
    ...over,
  } as SopClarification;
}

function asg(over: Partial<SopAssignment> = {}): SopAssignment {
  return {
    id: ASG_1,
    sopId: SOP_1,
    status: "in_progress",
    ...over,
  } as SopAssignment;
}

/**
 * 假仓储：**逐个方法可注入失败**，且记录调用次数（N+1 的反证靠它）。
 *
 * `getCount()` 刻意与 `getMany()` **独立配置** —— 若被测代码把 `getMany().length`
 * 当 total，下面「total=7 / 返回 2 行」那条用例会立刻把它抓出来。
 *
 * `createQueryBuilder` 返回一条**记录 where/order/take** 的链式桩：谓词是本端点
 * 的全部价值所在（口径),故断言它比断言返回值更重要。
 */
function harness(
  opts: {
    clarifications?: SopClarification[];
    total?: number;
    assignments?: SopAssignment[];
    sops?: Array<{ id: string; title: string | null }>;
    fail?: Array<"items" | "count" | "assignments" | "sopTitles">;
    omit?: Array<"clarifications" | "assignments" | "sops">;
  } = {},
) {
  const fail = (key: string) => {
    if (opts.fail?.includes(key as never)) throw new Error(`${key} down`);
  };

  const calls = { qb: 0, assignments: 0, sopTitles: 0 };
  /** 每次 `createQueryBuilder` 的链式调用记录（断言谓词用）。 */
  const qbLog: Array<Record<string, unknown>> = [];

  function makeQb(kind: "items" | "count") {
    const log: Record<string, unknown> = { kind };
    qbLog.push(log);
    const qb = {
      innerJoin: jest.fn((...args: unknown[]) => {
        log.innerJoin = args;
        return qb;
      }),
      where: jest.fn((...args: unknown[]) => {
        log.where = args;
        return qb;
      }),
      andWhere: jest.fn((...args: unknown[]) => {
        log.andWhere = args;
        return qb;
      }),
      orderBy: jest.fn((...args: unknown[]) => {
        log.orderBy = args;
        return qb;
      }),
      take: jest.fn((...args: unknown[]) => {
        log.take = args;
        return qb;
      }),
      getMany: jest.fn(async () => {
        fail("items");
        return opts.clarifications ?? [];
      }),
      getCount: jest.fn(async () => {
        fail("count");
        // ⚠️ 默认回**与 rows 不等**的数：任何「把 rows.length 当 total」的实现
        // 都会在这条默认值上露馅。
        return opts.total ?? 0;
      }),
    };
    return qb;
  }

  const clarifications = {
    createQueryBuilder: jest.fn(() => {
      calls.qb += 1;
      // 第一段是 items，第二段是 count —— 与 `Promise.all` 的发射顺序一致；
      // 用「上一次是否已经是 items」来分桶，避免依赖固定调用序。
      return makeQb(qbLog.length % 2 === 0 ? "items" : "count");
    }),
    // 若实现退回 `find().length`，这两个方法会被调用 —— 记录下来用作反证。
    find: jest.fn(async () => opts.clarifications ?? []),
    count: jest.fn(async () => opts.total ?? 0),
  };

  const assignments = {
    find: jest.fn(async () => {
      calls.assignments += 1;
      fail("assignments");
      return opts.assignments ?? [];
    }),
  };

  const sops = {
    find: jest.fn(async () => {
      calls.sopTitles += 1;
      fail("sopTitles");
      return opts.sops ?? [];
    }),
  };

  const svc = new SopClarificationInboxService(
    opts.omit?.includes("clarifications")
      ? (undefined as never)
      : (clarifications as never),
    opts.omit?.includes("assignments")
      ? (undefined as never)
      : (assignments as never),
    opts.omit?.includes("sops") ? (undefined as never) : (sops as never),
  );

  return { svc, clarifications, assignments, sops, calls, qbLog };
}

describe("R280 · 待答复澄清口径（GET /sop/clarifications/pending）", () => {
  it("① 升级行计入；谓词 = resolution=escalated_to_human AND 非(completed/cancelled)（不是 blocked）", async () => {
    const h = harness({
      clarifications: [clar()],
      total: 1,
      assignments: [asg()],
      sops: [{ id: SOP_1, title: "日报生成" }],
    });

    const res = await h.svc.pending();

    expect(res.items).toHaveLength(1);
    expect(res.items[0].clarificationId).toBe(CLAR_1);
    expect(res.total).toBe(1);
    expect(res.degraded).toBe(false);

    // 谓词断言：**升级态** + **终态排除**，且终态集合逐字为三项。
    const itemsLog = h.qbLog.find((l) => l.kind === "items") as Record<
      string,
      unknown
    >;
    expect(itemsLog.where).toEqual([
      "c.resolution = :resolution",
      { resolution: "escalated_to_human" },
    ]);
    expect(itemsLog.andWhere).toEqual([
      "a.status NOT IN (:...nonPendingStatuses)",
      { nonPendingStatuses: ["completed", "cancelled"] },
    ]);
  });

  it("①b 口径里**没有** resolution IS NULL（那是等机器答的，不是等人）", async () => {
    const h = harness({ clarifications: [], total: 0, assignments: [] });
    await h.svc.pending();

    for (const log of h.qbLog) {
      const whereText = String((log.where as unknown[])?.[0] ?? "");
      const andText = String((log.andWhere as unknown[])?.[0] ?? "");
      // `IS NULL` 出现在谓词里 ⇒ 会把「机器还没答」混进「要人上」。
      expect(`${whereText} ${andText}`).not.toMatch(/IS NULL/i);
    }
  });

  it("② `failed` **要计**（执行器的 failed 是「等人接管」，不是结束）", async () => {
    // 真机证据链：执行器在 agent-host.ts 收到 escalated_to_human 后主动回报
    // `status: 'failed'` + `outcome: 'escalated_to_human'`，stopMessage 写着
    // 「请在 Admin Web 处理后重派」⇒ 排除 failed 会让那个入口不存在。
    const h = harness({
      clarifications: [clar({ id: CLAR_1, assignmentId: ASG_1 })],
      total: 1,
      assignments: [asg({ id: ASG_1, status: "failed" })],
      sops: [{ id: SOP_1, title: "日报生成" }],
    });

    const res = await h.svc.pending();

    // ① 谓词里**不得**出现 failed（这是「翻转」的核心断言）。
    const predicate = (
      h.qbLog[0].andWhere as [string, { nonPendingStatuses: string[] }]
    )[1].nonPendingStatuses;
    expect(predicate).not.toContain("failed");
    // ② 行真的回出来了，且状态如实回填（不是 'blocked' / 'in_progress'）。
    expect(res.items).toHaveLength(1);
    expect(res.items[0].assignmentStatus).toBe("failed");
    expect(res.total).toBe(1);
  });

  it("②b `completed` / `cancelled` 仍不计（删 failed 没有连带放宽另外两项）", async () => {
    const h = harness({ clarifications: [], total: 0, assignments: [] });
    await h.svc.pending();

    const excluded = (
      h.qbLog[0].andWhere as [string, { nonPendingStatuses: string[] }]
    )[1].nonPendingStatuses;
    // 精确集合相等：既证明两项仍在，也证明**没有多塞**别的（比如 failed）。
    expect(excluded).toEqual(["completed", "cancelled"]);
    // `failed` / `stalled` / `blocked` / `assigned` / `in_progress` 全部**计入**。
    for (const status of [
      "failed",
      "stalled",
      "blocked",
      "in_progress",
      "assigned",
    ]) {
      expect(excluded).not.toContain(status);
    }
  });

  it("②c 排除**只在 SQL 谓词里做一次**（内存不再滤第二遍，否则 items 与 total 口径分叉）", async () => {
    // 为什么这样断言：`total` 是同一条 `baseQuery()` 的 `getCount()`。若 items
    // 取回后又按 status 在内存里滤一遍，就会出现「SQL 说 3、内存说 2」——total
    // 与 items 各自一个口径，正是 R278 修掉的那类缺陷。
    //
    // ⇒ 排除的**唯一**判据是 join 的 `andWhere`（①/②/②b 已逐字断言）；它真的在
    //   PG 上生效，由**真机验收**证明（真 PG 造五种状态各一条 ⇒ `total=3`）。
    const h = harness({
      clarifications: [clar({ id: CLAR_1, assignmentId: ASG_1 })],
      total: 1,
      // 假设 SQL 漏掉了排除（把已取消指派也返回）——实现必须**如实透出**，
      // 不在内存里偷偷修正（那种修正会让 items 与 total 分叉、且掩盖 SQL 缺陷）。
      assignments: [asg({ id: ASG_1, status: "cancelled" })],
      sops: [{ id: SOP_1, title: "日报生成" }],
    });

    const res = await h.svc.pending();
    expect(res.items).toHaveLength(1);
    // 如实回填（不是硬编码某个活跃态）。
    expect(res.items[0].assignmentStatus).toBe("cancelled");
    // 反证：指派仓储的查询里**没有** status 条件——排除不在这一层。
    const whereArg = (h.assignments.find as jest.Mock).mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(Object.keys(whereArg.where).sort()).toEqual(["id"]);
  });

  it("③ 计数读失败 ⇒ total:null + degraded:true，**绝不 0**", async () => {
    const h = harness({
      clarifications: [clar()],
      assignments: [asg()],
      sops: [{ id: SOP_1, title: "日报生成" }],
      fail: ["count"],
    });

    const res = await h.svc.pending();

    // 这是本轮最重要的一条：把读失败渲染成 0 会让运营以为没有升级在等人。
    expect(res.total).toBeNull();
    expect(res.total).not.toBe(0);
    expect(res.degraded).toBe(true);
    // total 未知 ⇒ truncated 只能 false（「未知」由 degraded 说）。
    expect(res.truncated).toBe(false);
    // 行本体照常返回（部分可用）。
    expect(res.items).toHaveLength(1);
  });

  it("③b 行读失败 ⇒ items 空但 total 仍有数（两个子查询各自独立降级）", async () => {
    const h = harness({
      total: 5,
      assignments: [],
      fail: ["items"],
    });

    const res = await h.svc.pending();

    expect(res.items).toEqual([]);
    expect(res.returned).toBe(0);
    expect(res.total).toBe(5);
    expect(res.degraded).toBe(true);
    // 5 比 0 大 ⇒ 真的被截断了（不是「一共就 0 条」）。
    expect(res.truncated).toBe(true);
  });

  it("③c SOP 标题读失败 ⇒ sopName:null + degraded，其它字段照常", async () => {
    const h = harness({
      clarifications: [clar()],
      total: 1,
      assignments: [asg()],
      fail: ["sopTitles"],
    });

    const res = await h.svc.pending();

    expect(res.items[0].sopName).toBeNull();
    expect(res.items[0].sopId).toBe(SOP_1);
    expect(res.degraded).toBe(true);
  });

  it("④ sopName 读不到（标题为空）⇒ null，**绝不退回 uuid**", async () => {
    const h = harness({
      clarifications: [clar()],
      total: 1,
      assignments: [asg()],
      sops: [{ id: SOP_1, title: "   " }],
    });

    const res = await h.svc.pending();

    expect(res.items[0].sopName).toBeNull();
    expect(res.items[0].sopName).not.toBe(SOP_1);
    expect(res.items[0].sopName).not.toBe(ASG_1);
  });

  it("④b SOP 行完全不存在 ⇒ sopName:null（不是空串、不是 uuid）", async () => {
    const h = harness({
      clarifications: [clar()],
      total: 1,
      assignments: [asg()],
      sops: [],
    });

    const res = await h.svc.pending();

    expect(res.items[0].sopName).toBeNull();
    // 查不到行 ≠ 读失败 ⇒ 不降级（判据能分辨这两种情况）。
    expect(res.degraded).toBe(false);
  });

  it("④c SOP 标题批量取：3 个 SOP 只发 1 次查询（N+1 反证）", async () => {
    const h = harness({
      clarifications: [
        clar({ id: CLAR_1, assignmentId: ASG_1 }),
        clar({ id: CLAR_2, assignmentId: ASG_2 }),
        clar({ id: CLAR_3, assignmentId: ASG_3 }),
      ],
      total: 3,
      assignments: [
        asg({ id: ASG_1, sopId: SOP_1 }),
        asg({ id: ASG_2, sopId: SOP_2 }),
        asg({ id: ASG_3, sopId: SOP_1 }),
      ],
      sops: [
        { id: SOP_1, title: "日报生成" },
        { id: SOP_2, title: "发布检查" },
      ],
    });

    const res = await h.svc.pending();

    expect(res.returned).toBe(3);
    // 三个 SOP id（去重后 2 个）只查一次。
    expect(h.calls.sopTitles).toBe(1);
    // 指派也只查一次（同样是 In(...) 批量）。
    expect(h.calls.assignments).toBe(1);
    expect(res.items[1].sopName).toBe("发布检查");
  });

  it("⑤ limit 钳制：越界到 200、负数到 1、NaN/Infinity 回落默认（不 400）", () => {
    expect(clampPendingClarificationLimit(undefined)).toBe(
      SOP_PENDING_CLARIFICATION_LIMIT_DEFAULT,
    );
    expect(clampPendingClarificationLimit(null)).toBe(
      SOP_PENDING_CLARIFICATION_LIMIT_DEFAULT,
    );
    expect(clampPendingClarificationLimit(Number.NaN)).toBe(
      SOP_PENDING_CLARIFICATION_LIMIT_DEFAULT,
    );
    expect(clampPendingClarificationLimit(Number.POSITIVE_INFINITY)).toBe(
      SOP_PENDING_CLARIFICATION_LIMIT_DEFAULT,
    );
    expect(clampPendingClarificationLimit(Number.NEGATIVE_INFINITY)).toBe(
      SOP_PENDING_CLARIFICATION_LIMIT_DEFAULT,
    );
    expect(clampPendingClarificationLimit(1000)).toBe(
      SOP_PENDING_CLARIFICATION_LIMIT_MAX,
    );
    expect(clampPendingClarificationLimit(-5)).toBe(1);
    expect(clampPendingClarificationLimit(0)).toBe(1);
    expect(clampPendingClarificationLimit(3.9)).toBe(3);
    expect(clampPendingClarificationLimit(37)).toBe(37);
    // 默认值与上限都必须与 brief 一致（1..200 / 默认 100）。
    expect(SOP_PENDING_CLARIFICATION_LIMIT_DEFAULT).toBe(100);
    expect(SOP_PENDING_CLARIFICATION_LIMIT_MAX).toBe(200);
  });

  it("⑤b limit 真的下推到 take（不是只在 DTO 里钳）", async () => {
    const h = harness({ clarifications: [], total: 0, assignments: [] });
    await h.svc.pending({ limit: 1000 });

    const itemsLog = h.qbLog.find((l) => l.kind === "items") as Record<
      string,
      unknown
    >;
    expect(itemsLog.take).toEqual([200]);
  });

  it("⑤c NaN limit 不炸、按默认值发查询（HTTP 层 parseInt('abc') 的形态）", async () => {
    const h = harness({ clarifications: [], total: 0, assignments: [] });
    const res = await h.svc.pending({ limit: Number.NaN });

    expect(res.returned).toBe(0);
    const itemsLog = h.qbLog.find((l) => l.kind === "items") as Record<
      string,
      unknown
    >;
    expect(itemsLog.take).toEqual([SOP_PENDING_CLARIFICATION_LIMIT_DEFAULT]);
  });

  it("⑥ 装配缺失 ⇒ 503 DEPENDENCY_UNAVAILABLE（不回 200 空信封）", async () => {
    const { svc } = harness({ omit: ["clarifications"] });

    // `AppError` 构造后把原型挂到内置异常类上（保住既有 `instanceof` 断言），
    // 故按 503 的内置类断言 + 用 `errorCode` 钉码（两件事都要）。
    const err = await svc.pending().catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as AppError).errorCode).toBe("DEPENDENCY_UNAVAILABLE");
    expect((err as AppError).getStatus()).toBe(503);
  });

  it("⑥b 三个仓储缺任一个都 ⇒ 503（不只是第一个）", async () => {
    for (const missing of ["clarifications", "assignments", "sops"] as const) {
      const { svc } = harness({ omit: [missing] });
      const err = await svc.pending().catch((e) => e);
      expect((err as AppError).errorCode).toBe("DEPENDENCY_UNAVAILABLE");
    }
  });

  it("⑦ total 来自独立 getCount()：total=7 / 返回 2 行 ⇒ truncated:true、returned:2", async () => {
    const h = harness({
      clarifications: [clar({ id: CLAR_1 }), clar({ id: CLAR_2 })],
      total: 7,
      assignments: [asg()],
      sops: [{ id: SOP_1, title: "日报生成" }],
    });

    const res = await h.svc.pending({ limit: 2 });

    expect(res.returned).toBe(2);
    expect(res.total).toBe(7);
    expect(res.truncated).toBe(true);
    // 反证：`find()` 与 `count()` 这两个「旧写法」必须**一次都没被调**——
    // 只有它们没被调，`getCount()` 才是 total 的唯一来源。
    expect(h.clarifications.find).not.toHaveBeenCalled();
    expect(h.clarifications.count).not.toHaveBeenCalled();
  });

  it("⑦b total === returned ⇒ truncated:false（「一共就这么多」与「被截断」不同形）", async () => {
    const h = harness({
      clarifications: [clar()],
      total: 1,
      assignments: [asg()],
      sops: [{ id: SOP_1, title: "日报生成" }],
    });

    const res = await h.svc.pending();
    expect(res.returned).toBe(1);
    expect(res.total).toBe(1);
    expect(res.truncated).toBe(false);
  });

  it("⑧ askedAt 是 ISO 字符串（不是 Date 对象）、round/reviewSessionId 原样透出", async () => {
    const h = harness({
      clarifications: [
        clar({
          createdAt: new Date("2026-11-19T01:02:03.000Z"),
          round: 4,
          reviewSessionId: "99999999-9999-4999-8999-999999999999",
        }),
      ],
      total: 1,
      assignments: [asg()],
      sops: [{ id: SOP_1, title: "日报生成" }],
    });

    const res = await h.svc.pending();

    expect(res.items[0].askedAt).toBe("2026-11-19T01:02:03.000Z");
    expect(res.items[0].round).toBe(4);
    expect(res.items[0].reviewSessionId).toBe(
      "99999999-9999-4999-8999-999999999999",
    );
  });

  it("⑨ question 原样透出（服务端不截断）", async () => {
    const long = "很长的疑问".repeat(200);
    const h = harness({
      clarifications: [clar({ question: long })],
      total: 1,
      assignments: [asg()],
      sops: [{ id: SOP_1, title: "日报生成" }],
    });

    const res = await h.svc.pending();

    // 截断是渲染决策；服务端截断会让「点开看全文」永远拿不到全文。
    expect(res.items[0].question).toBe(long);
  });

  it("⑩ 最久没人管的在前（createdAt ASC）", async () => {
    const h = harness({ clarifications: [], total: 0, assignments: [] });
    await h.svc.pending();

    const itemsLog = h.qbLog.find((l) => l.kind === "items") as Record<
      string,
      unknown
    >;
    // ⚠️ 属性路径（不是 `c."createdAt"`）：带 take() 的 getMany() 走
    // `distinctAlias` 重写，只认属性路径（真机实测过原生列名的失败形态）。
    expect(itemsLog.orderBy).toEqual(["c.createdAt", "ASC"]);
    // 计数查询不该带排序（ORDER BY 与 COUNT 同查是白花的排序成本）。
    const countLog = h.qbLog.find((l) => l.kind === "count") as Record<
      string,
      unknown
    >;
    expect(countLog.orderBy).toBeUndefined();
  });

  it("⑪ 空结果 ⇒ items:[]、total:0、truncated:false、degraded:false（事实为零，非未知）", async () => {
    const h = harness({ clarifications: [], total: 0, assignments: [] });

    const res = await h.svc.pending();

    expect(res).toEqual({
      items: [],
      total: 0,
      returned: 0,
      truncated: false,
      degraded: false,
    });
  });
});

describe("R280 · controller 薄路由（GET /sop/clarifications/pending）", () => {
  function controllerHarness(
    // `null` = 显式「服务缺席」（传 `undefined` 会命中默认参数，测不到缺席分支）。
    inbox: Record<string, unknown> | null = {
      pending: jest.fn(async () => ({
        items: [],
        total: 0,
        returned: 0,
        truncated: false,
        degraded: false,
      })),
    },
  ) {
    const sops = {};
    const media = {};
    const executors = {};
    const ctl = new SopController(
      sops as never,
      media as never,
      executors as never,
      inbox as never,
    );
    return { ctl, inbox };
  }

  it("limit 从 query 字符串转数字后透传（不转会把 '50' 当字符串塞进 take）", async () => {
    const { ctl, inbox } = controllerHarness();
    await ctl.listPendingClarifications("50");
    expect((inbox as { pending: jest.Mock }).pending).toHaveBeenCalledWith({
      limit: 50,
    });
  });

  it("缺省 limit ⇒ undefined（由 service 回落默认，不在 controller 抄第二份默认）", async () => {
    const { ctl, inbox } = controllerHarness();
    await ctl.listPendingClarifications(undefined);
    expect((inbox as { pending: jest.Mock }).pending).toHaveBeenCalledWith({
      limit: undefined,
    });
  });

  it("非法 limit（'abc'）⇒ NaN 透传，由 service 回落默认（不 400）", async () => {
    const { ctl, inbox } = controllerHarness();
    await ctl.listPendingClarifications("abc");
    const arg = (inbox as { pending: jest.Mock }).pending.mock.calls[0][0] as {
      limit: number;
    };
    expect(Number.isNaN(arg.limit)).toBe(true);
  });

  it("服务缺席 ⇒ 503（不回 200 空信封）", async () => {
    const { ctl } = controllerHarness(null);
    const err = await ctl.listPendingClarifications().catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as AppError).errorCode).toBe("DEPENDENCY_UNAVAILABLE");
  });

  it("既有 3 参装配仍然可用（@Optional 末位 —— 不让既有 spec 错位）", async () => {
    // 这就是「插在中间会让既有 spec 全线错位」的直接反证。
    const ctl = new SopController({} as never, {} as never, {} as never);
    expect(typeof ctl.list).toBe("function");
    const err = await ctl.listPendingClarifications().catch((e) => e);
    expect((err as AppError).errorCode).toBe("DEPENDENCY_UNAVAILABLE");
  });
});
