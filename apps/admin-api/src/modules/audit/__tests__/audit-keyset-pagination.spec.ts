import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { AuditService } from "../audit.service";
import { AuditLog } from "../entities/audit-log.entity";
import { decodeNumericKeysetCursor } from "../../../common/utils/keyset-cursor.util";

/**
 * §2.1 游标分页 · **服务层**定向 spec（`GET /audit`）。
 *
 * 与 `all-executions-keyset-pagination.spec.ts`（全局执行列表）同构，钉三条
 * 验收线：
 *   ① 不带 cursor 的旧路径**逐字节等价**（键集合、JSON 形态、SQL 形态不变）；
 *   ② 带 cursor 的新路径**翻完 N 页不漏不重**（含同毫米不同微秒、id 与微秒反序）；
 *   ③ 非法游标一律 400，绝不静默退回第一页（那会造成翻页死循环）。
 *
 * 外加本端点独有的两条：
 *   ④ **过滤器单一真值源**——findAll / exportCsv / keyset 三条路径必须发出
 *      **同一组**谓词（改造前 action/resource/resourceId/userId 是在 findAll 与
 *      exportCsv 里各抄一份的，那是真实漂移源）；
 *   ⑤ **整型主键**——`audit_logs.id` 是 `integer`（实测 information_schema），
 *      故游标 id 段的判据是十进制正整数，不是 uuid 形状。
 *
 * ## 为什么用"内存表 + 真元组过滤"的假仓库
 *
 * 与同目录兄弟 spec 同因：只断言 `andWhere` 被调用过证明不了不漏不重——参数绑错、
 * 排序方向反了、决胜键写反，SQL 字符串都能看起来是对的。这里让假仓库真的按
 * `(createdAt DESC, id DESC)` 排序、真的执行
 * `(createdAt, id) < (cursorAt, cursorId)` 的字典序比较，于是"翻完所有页收集到的
 * id 集合 === 全量 id 集合且无重复"成为可判定的事实。
 */

/** 表里的行：只保留本端点会过滤/排序的列。 */
interface Row {
  /** `audit_logs.id` 是 integer（真库实测），不是 uuid。 */
  id: number;
  userId: number | null;
  username: string | null;
  action: string;
  resource: string | null;
  resourceId: string | null;
  result: string;
  ip: string | null;
  createdAt: Date;
  /**
   * 微秒分量（0–999）。真实列 `timestamp without time zone` 精度 6，实体读出来
   * 才截成毫秒；显式建模微秒才能复现"同毫秒但微秒不同"的漏行条件。
   */
  micro?: number;
}

/** 行的精确时间戳（毫秒 * 1000 + 微秒），用于有序比较。 */
const preciseMicros = (r: Row): number =>
  r.createdAt.getTime() * 1000 + (r.micro ?? 0);

/** `(createdAt, id) < (cursor.createdAt, cursor.id)`——行值比较（DESC 语义）。 */
const tupleLess = (a: Row, cursor: Row): boolean => {
  const ta = preciseMicros(a);
  const tc = preciseMicros(cursor);
  if (ta !== tc) return ta < tc;
  return a.id < cursor.id;
};

/** 字典序比较 `(createdAt 微秒, id)`：DESC 用正数表示 a 排在 b 前面。 */
const compareDesc = (a: Row, b: Row): number => {
  const t = preciseMicros(b) - preciseMicros(a);
  if (t !== 0) return t;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
};

const SAME_INSTANT = new Date("2026-01-02T03:04:05.123Z");

/**
 * 造一批行：5 条**完全相同**的 createdAt（专打决胜键）+ 4 条不同时刻的。
 *
 * id 的字典序与插入序**刻意相反**（真实序列主键递增；若按插入序递增，决胜键
 * 写反了也看不出来——这正是不漏不重用例能抓到的东西）。
 */
function makeRows(): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < 5; i++) {
    rows.push({
      // 递减：51, 50, 49, 48, 47
      id: 51 - i,
      userId: 1,
      username: "admin",
      action: "task.trigger",
      resource: "task",
      resourceId: "t-1",
      result: "success",
      ip: "10.0.0.1",
      createdAt: SAME_INSTANT,
    });
  }
  for (let i = 0; i < 4; i++) {
    rows.push({
      // 递增：1, 2, 3, 4（与时间倒序相反）
      id: i + 1,
      userId: 2,
      username: "operator",
      action: "user.update",
      resource: "user",
      resourceId: "u-9",
      result: i % 2 === 0 ? "success" : "failure",
      ip: "10.0.0.2",
      createdAt: new Date(SAME_INSTANT.getTime() - (i + 1) * 1000),
    });
  }
  return rows;
}

/** 假仓库 + 被记录下来的"最后一次查询形态"。 */
function makeAuditRepo(rowset: () => Row[]) {
  const state = {
    lastKeysetPredicate: null as string | null,
    lastKeysetParams: null as Record<string, unknown> | null,
    lastOrder: [] as Array<[string, string]>,
    lastFilters: [] as string[],
    lastFilterCalls: [] as Array<{ sql: string; params?: unknown }>,
    lastTake: null as number | null,
    lastSkip: null as number | null,
    countCalls: 0,
    // COUNT 发出时游标谓词是否已挂上（db-2：必须为 false，否则 total 是剩余条数）
    countSawCursorPredicate: null as boolean | null,
    getManyCalls: 0,
    getManyAndCountCalls: 0,
  };

  /**
   * 按 QueryBuilder 链上抓到的条件**真的**过滤 + 排序 + 取 N+1 行。
   *
   * ⚠️ 关键：按生产**实际发出的谓词形态**执行对应语义，而不是永远用正确的
   * 那一种（否则把生产改回毫秒半开区间时数据断言照样绿——mock 会比生产
   * "更正确"，ADR-008 的老坑）。
   */
  const runQuery = (
    filters: Record<string, unknown>,
    cursorParams: Record<string, unknown> | null,
    take: number | null,
    skip: number | null,
  ): Row[] => {
    const rows0 = rowset();
    let rows = rows0.filter((r) => {
      if (
        filters.action &&
        !String(r.action)
          .toLowerCase()
          .includes(String(filters.action).replace(/%/g, "").toLowerCase())
      ) {
        return false;
      }
      if (filters.resource && r.resource !== filters.resource) return false;
      if (filters.resourceId && r.resourceId !== filters.resourceId)
        return false;
      if (filters.userId !== undefined && r.userId !== filters.userId)
        return false;
      if (filters.result && r.result !== filters.result) return false;
      if (
        filters.username &&
        !String(r.username ?? "")
          .toLowerCase()
          .includes(String(filters.username).replace(/%/g, "").toLowerCase())
      ) {
        return false;
      }
      if (
        filters.startTime &&
        preciseMicros(r) <
          new Date(filters.startTime as string).getTime() * 1000
      )
        return false;
      if (
        filters.endTime &&
        preciseMicros(r) >
          new Date(filters.endTime as string).getTime() * 1000 + 999
      )
        return false;
      return true;
    });

    if (cursorParams) {
      const sql = state.lastKeysetPredicate ?? "";
      if (sql.includes(":atNext")) {
        // 毫秒半开区间形态（已证伪的旧写法）：按毫秒桶比较，微秒被忽略
        const at = new Date(cursorParams.at as string | Date).getTime();
        const atNext = new Date(cursorParams.atNext as string | Date).getTime();
        const cursorId = Number(cursorParams.cursorId);
        rows = rows.filter((r) => {
          const t = r.createdAt.getTime();
          if (t < at) return true;
          if (t < atNext) return r.id < cursorId;
          return false;
        });
      } else {
        // 行值比较形态（现实现）：游标行按 id 从内存表取**精确**值
        // （等价于生产按主键的子查询）。不替生产做任何转换。
        const cursorRow = rows0.find(
          (r) => String(r.id) === String(cursorParams.cursorId),
        );
        // 游标行已被删除 → 行值比较得 NULL → WHERE 为假 → 空页
        rows = cursorRow ? rows.filter((r) => tupleLess(r, cursorRow)) : [];
      }
    }

    rows = [...rows].sort(compareDesc);
    if (skip != null) rows = rows.slice(skip);
    return take == null ? rows : rows.slice(0, take);
  };

  const filters: Record<string, unknown> = {};

  /**
   * 过滤条件一律经 andWhere("… = :key", {key}) 下发；这里按参数键归类。
   * 同时把**原始调用**记进 lastFilterCalls——过滤真值源用例要逐条比对
   * `(sql, params)` 序列，而不是只看聚合后的 filters 对象。
   */
  const absorbFilter = (
    sql: string,
    params: Record<string, unknown> | undefined,
  ): void => {
    state.lastFilters.push(sql);
    state.lastFilterCalls.push({ sql, params });
    if (!params) return;
    for (const key of [
      "action",
      "resource",
      "resourceId",
      "userId",
      "result",
      "username",
      "startTime",
      "endTime",
    ]) {
      if (key in params) {
        // startTime/endTime 在生产里是 Date 对象（new Date(...) 绑定）——
        // 这里统一化成 ISO 串，供 runQuery 按时间比较。
        const v = params[key];
        filters[key] = v instanceof Date ? v.toISOString() : v;
      }
    }
  };

  const makeQb = () => {
    let cursorParams: Record<string, unknown> | null = null;
    let take: number | null = null;
    let skip: number | null = null;
    const qb: any = {
      orderBy: jest.fn((col: string, dir: string) => {
        state.lastOrder = [[col, dir]];
        return qb;
      }),
      addOrderBy: jest.fn((col: string, dir: string) => {
        state.lastOrder = [...state.lastOrder, [col, dir]];
        return qb;
      }),
      select: jest.fn(() => qb),
      addSelect: jest.fn(() => qb),
      limit: jest.fn(() => qb),
      skip: jest.fn((n: number) => {
        skip = n;
        state.lastSkip = n;
        return qb;
      }),
      take: jest.fn((n: number) => {
        take = n;
        state.lastTake = n;
        return qb;
      }),
      where: jest.fn((sql: string, params: Record<string, unknown>) => {
        absorbFilter(sql, params);
        return qb;
      }),
      andWhere: jest.fn((sql: string, params: Record<string, unknown>) => {
        // 游标谓词识别：行值比较只带 cursorId；毫秒区间会带 at/atNext。
        if (params && "cursorId" in params) {
          cursorParams = params;
          state.lastKeysetPredicate = sql;
          state.lastKeysetParams = params;
          return qb;
        }
        absorbFilter(sql, params);
        return qb;
      }),
      getMany: jest.fn(async () => {
        state.getManyCalls += 1;
        return runQuery(filters, cursorParams, take, skip);
      }),
      // total 语义：**调用 getCount 那一刻 qb 上已有的 WHERE** 全部生效，只忽略
      // 分页（skip/take）。
      //
      // ⚠️ 这里刻意传 `cursorParams` 而不是 `null`：typeorm 1.1.2 的
      // `executeCountQuery` 只剥 order/skip/take，**WHERE 原样保留**
      // （SelectQueryBuilder.js:1856）。桩若恒按"无游标条件"计数，就等于替生产
      // 实现了一种它并没有的正确性——生产改成"先 andWhere(游标) 再 getCount"时
      // （算出来是**剩余条数**）用例照样全绿。这是 ADR-008 记过的
      // "mock 比生产更正确" 老坑，故此处按**实际已装配的谓词**计数。
      getCount: jest.fn(async () => {
        state.countCalls += 1;
        // 记录"COUNT 发出时游标谓词是否已经挂上"——供顺序断言（游标谓词必须
        // 在 COUNT 之后才加，否则 total 会退化为剩余条数）。
        state.countSawCursorPredicate = cursorParams !== null;
        return runQuery(filters, cursorParams, null, null).length;
      }),
      // OFFSET 分支的取数入口（keyset 分支不得用它——由 getManyAndCountCalls
      // 计数断言）。
      getManyAndCount: jest.fn(async () => {
        state.getManyAndCountCalls += 1;
        return [
          runQuery(filters, null, take, skip),
          runQuery(filters, null, null, null).length,
        ];
      }),
      // exportCsv 的取数入口
      getRawMany: jest.fn(async () => {
        return runQuery(filters, null, take, skip).map((r) => ({
          ...r,
          createdAt: r.createdAt,
        }));
      }),
    };
    return qb;
  };

  const repo: any = {
    createQueryBuilder: jest.fn(() => makeQb()),
    create: jest.fn((d: unknown) => d),
    save: jest.fn((e: unknown) => Promise.resolve(e)),
    find: jest.fn(),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
  };

  const reset = () => {
    for (const k of Object.keys(filters)) delete filters[k];
    state.lastKeysetPredicate = null;
    state.lastKeysetParams = null;
    state.lastOrder = [];
    state.lastFilters = [];
    state.lastFilterCalls = [];
    state.lastTake = null;
    state.lastSkip = null;
    state.countCalls = 0;
    state.countSawCursorPredicate = null;
    state.getManyCalls = 0;
    state.getManyAndCountCalls = 0;
    repo.createQueryBuilder.mockClear();
  };

  return { repo, state, reset };
}

describe("§2.1 AuditService.findAll — OFFSET / keyset 双路径（GET /audit）", () => {
  let service: AuditService;
  let rowset: Row[];
  let repo: any;
  let state: ReturnType<typeof makeAuditRepo>["state"];
  let reset: ReturnType<typeof makeAuditRepo>["reset"];

  const build = async () => {
    const made = makeAuditRepo(() => rowset);
    repo = made.repo;
    state = made.state;
    reset = made.reset;
    const module = await Test.createTestingModule({
      providers: [
        AuditService,
        { provide: getRepositoryToken(AuditLog), useValue: repo },
        { provide: DataSource, useValue: { transaction: jest.fn() } },
      ],
    }).compile();
    service = module.get(AuditService);
  };

  beforeEach(async () => {
    rowset = makeRows();
    await build();
  });

  // ── ① 旧路径逐字节等价 ───────────────────────────────────────────────
  describe("不带 cursor：旧路径逐字节不变", () => {
    it("响应对象的键集合与改动前完全一致（**没有** nextCursor 键）", async () => {
      const res: any = await service.findAll({ page: 1, pageSize: 20 });

      // 逐键比对（顺序也钉住：{data,total} 是既有产物的一部分）
      expect(Object.keys(res)).toEqual(["data", "total"]);
      // 显式再钉一次"这个键不存在"——防止将来有人改成"恒下发 null"
      expect("nextCursor" in res).toBe(false);
      expect(res.nextCursor).toBeUndefined();
    });

    it("响应体经 JSON 序列化后与改动前逐字节一致（线上形态）", async () => {
      const res = await service.findAll({ page: 1, pageSize: 3 });
      // 手写一份"改动前的期望产物"再序列化比对，而不是只比键集合：
      // JSON 是四端真正看到的东西，undefined 值在那里会被整个丢掉，
      // 这正是旧路径能保持逐字节不变的机制。
      const expected = {
        data: res.data,
        total: 9,
      };
      expect(JSON.stringify(res)).toBe(JSON.stringify(expected));
      expect(JSON.stringify(res)).not.toContain("nextCursor");
    });

    it("total 语义不变（全量实数，不是当前页条数）", async () => {
      const res = await service.findAll({ page: 2, pageSize: 3 });
      expect(res.total).toBe(9);
      expect(res.data).toHaveLength(3);
      expect(res.data[0].id).toBe(51 - 3);
    });

    it("仍走 QueryBuilder + getManyAndCount（没被改名/换成 findAndCount）", async () => {
      await service.findAll({ page: 2, pageSize: 4 });
      expect(repo.createQueryBuilder).toHaveBeenCalledTimes(1);
      const qb = repo.createQueryBuilder.mock.results[0].value;
      expect(qb.skip).toHaveBeenCalledWith(4);
      expect(qb.take).toHaveBeenCalledWith(4);
      // A-8 决胜键：createdAt DESC, id DESC
      expect(state.lastOrder).toEqual([
        ["log.createdAt", "DESC"],
        ["log.id", "DESC"],
      ]);
      // 旧路径的 total 来自 getManyAndCount，不额外发 COUNT
      expect(qb.getManyAndCount).toHaveBeenCalledTimes(1);
      expect(state.countCalls).toBe(0);
    });

    it("pageSize 上限 100（Q12）在旧路径仍生效", async () => {
      await service.findAll({ pageSize: 9999 });
      const qb = repo.createQueryBuilder.mock.results[0].value;
      expect(qb.take).toHaveBeenCalledWith(100);
    });
  });

  // ── ② 新路径翻完 N 页不漏不重 ────────────────────────────────────────
  describe("带 cursor：keyset 翻页不漏不重", () => {
    /** 从第一页一路翻到底，返回收集到的 id 序列与页数。 */
    const walkAllPages = async (
      pageSize: number,
      filters: Record<string, unknown> = {},
    ) => {
      const collected: number[] = [];
      // 首次请求用**空串游标**进入 keyset 模式（OFFSET 分支按设计不下发
      // nextCursor，故空串就是官方引导入口）。
      let cursor: string | null = "";
      let pages = 0;
      for (;;) {
        const res: any = await service.findAll({
          page: 1,
          pageSize,
          ...filters,
          cursor: cursor as string,
        } as never);
        pages++;
        expect(res.data.length).toBeLessThanOrEqual(pageSize);
        collected.push(...res.data.map((r: Row) => r.id));
        cursor = res.nextCursor;
        expect(
          typeof res.nextCursor === "string" || res.nextCursor === null,
        ).toBe(true);
        if (cursor === null) break;
        // 防御：游标必须能解码（坏游标会让下面的断言变成空转）
        expect(decodeNumericKeysetCursor(cursor!).createdAt).toBeTruthy();
        expect(pages).toBeLessThan(50); // 死循环保险
      }
      return { collected, pages };
    };

    it("keyset 入口（空串）与 OFFSET 首页返回**同一批行**（两种模式结果一致）", async () => {
      const offset: any = await service.findAll({ page: 1, pageSize: 3 });
      const keyset: any = await service.findAll({
        page: 1,
        pageSize: 3,
        cursor: "",
      });
      // 这是"过渡期两种模式共存"必须成立的性质：同一个"第一页"语义。
      expect(keyset.data.map((r: Row) => r.id)).toEqual(
        offset.data.map((r: Row) => r.id),
      );
      expect(keyset.total).toBe(offset.total);
    });

    it("pageSize=2 翻完全部页：恰好覆盖 9 条，无重复、无遗漏", async () => {
      const { collected } = await walkAllPages(2);
      const expected = [...rowset].sort(compareDesc).map((r) => r.id);

      expect(collected).toHaveLength(expected.length);
      expect(new Set(collected).size).toBe(collected.length); // 无重复
      expect(collected).toEqual(expected); // 顺序正确且无遗漏
    });

    it("同一 createdAt 的 5 条被跨页切开时也不漏不重（决胜键生效）", async () => {
      // pageSize=3 会把这 5 条同一时刻的行切成 2+2+1，横跨三页（加上 4 条
      // 不同时刻的共 9 条）——单键排序在这里必然重复返回或跳过。
      const { collected } = await walkAllPages(3);
      const sameInstant = rowset.filter(
        (r) => r.createdAt.getTime() === SAME_INSTANT.getTime(),
      );
      expect(sameInstant).toHaveLength(5);
      for (const row of sameInstant) {
        expect(collected.filter((id) => id === row.id)).toHaveLength(1);
      }
      expect(new Set(collected).size).toBe(collected.length);
    });

    it("pageSize=1 逐条翻：页数 === 行数，每页恰好 1 条", async () => {
      const { collected, pages } = await walkAllPages(1);
      expect(collected).toHaveLength(9);
      expect(pages).toBe(9);
    });

    it("末页 nextCursor 为 null，且该键**出现**（与 OFFSET 分支的「键不存在」相对）", async () => {
      const single: any = await service.findAll({ page: 1, pageSize: 100 });
      expect("nextCursor" in single).toBe(false); // OFFSET 分支

      let last: any = await service.findAll({
        page: 1,
        pageSize: 2,
        cursor: "",
      });
      let guard = 0;
      while (last.nextCursor !== null && guard++ < 50) {
        last = await service.findAll({
          page: 1,
          pageSize: 2,
          cursor: last.nextCursor,
        });
      }
      expect(last.nextCursor).toBeNull();
      expect("nextCursor" in last).toBe(true);
    });

    it("keyset 分支的 total 仍是**真实总数**（同过滤条件，不受游标影响）", async () => {
      const first: any = await service.findAll({
        page: 1,
        pageSize: 2,
        cursor: "",
      });
      const second: any = await service.findAll({
        page: 1,
        pageSize: 2,
        cursor: first.nextCursor,
      });
      // 9 条全量，与第一页一致——不是"剩余条数"、也不是 -1
      expect(second.total).toBe(9);
      expect(second.total).toBe(first.total);
    });

    it("多取一行用 getCount 取 total（不调用 getManyAndCount）", async () => {
      await service.findAll({ page: 1, pageSize: 2, cursor: "" });
      const qb = repo.createQueryBuilder.mock.results[0].value;
      expect(qb.getManyAndCount).not.toHaveBeenCalled();
      expect(state.getManyCalls).toBe(1);
      expect(state.countCalls).toBe(1);
      // 页查询真的多取了一行（hasMore 判定）
      expect(state.lastTake).toBe(3);
    });

    // db-2（第 3 轮 db 审计残差）：COUNT 必须在**加游标谓词之前**发出。
    //
    // 生产的旧写法是先 `andWhere("(createdAt, id) < (…)")` 再 `getCount()`，
    // 而 typeorm 的 COUNT 只剥 order/skip/take、**保留 WHERE**——于是 total 是
    // "剩余条数"，每翻一页掉一页的量。单测长期没抓住它，是因为 getCount 桩恒按
    // "无游标条件"计数（mock 比生产更正确）。此用例同时钉住数据与调用时序。
    it("db-2: 游标翻页 total 恒定（COUNT 不受游标下界影响，逐页不递减）", async () => {
      let page: any = await service.findAll({
        page: 1,
        pageSize: 2,
        cursor: "",
      });
      const totals = [page.total];
      const seenIds = new Set<number>(page.data.map((r: any) => r.id));
      let guard = 0;
      while (page.nextCursor !== null && guard++ < 50) {
        page = await service.findAll({
          page: 1,
          pageSize: 2,
          cursor: page.nextCursor,
        });
        totals.push(page.total);
        for (const r of page.data) {
          // 顺带钉住"翻页无重复"（total 与分页无关，但同一条链上一并守）
          expect(seenIds.has(r.id)).toBe(false);
          seenIds.add(r.id);
        }
      }
      // 9 条全量：每一页的 total 都必须还是 9
      expect(totals).toEqual(totals.map(() => 9));
      // 且最后一次 COUNT 发出时，游标谓词尚未挂上（顺序断言）
      expect(state.countSawCursorPredicate).toBe(false);
    });

    it("SQL 谓词是**行值比较**形态（不是毫秒半开区间——那版在微秒打平时漏/重）", async () => {
      const first: any = await service.findAll({
        page: 1,
        pageSize: 2,
        cursor: "",
      });
      await service.findAll({
        page: 1,
        pageSize: 2,
        cursor: first.nextCursor,
      });
      const predicate = state.lastKeysetPredicate as string;
      expect(predicate).toBeTruthy();
      // 必须是行值比较：(log."createdAt", log.id) < (子查询取游标行的精确值)
      expect(predicate).toMatch(
        /\(\s*log\.\"?createdAt\"?\s*,\s*log\.id\s*\)\s*</,
      );
      expect(predicate).toContain("SELECT");
      expect(predicate).toContain("FROM audit_logs c");
      // 参数只有游标行 id（时间由子查询从库里取，不再由 JS 传入）
      const params = state.lastKeysetParams as Record<string, unknown>;
      expect(params.cursorId).toBe(String(first.data[1].id)); // 上一页最后一行
      // ⚠️ 反面断言：绝不能再出现毫秒区间那套（`< :at` / `:atNext`）
      expect(predicate).not.toContain(":atNext");
      expect(params.at).toBeUndefined();
      expect(params.atNext).toBeUndefined();
    });

    /**
     * ⚠️ 微秒打平 + id 反序的回归防线。
     *
     * 本用例的数据构造是**唯一**能暴露"毫秒半开区间"缺陷的形状（已在本机真 PG
     * 上实测确认：同一组数据下 `(createdAt, id) < (SELECT …)` 返回 `[4]`，
     * 而 `< :at OR (… AND id < :cursorId)` 返回 `[1, 2]`）。
     *
     * 4 行同一毫秒、微秒**递减**、id **递增**（时间上更早的行 id 更大）：
     *   id=1 微秒 .000900  ← 最早
     *   id=2 微秒 .000800
     *   id=3 微秒 .000700  ← 游标行
     *   id=4 微秒 .000600  ← 时间上在游标之后
     *
     * 半开区间：`createdAt < at`（.000，无行命中）OR `createdAt < atNext AND
     * id < 3` ⇒ 命中 id=1,2 ——**既漏掉 4，又返回了游标之前的 1、2**。
     */
    it("同毫秒不同微秒、且 id 与微秒**反序**时不漏不重（半开区间在此必漏）", async () => {
      const ms = new Date("2026-05-06T07:08:09.000Z");
      rowset = [
        { micro: 900, id: 1 },
        { micro: 800, id: 2 },
        { micro: 700, id: 3 },
        { micro: 600, id: 4 },
      ].map(({ micro, id }) => ({
        id,
        userId: 1,
        username: "admin",
        action: "same-ms",
        resource: "task",
        resourceId: `t-${id}`,
        result: "success",
        ip: "10.0.0.1",
        createdAt: ms,
        micro,
      }));
      await build();

      const collected: number[] = [];
      let cursor: string | null = "";
      let pages = 0;
      for (;;) {
        const res: any = await service.findAll({
          page: 1,
          pageSize: 1, // 每页 1 条 → 每行都要单独跨一次游标
          cursor: cursor as string,
        });
        pages++;
        collected.push(...res.data.map((r: Row) => r.id));
        cursor = res.nextCursor;
        if (cursor === null) break;
        expect(pages).toBeLessThan(20);
      }

      // 时间倒序：微秒大在前 ⇒ 1, 2, 3, 4
      expect(collected).toEqual([1, 2, 3, 4]);
      expect(new Set(collected).size).toBe(collected.length);
      expect(collected).toHaveLength(4);
    });

    it("游标行被删除 → 返回空页 + nextCursor: null（已知且有意）", async () => {
      const first: any = await service.findAll({
        page: 1,
        pageSize: 2,
        cursor: "",
      });
      const cursorId = first.data[1].id;
      const cursor = first.nextCursor;
      // 删掉游标那一行（审计日志的 180 天 retention 会真删行）
      rowset = rowset.filter((r) => r.id !== cursorId);

      const res: any = await service.findAll({
        page: 1,
        pageSize: 2,
        cursor,
      });
      // 子查询无行 → 行值比较得 NULL → WHERE 为假 → 空页。这是**安全地提前
      // 结束**，不会错行/重复；客户端看到 nextCursor: null 即视为翻完。
      expect(res.data).toEqual([]);
      expect(res.nextCursor).toBeNull();
      expect("nextCursor" in res).toBe(true);
    });
  });

  // ── ③ 过滤器 × 游标：必须 AND 组合，且共用同一份装配 ──────────────────
  describe("八个过滤器与游标条件正确 AND 组合", () => {
    /** 逐条比对某条路径发出的 `andWhere` 序列。 */
    const captureFilterCalls = async (
      run: () => Promise<unknown>,
    ): Promise<Array<{ sql: string; params?: unknown }>> => {
      reset();
      await run();
      return [...state.lastFilterCalls];
    };

    it("action 过滤在 keyset 分支同样生效", async () => {
      const res: any = await service.findAll({
        page: 1,
        pageSize: 2,
        action: "user.update", // 只命中 4 条
        cursor: "",
      });
      expect(res.total).toBe(4);
      expect(res.data.every((r: Row) => r.action === "user.update")).toBe(true);
    });

    it("result 过滤在 keyset 分支同样生效", async () => {
      const res: any = await service.findAll({
        page: 1,
        pageSize: 20,
        result: "failure",
        cursor: "",
      });
      // 4 条 older-* 里 i=1,3 是 failure
      expect(res.total).toBe(2);
      expect(res.data.every((r: Row) => r.result === "failure")).toBe(true);
    });

    it("userId / resource / resourceId / username 在 keyset 分支同样生效", async () => {
      const byUser: any = await service.findAll({
        page: 1,
        pageSize: 20,
        userId: 1,
        cursor: "",
      });
      expect(byUser.total).toBe(5); // 5 条同刻行都是 userId=1

      // 假仓库的 filters 在多个 createQueryBuilder 之间累积（与真 QB 不同），
      // 每次子查询之间显式 reset，否则上一个 filter 会串到下一个断言里。
      reset();
      const byResource: any = await service.findAll({
        page: 1,
        pageSize: 20,
        resource: "user",
        cursor: "",
      });
      expect(byResource.total).toBe(4);

      reset();
      const byResourceId: any = await service.findAll({
        page: 1,
        pageSize: 20,
        resourceId: "t-1",
        cursor: "",
      });
      expect(byResourceId.total).toBe(5);

      reset();
      const byUsername: any = await service.findAll({
        page: 1,
        pageSize: 20,
        username: "opera",
        cursor: "",
      });
      expect(byUsername.total).toBe(4);
    });

    it("startTime/endTime 时间范围在 keyset 分支同样生效（与游标条件是 AND）", async () => {
      const res: any = await service.findAll({
        page: 1,
        pageSize: 20,
        // 只保留 5 条同刻行
        startTime: "2026-01-02T03:04:05.000Z",
        endTime: "2026-01-02T03:04:05.999Z",
        cursor: "",
      });
      expect(res.total).toBe(5);
      expect(
        res.data.every(
          (r: Row) => r.createdAt.getTime() === SAME_INSTANT.getTime(),
        ),
      ).toBe(true);
    });

    it("过滤器 + 游标组合时，翻页不漏不重（AND 而非覆盖）", async () => {
      const collected: number[] = [];
      let cursor: string | null = "";
      let pages = 0;
      for (;;) {
        const res: any = await service.findAll({
          page: 1,
          pageSize: 2,
          resource: "user",
          cursor: cursor as string,
        });
        pages++;
        expect(res.data.every((r: Row) => r.resource === "user")).toBe(true);
        expect(res.total).toBe(4); // 恒为该过滤下的总数
        collected.push(...res.data.map((r: Row) => r.id));
        cursor = res.nextCursor;
        if (cursor === null) break;
        expect(pages).toBeLessThan(20);
      }
      const expected = rowset
        .filter((r) => r.resource === "user")
        .sort(compareDesc)
        .map((r) => r.id);
      expect(collected).toEqual(expected);
      expect(new Set(collected).size).toBe(collected.length);
    });

    /**
     * 单一真值源守卫（本 spec 最有价值的一条）。
     *
     * 改造前 action/resource/resourceId/userId 四条谓词在 findAll 与 exportCsv 里
     * **各写了一份**（逐字复制）。这条用例把"三条路径发出同一组谓词"变成可断言
     * 的事实：一旦有人再复制一份并只改一处，下面三个序列就会不同。
     */
    it("findAll / keyset / exportCsv 三条路径发出**同一组**过滤谓词（单一真值源）", async () => {
      const params = {
        action: "task.create",
        resource: "task",
        resourceId: "t-42",
        userId: 7,
        result: "success" as const,
        username: "admin",
        startTime: "2026-01-01T00:00:00.000Z",
        endTime: "2026-12-31T23:59:59.000Z",
      };

      const offsetCalls = await captureFilterCalls(() =>
        service.findAll({ page: 1, pageSize: 5, ...params }),
      );
      const keysetCalls = await captureFilterCalls(() =>
        service.findAll({ page: 1, pageSize: 5, ...params, cursor: "" }),
      );
      const exportCalls = await captureFilterCalls(() =>
        service.exportCsv(params),
      );

      // 有齿校验：确实装配了 8 个过滤器（少一个说明某条件根本没下发）
      expect(offsetCalls).toHaveLength(8);
      // 逐条比对 `(sql, params)`——不只是数量，连绑定值也必须一致
      expect(keysetCalls).toEqual(offsetCalls);
      expect(exportCalls).toEqual(offsetCalls);
    });

    it("旧路径：无过滤参数时不发任何 andWhere", async () => {
      const calls = await captureFilterCalls(() => service.findAll({}));
      expect(calls).toEqual([]);
    });

    it("API-09 的 LIKE 转义在三条路径上逐字相同（`_`/`%` 按字面量）", async () => {
      const params = { action: "a_b%c", username: "z_s" };
      const offsetCalls = await captureFilterCalls(() =>
        service.findAll(params),
      );
      const keysetCalls = await captureFilterCalls(() =>
        service.findAll({ ...params, cursor: "" }),
      );
      const exportCalls = await captureFilterCalls(() =>
        service.exportCsv(params),
      );
      expect(offsetCalls).toEqual(keysetCalls);
      expect(exportCalls).toEqual(offsetCalls);
      expect(offsetCalls.map((c) => c.params)).toEqual([
        { action: "%a\\_b\\%c%" },
        { username: "%z\\_s%" },
      ]);
    });
  });

  // ── ④ 非法游标 400，绝不静默退回第一页 ────────────────────────────────
  describe("非法 cursor：一律 400，绝不静默从第一页开始", () => {
    const expectBadRequest = async (cursor: string) => {
      let caught: unknown;
      try {
        await service.findAll({ page: 1, pageSize: 2, cursor });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      const err = caught as BadRequestException & { errorCode?: string };
      // 与另三个端点同码同文案：调用方只需实现一次处理逻辑
      expect(err.errorCode).toBe("VALIDATION_FAILED");
      const body = err.getResponse() as { params?: { detail?: string } };
      expect(body.params?.detail).toContain("游标");
      // 关键：**没有**降级去查数据（降级正是死循环的入口）
      expect(repo.createQueryBuilder).not.toHaveBeenCalled();
    };

    it("乱码", () => expectBadRequest("not-a-cursor"));
    it("合法 base64 但内容不对", () =>
      expectBadRequest(Buffer.from("hello", "utf8").toString("base64url")));
    it("时间不合法", () =>
      expectBadRequest(
        Buffer.from("2026-02-30T03:04:05.123Z|42", "utf8").toString(
          "base64url",
        ),
      ));

    // 整型主键的判据比 uuid 形状窄：下面这些 PG 都能解析成合法数值，
    // 但接受它们会让"同一行两个游标串"成为可能（01 vs 1）或引入歧义
    // （1e3 / +1 / -1）。一律 400。
    it.each([
      [
        "uuid 形状（错表主键）",
        "2026-01-02T03:04:05.123Z|6f1c2a9e-1111-4222-8333-444455556666",
      ],
      ["前导零", "2026-01-02T03:04:05.123Z|01"],
      ["零", "2026-01-02T03:04:05.123Z|0"],
      ["负数", "2026-01-02T03:04:05.123Z|-1"],
      ["正号", "2026-01-02T03:04:05.123Z|+1"],
      ["科学计数", "2026-01-02T03:04:05.123Z|1e3"],
      ["小数", "2026-01-02T03:04:05.123Z|1.0"],
      ["前导空白", "2026-01-02T03:04:05.123Z| 1"],
      ["注入串", "2026-01-02T03:04:05.123Z|1; DROP TABLE audit_logs; --"],
      ["空 id 段", "2026-01-02T03:04:05.123Z|"],
    ])("id 段非法（%s）→ 400", (_label: string, payload: string) => {
      return expectBadRequest(
        Buffer.from(payload, "utf8").toString("base64url"),
      );
    });
  });
});
