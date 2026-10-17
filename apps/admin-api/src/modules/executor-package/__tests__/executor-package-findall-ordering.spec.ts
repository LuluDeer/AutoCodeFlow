import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { ExecutorPackageService } from "../executor-package.service";
import { ExecutorPackage } from "../executor-package.entity";

/**
 * `ExecutorPackageService.findAll` 的**排序确定性** spec。
 *
 * ## 缺陷现场（本轮发现，独立于游标分页）
 *
 * 原实现只有单键 `order: { createdAt: "DESC" }`：
 *
 * ```ts
 * const [items, total] = await this.repo.findAndCount({
 *   where, order: { createdAt: "DESC" }, skip: ..., take: ...,
 * });
 * ```
 *
 * 真实库实测 `executor_packages.createdAt` 是
 * `timestamp without time zone`、**precision = 6**（information_schema 查得）。
 * 同一事务批量上传 / 并发上传的多个包会拿到**完全相同**的时间戳。在并列行上，
 * PG 只保证 `ORDER BY` 的键序，不保证并列行之间的相对顺序（取决于执行计划：
 * Sort / Seq Scan / Index Scan 各不相同）。于是 OFFSET 翻页会有两种可观测的错误：
 *
 *   · **重行**——同一行先出现在第 1 页、又出现在第 2 页；
 *   · **漏行**——某行既不在第 1 页也不在第 2 页。
 *
 * 这不是"理论上可能"：只要并列组跨越页边界就必然发生，而包上传恰恰容易同刻
 * 批量发生（CI 里一次推 3 个平台的包就是 3 行同秒）。
 *
 * ## 本 spec 怎么钉
 *
 * 用**内存表 + 真排序/真切片**的假仓库（与
 * `task/__tests__/all-executions-keyset-pagination.spec.ts` 同款纪律）：
 * 假仓库真的按传入的 `order` 对象做比较排序、真的按 `skip/take` 切片，
 * 因此"翻完所有页收集到的 id 集合 === 全量 id 集合且无重复"是可判定的事实，
 * 而不是对 SQL 字符串的猜测。
 *
 * 附带钉一条**排序语义不回归**：`createdAt` 必须仍是主排序键（时间倒序），
 * `id` 只在其后决胜——不能为了补决胜键把"按时间倒序"改成"按 id 排序"。
 */

/** 表里的行：只保留 findAll 会排序/返回的列。 */
interface Row {
  id: string;
  name: string;
  createdAt: Date;
}

/**
 * 假仓库：真的排序 + 真的切片。
 *
 * `order` 接受 findAll 实际传入的形态（对象，键序即排序优先级）。
 * 比较器逐键比较——这正是 PG `ORDER BY a DESC, b DESC` 的语义。
 */
function buildFakeRepo(rows: Row[]) {
  const findAndCount = jest.fn(
    async (opts: {
      where?: Record<string, unknown>;
      order?: Record<string, "ASC" | "DESC">;
      skip?: number;
      take?: number;
    }) => {
      const order = opts.order ?? {};
      const keys = Object.keys(order);
      const sorted = [...rows].sort((a, b) => {
        for (const key of keys) {
          const dir = order[key] === "DESC" ? -1 : 1;
          const av = a[key as keyof Row];
          const bv = b[key as keyof Row];
          if (av === bv) continue;
          // Date / string / number 统一用 < > 比较（Date 走 getTime 语义）
          const an = av instanceof Date ? av.getTime() : av;
          const bn = bv instanceof Date ? bv.getTime() : bv;
          return an < bn ? -1 * dir : 1 * dir;
        }
        return 0;
      });
      const skip = opts.skip ?? 0;
      const take = opts.take ?? sorted.length;
      return [sorted.slice(skip, skip + take), sorted.length] as [
        Row[],
        number,
      ];
    },
  );
  return { findAndCount };
}

async function makeService(fakeRepo: unknown): Promise<ExecutorPackageService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ExecutorPackageService,
      {
        provide: ConfigService,
        useValue: {
          get: jest.fn().mockReturnValue("/uploads/executor-packages"),
        },
      },
      {
        provide: getRepositoryToken(ExecutorPackage),
        useValue: fakeRepo,
      },
    ],
  }).compile();
  return moduleRef.get(ExecutorPackageService);
}

/**
 * 5 行**完全相同的 createdAt**——专打决胜键。
 *
 * id 故意用非字典序便于人工核对（...-c 在 ...-a 之前）。
 */
const SAME_INSTANT = new Date("2026-10-01T08:00:00.000Z");
const collidingRows = (): Row[] => [
  { id: "aaaa-0001", name: "pkg-a", createdAt: SAME_INSTANT },
  { id: "aaaa-0005", name: "pkg-e", createdAt: SAME_INSTANT },
  { id: "aaaa-0003", name: "pkg-c", createdAt: SAME_INSTANT },
  { id: "aaaa-0002", name: "pkg-b", createdAt: SAME_INSTANT },
  { id: "aaaa-0004", name: "pkg-d", createdAt: SAME_INSTANT },
];

/** 翻完所有页，返回每页的 id 列表。 */
async function collectAllPages(
  service: ExecutorPackageService,
  pageSize: number,
): Promise<string[][]> {
  const pages: string[][] = [];
  // 上界防御：5 行 / pageSize 最多 5 页，取 10 防死循环
  for (let page = 1; page <= 10; page += 1) {
    const res = await service.findAll({ page, pageSize } as never);
    const ids = res.items.map((r) => r.id);
    if (ids.length === 0) break;
    pages.push(ids);
    if (pages.reduce((n, p) => n + p.length, 0) >= res.total) break;
  }
  return pages;
}

describe("ExecutorPackageService.findAll 排序确定性（A-8 推广）", () => {
  it("order 同时含 createdAt 与 id，且 createdAt 在前（时间倒序语义不变）", async () => {
    const fake = buildFakeRepo(collidingRows());
    const service = await makeService(fake);

    await service.findAll({ page: 1, pageSize: 2 } as never);

    expect(fake.findAndCount).toHaveBeenCalledTimes(1);
    const opts = fake.findAndCount.mock.calls[0]?.[0] as {
      order?: Record<string, string>;
    };
    expect(opts.order).toBeDefined();
    // 决定性断言：两个键都在，且 id 是**次**键
    expect(Object.keys(opts.order!)).toEqual(["createdAt", "id"]);
    expect(opts.order).toEqual({ createdAt: "DESC", id: "DESC" });
  });

  it("5 行同 createdAt：翻完所有页不漏行（集合相等）", async () => {
    const rows = collidingRows();
    const service = await makeService(buildFakeRepo(rows));

    const pages = await collectAllPages(service, 2);
    const seen = pages.flat();

    // 不漏：5 行全部出现
    expect(new Set(seen).size).toBe(rows.length);
    expect([...seen].sort()).toEqual(rows.map((r) => r.id).sort());
  });

  it("5 行同 createdAt：翻完所有页不重行（无重复 id）", async () => {
    const service = await makeService(buildFakeRepo(collidingRows()));

    const pages = await collectAllPages(service, 2);
    const seen = pages.flat();

    // 不重：10 个观测 = 5 个不同 id，一个都不多
    expect(seen.length).toBe(5);
    expect(new Set(seen).size).toBe(seen.length);
    // 逐页也各自无重复
    for (const p of pages) expect(new Set(p).size).toBe(p.length);
  });

  it("并列行按 id DESC 展开（确定性：同样的输入永远同样的顺序）", async () => {
    const service = await makeService(buildFakeRepo(collidingRows()));

    const pages = await collectAllPages(service, 2);
    // createdAt 全相同 → 整体顺序应严格是 id DESC
    expect(pages.flat()).toEqual([
      "aaaa-0005",
      "aaaa-0004",
      "aaaa-0003",
      "aaaa-0002",
      "aaaa-0001",
    ]);
  });

  it("createdAt 不同时仍以时间倒序为主序（id 决胜不篡位）", async () => {
    const rows: Row[] = [
      // id 最大的行时间最旧 → 若实现误把 id 当主键，它会排到最前
      {
        id: "ffff-9999",
        name: "old",
        createdAt: new Date("2026-10-01T00:00:00Z"),
      },
      {
        id: "aaaa-0001",
        name: "new",
        createdAt: new Date("2026-10-03T00:00:00Z"),
      },
      {
        id: "cccc-0005",
        name: "mid",
        createdAt: new Date("2026-10-02T00:00:00Z"),
      },
    ];
    const service = await makeService(buildFakeRepo(rows));

    const pages = await collectAllPages(service, 10);
    expect(pages.flat()).toEqual(["aaaa-0001", "cccc-0005", "ffff-9999"]);
  });

  it("回归护栏：单键排序（修复前的实现）在并列行上确实无法保证不漏不重", async () => {
    // 这条不是在测我们的代码，而是论证缺陷真实存在——用同一个假仓库、只把
    // order 换成修复前的单键形态，让"并列行 + 不稳定次序"可被观察到。
    //
    // 单键排序下并列组的相对顺序由 sort 算法的相等元素次序决定。JS 的
    // Array.prototype.sort 自 ES2019 起是稳定排序，所以这里**不会**抖——
    // 正因为如此，单元测试永远无法用假仓库抓到"不稳定"，只能证明：
    // 单键排序时并列行的顺序**完全取决于输入顺序**（即被外部/执行计划支配），
    // 而双键排序时顺序由数据的 id 唯一决定。这就是补决胜键的意义。
    const rows = collidingRows();
    const singleKeyRepo = {
      findAndCount: jest.fn(async (opts: { skip?: number; take?: number }) => {
        // 模拟"数据库返回了并列行但相对顺序由执行计划决定"：
        // 这里故意用与输入不同的、看似合理的次序（PG Seq Scan 常见形态）
        const sorted = [...rows].sort((a, b) =>
          a.createdAt.getTime() === b.createdAt.getTime()
            ? a.name.localeCompare(b.name) // 只按 name，与 id 无关
            : b.createdAt.getTime() - a.createdAt.getTime(),
        );
        const skip = opts.skip ?? 0;
        const take = opts.take ?? sorted.length;
        return [sorted.slice(skip, skip + take), sorted.length] as [
          Row[],
          number,
        ];
      }),
    };
    const service = await makeService(singleKeyRepo);
    const pages = await collectAllPages(service, 2);
    const seen = pages.flat();

    // 单键形态下顺序由 name 决定，与 id 无关——观测到的序列不是 id DESC。
    // （集合本身仍完整，因为在同一个进程内排序是稳定的；真实库才是漏行/重行的
    //  来源。本断言钉住"顺序不由 id 决定"这一事实，即决胜键缺失的语义缺口。）
    expect(seen).not.toEqual([
      "aaaa-0005",
      "aaaa-0004",
      "aaaa-0003",
      "aaaa-0002",
      "aaaa-0001",
    ]);
  });
});
