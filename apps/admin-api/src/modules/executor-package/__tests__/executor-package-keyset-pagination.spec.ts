import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { ExecutorPackageService } from "../executor-package.service";
import { ExecutorPackageController } from "../executor-package.controller";
import {
  ExecutorPackage,
  ExecutorPackageStatus,
  ExecutorPackageType,
} from "../executor-package.entity";
import { decodeKeysetCursor } from "../../../common/utils/keyset-cursor.util";
import fs from "fs";

/**
 * §2.1 游标分页 · **服务层**定向 spec（`GET /executor-packages`）。
 *
 * 与 `../../task/__tests__/all-executions-keyset-pagination.spec.ts` /
 * `../../audit/__tests__/audit-keyset-pagination.spec.ts` 同构，钉：
 *   ① 不带 cursor 的旧路径**逐字节等价**（键集合 `{items,total}`、JSON 形态、
 *      `findAndCount` + `order: {createdAt,id}` 的旧调用面都不变）；
 *   ② 带 cursor 的 keyset 分支**翻完 N 页不漏不重**（含同毫秒不同微秒、id 与
 *      微秒反序——唯一能暴露毫秒半开区间缺陷的构造）；
 *   ③ 非法游标一律 400，绝不静默退回第一页；
 *   ④ 过滤器单一真值源（OFFSET 与 keyset 发出同一组谓词）；
 *   ⑤ **响应形状**：本端点返回裸 `{items,total}`，**不是** paginate() 信封。
 *      keyset 分支只**追加** `nextCursor`，既有两键的名字/类型/顺序不变——这是
 *      加性纪律的核心，也是 admin-web 包表与安装向导能继续工作的前提。
 */

/**
 * 本 spec 既要 mock `fs`（服务构造函数会 mkdirSync/promises 探测上传目录），
 * 又要 mock `ExecutorService`（push 用，本端点用不到），与同目录
 * `executor-package.service.spec.ts` 同款 stub。
 */
jest.mock("fs", () => ({
  existsSync: jest.fn(() => true),
  mkdirSync: jest.fn(),
  createReadStream: jest.fn(),
  promises: {
    open: jest.fn(),
    stat: jest.fn(),
    rename: jest.fn(),
    readFile: jest.fn(),
    readdir: jest.fn().mockResolvedValue([]),
    unlink: jest.fn(),
    copyFile: jest.fn(),
  },
}));

/**
 * 与同目录 `executor-package.service.spec.ts` 同款：service 顶层 import 了
 * `ExecutorService`，而后者 import 了原生模块 `bcrypt`（本机无该平台的原生
 * 构建，实测直接 require 会抛 "No native build was found"）。本 spec 只测
 * 列表/游标，完全不碰推送面，故整体 mock 掉该模块。
 */
jest.mock("../../executor/executor.service", () => ({
  ExecutorService: jest.fn(),
}));

/** 表里的行：只保留本端点会过滤/排序的列。 */
interface Row {
  /** `executor_packages.id` 是 uuid（真库实测 `uuid_generate_v4()`）。 */
  id: string;
  name: string;
  version: string;
  type: ExecutorPackageType;
  platform: string | null;
  status: ExecutorPackageStatus;
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
 * id 的字典序与插入序**刻意相反**（真实 uuid 随机；若按插入序递增，决胜键
 * 写反了也看不出来）。
 */
function makeRows(): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < 5; i++) {
    rows.push({
      // 递减：ffffffff…004 … ffffffff…000
      id: `ffffffff-ffff-4fff-8fff-${String(4 - i).padStart(12, "0")}`,
      name: "acf-executor",
      version: "1.0.0",
      type: ExecutorPackageType.NODE,
      platform: "linux-x64",
      status: ExecutorPackageStatus.ACTIVE,
      createdAt: SAME_INSTANT,
    });
  }
  for (let i = 0; i < 4; i++) {
    rows.push({
      // 递增：00000000…000 … 00000000…003（与时间倒序相反）
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      name: "legacy-pkg",
      version: `0.${i}.0`,
      type: ExecutorPackageType.PYTHON,
      platform: "linux-arm64",
      status:
        i % 2 === 0
          ? ExecutorPackageStatus.ACTIVE
          : ExecutorPackageStatus.DEPRECATED,
      createdAt: new Date(SAME_INSTANT.getTime() - (i + 1) * 1000),
    });
  }
  return rows;
}

/** 假仓库 + 被记录下来的"最后一次查询形态"。 */
function makePkgRepo(rowset: () => Row[]) {
  const state = {
    lastKeysetPredicate: null as string | null,
    lastKeysetParams: null as Record<string, unknown> | null,
    lastOrder: [] as Array<[string, string]>,
    lastFilterCalls: [] as Array<{ sql: string; params?: unknown }>,
    lastTake: null as number | null,
    lastFindOptions: null as unknown,
    countCalls: 0,
    getManyCalls: 0,
    findAndCountCalls: 0,
  };

  /**
   * 按 QueryBuilder 链上抓到的条件**真的**过滤 + 排序 + 取 N+1 行。
   *
   * ⚠️ 按生产**实际发出的谓词形态**执行对应语义，而不是永远用正确的那一种
   * （否则把生产改回毫秒半开区间时数据断言照样绿——mock 会比生产"更正确"，
   * ADR-008 的老坑）。
   */
  const runQuery = (
    filters: Record<string, unknown>,
    cursorParams: Record<string, unknown> | null,
    take: number | null,
  ): Row[] => {
    const rows0 = rowset();
    let rows = rows0.filter((r) => {
      if (
        filters.name &&
        !r.name
          .toLowerCase()
          .includes(String(filters.name).replace(/%/g, "").toLowerCase())
      ) {
        return false;
      }
      if (filters.type && r.type !== filters.type) return false;
      if (filters.status && r.status !== filters.status) return false;
      if (filters.platform && r.platform !== filters.platform) return false;
      return true;
    });

    if (cursorParams) {
      const sql = state.lastKeysetPredicate ?? "";
      if (sql.includes(":atNext")) {
        // 毫秒半开区间形态（已证伪的旧写法）：按毫秒桶比较，微秒被忽略
        const at = new Date(cursorParams.at as string | Date).getTime();
        const atNext = new Date(cursorParams.atNext as string | Date).getTime();
        const cursorId = String(cursorParams.cursorId);
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
          (r) => r.id === String(cursorParams.cursorId),
        );
        // 游标行已被删除 → 行值比较得 NULL → WHERE 为假 → 空页
        rows = cursorRow ? rows.filter((r) => tupleLess(r, cursorRow)) : [];
      }
    }

    rows = [...rows].sort(compareDesc);
    return take == null ? rows : rows.slice(0, take);
  };

  const filters: Record<string, unknown> = {};

  const absorbFilter = (
    sql: string,
    params: Record<string, unknown> | undefined,
  ): void => {
    state.lastFilterCalls.push({ sql, params });
    if (!params) return;
    for (const key of ["name", "type", "status", "platform"]) {
      if (key in params) filters[key] = params[key];
    }
  };

  const makeQb = () => {
    let cursorParams: Record<string, unknown> | null = null;
    let take: number | null = null;
    const qb: any = {
      orderBy: jest.fn((col: string, dir: string) => {
        state.lastOrder = [[col, dir]];
        return qb;
      }),
      addOrderBy: jest.fn((col: string, dir: string) => {
        state.lastOrder = [...state.lastOrder, [col, dir]];
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
        return runQuery(filters, cursorParams, take);
      }),
      // total 语义：同过滤条件下的**全量**行数（不含游标下界、不含 take）
      getCount: jest.fn(async () => {
        state.countCalls += 1;
        return runQuery(filters, null, null).length;
      }),
    };
    return qb;
  };

  const repo: any = {
    createQueryBuilder: jest.fn(() => makeQb()),
    // OFFSET 分支的取数入口（keyset 分支不得用它——由 findAndCountCalls 计数断言）
    findAndCount: jest.fn(async (opts: any) => {
      state.findAndCountCalls += 1;
      state.lastFindOptions = opts;
      // 尊重 FindOptions 的 where / order / skip / take（与真仓库同语义）
      const where = (opts?.where ?? {}) as Record<string, unknown>;
      let rows = rowset().filter((r) => {
        for (const [k, v] of Object.entries(where)) {
          const needle = String(
            v && (v as any)._value !== undefined
              ? String((v as any)._value).replace(/%/g, "")
              : v,
          );
          if (k === "name") {
            if (!r.name.toLowerCase().includes(needle.toLowerCase()))
              return false;
          } else if ((r as any)[k] !== v) {
            return false;
          }
        }
        return true;
      });
      rows = [...rows].sort(compareDesc);
      const skip = opts?.skip ?? 0;
      const take = opts?.take ?? rows.length;
      return [rows.slice(skip, skip + take), rows.length];
    }),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((d: unknown) => d),
    save: jest.fn((e: unknown) => Promise.resolve(e)),
    remove: jest.fn(),
  };

  const reset = () => {
    for (const k of Object.keys(filters)) delete filters[k];
    state.lastKeysetPredicate = null;
    state.lastKeysetParams = null;
    state.lastOrder = [];
    state.lastFilterCalls = [];
    state.lastTake = null;
    state.lastFindOptions = null;
    state.countCalls = 0;
    state.getManyCalls = 0;
    state.findAndCountCalls = 0;
    repo.createQueryBuilder.mockClear();
    repo.findAndCount.mockClear();
  };

  return { repo, state, reset };
}

describe("§2.1 ExecutorPackageService.findAll — OFFSET / keyset 双路径", () => {
  let service: ExecutorPackageService;
  let rowset: Row[];
  let repo: any;
  let state: ReturnType<typeof makePkgRepo>["state"];
  let reset: ReturnType<typeof makePkgRepo>["reset"];

  const build = async () => {
    const made = makePkgRepo(() => rowset);
    repo = made.repo;
    state = made.state;
    reset = made.reset;
    const module = await Test.createTestingModule({
      providers: [
        ExecutorPackageService,
        { provide: getRepositoryToken(ExecutorPackage), useValue: repo },
        {
          provide: ConfigService,
          useValue: { get: jest.fn(() => undefined) },
        },
      ],
    }).compile();
    service = module.get(ExecutorPackageService);
  };

  beforeEach(async () => {
    rowset = makeRows();
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    await build();
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  // ── ① 旧路径逐字节等价 ───────────────────────────────────────────────
  describe("不带 cursor：旧路径逐字节不变", () => {
    it("响应对象的键集合与改动前完全一致（`{items,total}`，**没有** nextCursor 键）", async () => {
      const res: any = await service.findAll({ page: 1, pageSize: 20 });

      // 逐键比对（顺序也钉住：items/total 是既有产物的一部分，且**不是**
      // paginate() 的 list/items/total/page/pageSize/totalPages 六键信封）
      expect(Object.keys(res)).toEqual(["items", "total"]);
      // 显式再钉一次"这个键不存在"——防止将来有人改成"恒下发 null"
      expect("nextCursor" in res).toBe(false);
      expect(res.nextCursor).toBeUndefined();
      // 反面断言：**绝不能**变成 paginate 信封
      expect(res).not.toHaveProperty("list");
      expect(res).not.toHaveProperty("page");
      expect(res).not.toHaveProperty("totalPages");
    });

    it("响应体经 JSON 序列化后与改动前逐字节一致（线上形态）", async () => {
      const res = await service.findAll({ page: 1, pageSize: 3 });
      const expected = {
        items: res.items,
        total: 9,
      };
      expect(JSON.stringify(res)).toBe(JSON.stringify(expected));
      expect(JSON.stringify(res)).not.toContain("nextCursor");
    });

    it("仍走 findAndCount（**没有**被改成 QueryBuilder）", async () => {
      await service.findAll({ page: 2, pageSize: 4 });
      expect(repo.findAndCount).toHaveBeenCalledTimes(1);
      expect(repo.createQueryBuilder).not.toHaveBeenCalled();
      // skip/take/order 与改动前逐字段一致
      const opts = state.lastFindOptions as any;
      expect(opts.skip).toBe(4);
      expect(opts.take).toBe(4);
      // A-8 决胜键（**已存在**，本轮未改）
      expect(opts.order).toEqual({ createdAt: "DESC", id: "DESC" });
    });

    it("total 语义不变（全量实数，不是当前页条数）", async () => {
      const res = await service.findAll({ page: 2, pageSize: 3 });
      expect(res.total).toBe(9);
      expect(res.items).toHaveLength(3);
    });

    it("四个过滤器仍经 FindOptions.where 下发（形态与改动前一致）", async () => {
      await service.findAll({
        page: 1,
        pageSize: 20,
        name: "exec",
        type: ExecutorPackageType.NODE,
        status: ExecutorPackageStatus.ACTIVE,
        platform: "linux-x64",
      });
      const opts = state.lastFindOptions as any;
      expect(opts.where.type).toBe(ExecutorPackageType.NODE);
      expect(opts.where.status).toBe(ExecutorPackageStatus.ACTIVE);
      expect(opts.where.platform).toBe("linux-x64");
      // name 仍走 TypeORM 的 Like()（`_value` 是模式串）
      expect(opts.where.name._type).toBe("like");
      expect(opts.where.name._value).toBe("%exec%");
    });
  });

  // ── ② 新路径翻完 N 页不漏不重 ────────────────────────────────────────
  describe("带 cursor：keyset 翻页不漏不重", () => {
    /** 从第一页一路翻到底，返回收集到的 id 序列与页数。 */
    const walkAllPages = async (
      pageSize: number,
      filters: Record<string, unknown> = {},
    ) => {
      const collected: string[] = [];
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
        expect(res.items.length).toBeLessThanOrEqual(pageSize);
        collected.push(...res.items.map((r: Row) => r.id));
        cursor = res.nextCursor;
        expect(
          typeof res.nextCursor === "string" || res.nextCursor === null,
        ).toBe(true);
        if (cursor === null) break;
        // 防御：游标必须能解码（坏游标会让下面的断言变成空转）
        expect(decodeKeysetCursor(cursor!).createdAt).toBeTruthy();
        expect(pages).toBeLessThan(50); // 死循环保险
      }
      return { collected, pages };
    };

    it("keyset 入口（空串）与 OFFSET 首页返回**同一批行**", async () => {
      const offset: any = await service.findAll({ page: 1, pageSize: 3 });
      const keyset: any = await service.findAll({
        page: 1,
        pageSize: 3,
        cursor: "",
      });
      expect(keyset.items.map((r: Row) => r.id)).toEqual(
        offset.items.map((r: Row) => r.id),
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
      expect(second.total).toBe(9);
      expect(second.total).toBe(first.total);
    });

    it("keyset 分支也**保持** `{items,total,nextCursor}` 形状（绝不变成 paginate 信封）", async () => {
      const res: any = await service.findAll({
        page: 1,
        pageSize: 2,
        cursor: "",
      });
      expect(Object.keys(res)).toEqual(["items", "total", "nextCursor"]);
      expect(res).not.toHaveProperty("list");
      expect(res).not.toHaveProperty("page");
      expect(res).not.toHaveProperty("totalPages");
      // `items` 是 admin-web 的消费键（res.items / res.total）
      expect(Array.isArray(res.items)).toBe(true);
    });

    it("多取一行用 getCount 取 total（不调用 findAndCount）", async () => {
      await service.findAll({ page: 1, pageSize: 2, cursor: "" });
      expect(repo.findAndCount).not.toHaveBeenCalled();
      expect(state.getManyCalls).toBe(1);
      expect(state.countCalls).toBe(1);
      // 页查询真的多取了一行（hasMore 判定）
      expect(state.lastTake).toBe(3);
    });

    it("SQL 谓词是**行值比较**形态（不是毫秒半开区间）", async () => {
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
      expect(predicate).toMatch(/\(\s*p\.\"?createdAt\"?\s*,\s*p\.id\s*\)\s*</);
      expect(predicate).toContain("SELECT");
      expect(predicate).toContain("FROM executor_packages c");
      // 参数只有游标行 id（时间由子查询从库里取，不再由 JS 传入）
      const params = state.lastKeysetParams as Record<string, unknown>;
      expect(params.cursorId).toBe(first.items[1].id); // 上一页最后一行
      // ⚠️ 反面断言：绝不能再出现毫秒区间那套（`< :at` / `:atNext`）
      expect(predicate).not.toContain(":atNext");
      expect(params.at).toBeUndefined();
      expect(params.atNext).toBeUndefined();
    });

    it("排序键与游标元组同源（p.createdAt DESC, p.id DESC）", async () => {
      await service.findAll({ page: 1, pageSize: 2, cursor: "" });
      expect(state.lastOrder).toEqual([
        ["p.createdAt", "DESC"],
        ["p.id", "DESC"],
      ]);
    });

    /**
     * ⚠️ 微秒打平 + id 反序的回归防线。
     *
     * 与 audit 兄弟 spec 同一份数据条件（4 行同一毫秒、微秒**递减**、id
     * **递增**）——这是唯一能暴露"毫秒半开区间"缺陷的形状：时间上更早的行
     * id 更大，于是半开区间的 `id < :cursorId` 分支既漏掉游标之后的行，又
     * 返回游标之前的行。真 PG 实测该形状下行值比较正确、半开区间错。
     */
    it("同毫秒不同微秒、且 id 与微秒**反序**时不漏不重（半开区间在此必漏）", async () => {
      const ms = new Date("2026-05-06T07:08:09.000Z");
      const ids = [
        "11111111-1111-4111-8111-000000000001", // id 最小
        "22222222-2222-4222-8222-000000000002",
        "33333333-3333-4333-8333-000000000003",
        "44444444-4444-4444-8444-000000000004", // id 最大
      ];
      rowset = [
        { micro: 900, id: ids[0] }, // 时间最早
        { micro: 800, id: ids[1] },
        { micro: 700, id: ids[2] },
        { micro: 600, id: ids[3] }, // 时间最晚
      ].map(({ micro, id }) => ({
        id,
        name: "same-ms",
        version: "1.0.0",
        type: ExecutorPackageType.UNIVERSAL,
        platform: "any",
        status: ExecutorPackageStatus.ACTIVE,
        createdAt: ms,
        micro,
      }));
      await build();

      const collected: string[] = [];
      let cursor: string | null = "";
      let pages = 0;
      for (;;) {
        const res: any = await service.findAll({
          page: 1,
          pageSize: 1, // 每页 1 条 → 每行都要单独跨一次游标
          cursor: cursor as string,
        });
        pages++;
        collected.push(...res.items.map((r: Row) => r.id));
        cursor = res.nextCursor;
        if (cursor === null) break;
        expect(pages).toBeLessThan(20);
      }

      // 时间倒序（微秒大在前）⇒ ids[0..3]
      expect(collected).toEqual(ids);
      expect(new Set(collected).size).toBe(collected.length);
      expect(collected).toHaveLength(4);
    });

    it("游标行被删除 → 返回空页 + nextCursor: null（已知且有意）", async () => {
      const first: any = await service.findAll({
        page: 1,
        pageSize: 2,
        cursor: "",
      });
      const cursorId = first.items[1].id;
      const cursor = first.nextCursor;
      // 管理员刚删了那个包
      rowset = rowset.filter((r) => r.id !== cursorId);

      const res: any = await service.findAll({
        page: 1,
        pageSize: 2,
        cursor,
      });
      // 子查询无行 → 行值比较得 NULL → WHERE 为假 → 空页。安全地提前结束。
      expect(res.items).toEqual([]);
      expect(res.nextCursor).toBeNull();
      expect("nextCursor" in res).toBe(true);
    });
  });

  // ── ③ 过滤器 × 游标：AND 组合 + 单一真值源 ───────────────────────────
  describe("四个过滤器与游标条件正确 AND 组合", () => {
    it("name 模糊过滤在 keyset 分支同样生效", async () => {
      const res: any = await service.findAll({
        page: 1,
        pageSize: 20,
        name: "legacy", // 只命中 4 条
        cursor: "",
      });
      expect(res.total).toBe(4);
      expect(res.items.every((r: Row) => r.name === "legacy-pkg")).toBe(true);
    });

    it("type / status / platform 过滤在 keyset 分支同样生效", async () => {
      const byType: any = await service.findAll({
        page: 1,
        pageSize: 20,
        type: ExecutorPackageType.NODE,
        cursor: "",
      });
      expect(byType.total).toBe(5);

      reset();
      const byStatus: any = await service.findAll({
        page: 1,
        pageSize: 20,
        status: ExecutorPackageStatus.ACTIVE,
        cursor: "",
      });
      // 5 条同刻行 + 4 条里 i=0,2 是 active
      expect(byStatus.total).toBe(7);

      reset();
      const byPlatform: any = await service.findAll({
        page: 1,
        pageSize: 20,
        platform: "linux-arm64",
        cursor: "",
      });
      expect(byPlatform.total).toBe(4);
    });

    it("过滤器 + 游标组合时，翻页不漏不重（AND 而非覆盖）", async () => {
      const collected: string[] = [];
      let cursor: string | null = "";
      let pages = 0;
      for (;;) {
        const res: any = await service.findAll({
          page: 1,
          pageSize: 2,
          name: "legacy",
          cursor: cursor as string,
        });
        pages++;
        expect(res.items.every((r: Row) => r.name === "legacy-pkg")).toBe(true);
        expect(res.total).toBe(4); // 恒为该过滤下的总数
        collected.push(...res.items.map((r: Row) => r.id));
        cursor = res.nextCursor;
        if (cursor === null) break;
        expect(pages).toBeLessThan(20);
      }
      const expected = rowset
        .filter((r) => r.name === "legacy-pkg")
        .sort(compareDesc)
        .map((r) => r.id);
      expect(collected).toEqual(expected);
      expect(new Set(collected).size).toBe(collected.length);
    });

    /**
     * 单一真值源守卫。
     *
     * keyset 分支改用 QueryBuilder 后，过滤条件若照抄一遍就变成两份判据
     * （`findAll` 的 `FindOptionsWhere` + `applyPackageFilters`）。`name` 的
     * 匹配方式是**精确等值 vs 模糊、是否转义 LIKE 元字符**这类最容易被抄错的
     * 细节——一旦漂移，"翻下一页"与"第 1 页"会返回不同行集且两边都不报错。
     *
     * 断言方式：同一组过滤参数下，两条路径必须产生**同样的行集**与**同样的
     * total**（FindOptions 与 andWhere 的 SQL 文本无法直接比对——一个是配置
     * 对象、一个是 SQL 片段——故用行为等价来钉）。
     */
    it("OFFSET 与 keyset 两条路径的过滤结果一致（单一真值源）", async () => {
      const cases = [
        { name: "exec" },
        { name: "legacy" },
        { type: ExecutorPackageType.NODE },
        {
          type: ExecutorPackageType.PYTHON,
          status: ExecutorPackageStatus.ACTIVE,
        },
        { status: ExecutorPackageStatus.DEPRECATED },
        { platform: "linux-arm64" },
        {
          name: "acf",
          type: ExecutorPackageType.NODE,
          status: ExecutorPackageStatus.ACTIVE,
          platform: "linux-x64",
        },
      ] as const;

      for (const filters of cases) {
        reset();
        const offset: any = await service.findAll({
          page: 1,
          pageSize: 100,
          ...filters,
        });
        reset();
        const keyset: any = await service.findAll({
          page: 1,
          pageSize: 100,
          ...filters,
          cursor: "",
        });
        expect(keyset.items.map((r: Row) => r.id)).toEqual(
          offset.items.map((r: Row) => r.id),
        );
        expect(keyset.total).toBe(offset.total);
      }
    });
  });

  // ── ④ 非法游标 400，绝不静默退回第一页 ────────────────────────────────
  describe("非法 cursor：一律 400，绝不静默从第一页开始", () => {
    const expectBadRequest = async (cursor: string) => {
      reset();
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
      expect(repo.findAndCount).not.toHaveBeenCalled();
    };

    it("乱码", () => expectBadRequest("not-a-cursor"));
    it("合法 base64 但内容不对", () =>
      expectBadRequest(Buffer.from("hello", "utf8").toString("base64url")));
    it("时间不合法", () =>
      expectBadRequest(
        Buffer.from("2026-02-30T03:04:05.123Z|nope", "utf8").toString(
          "base64url",
        ),
      ));

    // 本表主键是 uuid，故**整型 id 必须被拒**（与审计端点相反——两张表
    // 主键类型不同，判据不能混用）。
    it.each([
      ["整型 id（错表主键）", "2026-01-02T03:04:05.123Z|42"],
      ["非 uuid 形状", "2026-01-02T03:04:05.123Z|not-a-uuid"],
      ["空 id 段", "2026-01-02T03:04:05.123Z|"],
      [
        "注入串",
        "2026-01-02T03:04:05.123Z|'; DROP TABLE executor_packages; --",
      ],
    ])("id 段非法（%s）→ 400", (_label: string, payload: string) => {
      return expectBadRequest(
        Buffer.from(payload, "utf8").toString("base64url"),
      );
    });
  });

  // ── ⑤ 控制器：cursor 原样透传（不得合成空串） ─────────────────────────
  describe("控制器层：cursor 透传", () => {
    it("传了 cursor 就原样交给服务层", async () => {
      const spy = jest
        .spyOn(service, "findAll")
        .mockResolvedValue({ items: [], total: 0, nextCursor: null } as never);
      const controller = new ExecutorPackageController(
        service,
        {} as never,
        {} as never,
        {} as never,
      );
      await controller.findAll({
        page: 1,
        pageSize: 20,
        cursor: "abc",
      } as never);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: "abc" }),
      );
      spy.mockRestore();
    });

    it("没传 cursor 时**不**合成空串（空串在服务层意味着「进入 keyset 模式」）", async () => {
      const spy = jest
        .spyOn(service, "findAll")
        .mockResolvedValue({ items: [], total: 0 } as never);
      const controller = new ExecutorPackageController(
        service,
        {} as never,
        {} as never,
        {} as never,
      );
      await controller.findAll({ page: 1, pageSize: 20 } as never);
      const passed = spy.mock.calls[0]?.[0] as { cursor?: string };
      // DTO 上该字段是 undefined（不是 ""）；服务层据此走 OFFSET 分支。
      expect(passed.cursor).toBeUndefined();
      spy.mockRestore();
    });
  });
});
