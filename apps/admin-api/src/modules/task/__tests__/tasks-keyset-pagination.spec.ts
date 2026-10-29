import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { getQueueToken } from "@nestjs/bullmq";
import { DataSource } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { DECORATORS } from "@nestjs/swagger";
import { TaskService } from "../task.service";
import {
  Task,
  TaskRuntime,
  TaskStatus,
  TaskTriggerType,
} from "../entities/task.entity";
import { TaskExecution } from "../entities/task-execution.entity";
import { ExecutionLogLine } from "../entities/execution-log-line.entity";
import { TaskVersion } from "../entities/task-version.entity";
import { SchedulerService } from "../../scheduler/scheduler.service";
import { AiService } from "../../ai/ai.service";
import { AiAnalysisService } from "../../ai/ai-analysis.service";
import { ExecutorService } from "../../executor/executor.service";
import { DomainEventBus } from "../../../common/services/domain-event-bus.service";
import { SecretsCryptoService } from "../../../common/utils/secret-crypto.util.service";
import { ExecutionReport } from "../../metrics/entities/execution-report.entity";
import { PaginatedTaskListDto } from "../dto/task-response.dto";
import { decodeKeysetCursor } from "../../../common/utils/keyset-cursor.util";

/**
 * §2.1 游标分页（推广到 `GET /tasks`）· **服务层**定向 spec。
 *
 * 与 `executions-keyset-pagination.spec.ts` 同构，但它面对的端点更复杂，
 * 故三条验收线各自多一层：
 *
 *   ① **不带 cursor 时旧路径逐字节不变**——任务书硬要求，且本端点比 executions
 *      多了 sortBy / lastStatus / fields 三个正交开关，任何一个被新代码碰到都会
 *      在四端造成回归。故逐键比对 + JSON 逐字节比对 + `"nextCursor" in res === false`
 *      三条全上，并额外钉住"旧路径仍走 findAndCount 且 order 是默认的
 *      createdAt DESC"。
 *
 *   ② **带 cursor 时翻完 N 页不漏不重**——造一批**同一 createdAt** 的任务专打
 *      决胜键；并且断言 SQL 参数绑的是 **`Date` 而不是字符串**（这是本轮实测出的
 *      时区陷阱：naive `timestamp` + 会话 UTC+8 下，字符串参数会让游标早 8 小时，
 *      静默跳过大量行，见 task.service.findAllByKeyset 头注）。
 *
 *   ③ **不可组合的参数一律 400**——sortBy / lastStatus 与 cursor 同时给出必须
 *      显式拒绝，绝不静默组合出语义错乱的结果；非法游标同样 400 且**不降级**到
 *      第一页（降级 = 翻页死循环）。
 *
 * ## 为什么用"内存表 + 真元组过滤"的假仓库，而不是断言 SQL 字符串
 *
 * 只断言 `andWhere` 被调过、或 SQL 里含某子串，**证明不了不漏不重**——排序方向
 * 反了、决胜键写反、毫秒桶算错，SQL 字符串看起来都可以是对的。这里让假仓库真的
 * 按 `(createdAt DESC, id DESC)` 排序、真的执行**行值比较**的字典序判断，于是
 * "翻完所有页收集到的 id 集合 === 全量 id 集合且无重复"成为可判定的事实。
 *
 * ⚠️ 关键：本假仓库把 `createdAt` 建模到**微秒**（`Row.micro`），因为真实列就是
 * `timestamp(6)`。若只建模毫秒，"同毫秒不同微秒"的行会被视为相等，**毫秒半开
 * 区间那版缺陷就永远测不出来**——这正是它当初能全绿的原因。把生产改回半开区间
 * 时，下方「同毫秒不同微秒」与「游标行被删除」两条用例会红。
 */

/** 表里的行：只保留列表端点会读到的列（其余列对分页语义无影响）。 */
interface Row {
  id: string;
  name: string;
  status: TaskStatus;
  runtime: TaskRuntime;
  applicationId: string | null;
  projectId: string | null;
  description: string | null;
  secrets: Record<string, unknown> | null;
  createdAt: Date;
  /**
   * 微秒分量（0–999）。真实列是 `timestamp(6)`，实体读出来才截成毫秒；本 spec
   * 显式建模微秒，才能复现"同毫秒但微秒不同"的漏行条件（见 compareDesc 注释）。
   */
  micro?: number;
}

const SAME_INSTANT = new Date("2026-03-04T05:06:07.123Z");

/**
 * 造一批行：5 条**完全相同**的 createdAt（专打决胜键）+ 4 条不同时刻的。
 *
 * id 的字典序与插入序**刻意相反**（真实 uuid 随机，若按插入序递增，决胜键写反
 * 了也看不出来）。
 */
function makeRows(): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < 5; i++) {
    rows.push({
      id: `ffffffff-ffff-4fff-8fff-${String(i).padStart(12, "0")}`,
      name: `same-instant-${i}`,
      status: TaskStatus.ACTIVE,
      runtime: TaskRuntime.PYTHON,
      applicationId: null,
      projectId: null,
      description: null,
      secrets: { token: `plain-${i}` },
      createdAt: SAME_INSTANT,
    });
  }
  for (let i = 0; i < 4; i++) {
    rows.push({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      name: `older-${i}`,
      status: TaskStatus.PAUSED,
      runtime: TaskRuntime.SHELL,
      applicationId: null,
      projectId: null,
      description: null,
      secrets: null,
      createdAt: new Date(SAME_INSTANT.getTime() - (i + 1) * 1000),
    });
  }
  return rows;
}

/**
 * 字典序比较 `(createdAt, id)`：DESC 用正数表示 a 排在 b 前面。
 *
 * 时间比较用**微秒**（`preciseMicros`），因为真实列就是微秒精度——这是本 spec
 * 能识别"毫秒半开区间"缺陷的前提（毫秒级比较会把同毫秒不同微秒的行视为相等）。
 */
const compareDesc = (a: Row, b: Row): number => {
  const t = preciseMicros(b) - preciseMicros(a);
  if (t !== 0) return t;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
};

/** 行的精确时间（毫秒 * 1000 + 微秒），用于有序比较。 */
const preciseMicros = (r: Row): number =>
  r.createdAt.getTime() * 1000 + (r.micro ?? 0);

/**
 * 行值比较 `(createdAt, id) < (cursor.createdAt, cursor.id)`——生产谓词的语义。
 */
const tupleLess = (a: Row, cursor: Row): boolean => {
  const ta = preciseMicros(a);
  const tc = preciseMicros(cursor);
  if (ta !== tc) return ta < tc;
  return a.id < cursor.id;
};

/**
 * 假仓库：真的排序 + 真的执行游标过滤 + 真的分页。
 *
 * 同时记录最后一次 `findAndCount` / keyset 的入参，供"旧路径逐字节等价"与
 * "时间参数必须绑 Date"的断言使用。
 */
function makeTaskRepo(rowset: Row[]) {
  const state = {
    lastFindAndCount: null as unknown,
    lastKeysetParams: null as Record<string, unknown> | null,
    lastKeysetPredicate: null as string | null,
    lastKeysetSelect: null as unknown,
    lastKeysetOrder: [] as Array<[string, string]>,
  };

  /** 从 where 对象/数组里取出与分页相关的过滤条件（模拟 PG 的 AND/OR 语义）。 */
  const matchesWhere = (
    row: Row,
    where: Record<string, unknown> | Record<string, unknown>[],
  ): boolean => {
    const one = (w: Record<string, unknown>): boolean => {
      for (const [key, raw] of Object.entries(w)) {
        const op = raw as { type?: string; value?: unknown } | undefined;
        const type = op && typeof op === "object" ? op.type : undefined;
        const value = op && typeof op === "object" ? op.value : raw;
        switch (key) {
          case "status":
            if (type === "not") {
              if (row.status === value) return false;
            } else if (row.status !== value) return false;
            break;
          case "runtime":
            if (row.runtime !== value) return false;
            break;
          case "applicationId":
            if (row.applicationId !== value) return false;
            break;
          case "name":
            // ILIKE '%x%'：只做大小写不敏感的子串包含
            if (
              !row.name
                .toLowerCase()
                .includes(String(value).replace(/%/g, "").toLowerCase())
            ) {
              return false;
            }
            break;
          case "description": {
            if (!row.description) return false;
            const needle = String(value).replace(/%/g, "").toLowerCase();
            if (!row.description.toLowerCase().includes(needle)) return false;
            break;
          }
          case "projectId": {
            if (type === "or") {
              // Or(IsNull(), In([DEFAULT_PROJECT_ID]))："未分配"或"默认项目"
              const items =
                (value as Array<{ type?: string; value?: unknown }>) ?? [];
              const ok = items.some((it) =>
                it.type === "isNull"
                  ? row.projectId === null
                  : it.value === row.projectId,
              );
              if (!ok) return false;
            } else if (row.projectId !== value) return false;
            break;
          }
          default:
            break;
        }
      }
      return true;
    };
    // TypeORM 数组语义：元素间 OR、元素内 AND（qb.where(array) 同样如此）。
    return Array.isArray(where) ? where.some(one) : one(where);
  };

  // db-8：OFFSET 路径的 `order` 必须**被忠实执行**，而且并列行的顺序要像 PG 那样
  // 是"未定义的"。
  //
  // 旧桩直接 `rows.sort(compareDesc)`——那是 (createdAt DESC, id DESC) 的**全序**，
  // 比生产"更正确"：生产若只按单键排序（`{createdAt:'DESC'}`），翻页重复/遗漏的
  // 缺陷在这个桩里永远看不见（ADR-008 记过的老坑）。故这里按 `opts.order` 里
  // **列出的键**排序；键全等时按调用序号轮转，模拟"同刻行顺序随计划/并行度漂移"。
  let findAndCountSeq = 0;
  const sortByOrder = (
    rows: Row[],
    order: Record<string, "ASC" | "DESC"> | undefined,
    callIndex: number,
  ): Row[] => {
    const keys = Object.entries(order ?? {});
    if (keys.length === 0) return [...rows].sort(compareDesc);
    const cmp = (a: Row, b: Row): number => {
      for (const [field, dir] of keys) {
        const av = (a as any)[field];
        const bv = (b as any)[field];
        if (av === bv) continue;
        const base = av < bv ? -1 : 1;
        return dir === "DESC" ? -base : base;
      }
      return 0;
    };
    const sorted = [...rows].sort(cmp);
    // 并列组轮转：只影响"排序键无法区分"的行——正是生产里顺序未定义的那部分。
    const out: Row[] = [];
    let i = 0;
    while (i < sorted.length) {
      let j = i + 1;
      while (j < sorted.length && cmp(sorted[i], sorted[j]) === 0) j++;
      const group = sorted.slice(i, j);
      const shift = group.length > 1 ? callIndex % group.length : 0;
      out.push(...group.slice(shift), ...group.slice(0, shift));
      i = j;
    }
    return out;
  };

  const repo: any = {
    findAndCount: jest.fn(async (opts: any) => {
      state.lastFindAndCount = opts;
      const rows = rowset.filter((r) => matchesWhere(r, opts.where ?? {}));
      // 与生产同源：按调用方传入的 order 排序（含并列顺序未定义）。
      const ordered = sortByOrder(rows, opts.order, findAndCountSeq++);
      const skip = opts.skip ?? 0;
      const take = opts.take ?? ordered.length;
      return [ordered.slice(skip, skip + take), ordered.length];
    }),
    count: jest.fn(async (opts: any) => {
      return rowset.filter((r) => matchesWhere(r, opts?.where ?? {})).length;
    }),
    createQueryBuilder: jest.fn(() => {
      let where: Record<string, unknown> | Record<string, unknown>[] = {};
      let cursorParams: Record<string, unknown> | null = null;
      let predicate: string | null = null;
      let order: Array<[string, string]> = [];
      let take = 20;
      let selected: unknown = null;

      const qb: any = {
        select: jest.fn((sel: unknown) => {
          selected = sel;
          return qb;
        }),
        orderBy: jest.fn((col: string, dir: string) => {
          order = [[col, dir]];
          return qb;
        }),
        addOrderBy: jest.fn((col: string, dir: string) => {
          order = [...order, [col, dir]];
          return qb;
        }),
        where: jest.fn(
          (w: Record<string, unknown> | Record<string, unknown>[]) => {
            where = w;
            return qb;
          },
        ),
        andWhere: jest.fn((sql: string, params: Record<string, unknown>) => {
          // 游标谓词识别：行值比较只带 cursorId；毫秒区间会带 at/atNext。
          // 两者都记录下来，让断言能**区分形态**（这是反证的前提）。
          if (params && "cursorId" in params) {
            predicate = sql;
            cursorParams = params;
          }
          return qb;
        }),
        take: jest.fn((n: number) => {
          take = n;
          return qb;
        }),
        skip: jest.fn(() => qb),
        /**
         * 取数（`getMany`）：**套游标过滤**。计数（`getCount`）：**不套游标**
         * ——生产实现是在加游标谓词**之前**调 getCount。
         *
         * ⚠️ 历史坑（本轮修）：旧 mock 只有 `getManyAndCount`，并在注释里写下
         * 「真实的 COUNT 也不含游标谓词」。实测 typeorm 1.1.2 的
         * `executeCountQuery` 只清 orderBy/groupBy/offset/limit/skip/take，
         * **WHERE 原样保留**（SelectQueryBuilder.js:1856）——真实 COUNT 带着
         * 游标条件，于是「共 N 条」越翻越小。mock 比生产"更正确"，把真缺陷
         * 盖了整整一轮。现在两条语义分开实现，谁错谁红。
         */
        countRows: () => rowset.filter((r) => matchesWhere(r, where)).length,
        materializeRows: () => {
          state.lastKeysetParams = cursorParams;
          state.lastKeysetPredicate = predicate;
          state.lastKeysetSelect = selected;
          state.lastKeysetOrder = order;
          let rows = rowset.filter((r) => matchesWhere(r, where));
          if (cursorParams) {
            // ⚠️ 关键：按**生产实际发出的 SQL 形态**执行对应语义，而不是永远用
            // 正确的那一种。否则"把生产改回毫秒半开区间"时数据断言照样绿——
            // mock 又会比生产"更正确"（ADR-008 的老坑）。
            const sql = predicate ?? "";
            if (sql.includes(":atNext")) {
              // 毫秒半开区间形态（旧实现）：按毫秒桶比较，微秒被忽略
              const at = new Date(cursorParams.at as string | Date).getTime();
              const atNext = new Date(
                cursorParams.atNext as string | Date,
              ).getTime();
              const cursorId = String(cursorParams.cursorId);
              rows = rows.filter((r) => {
                const t = r.createdAt.getTime();
                if (t < at) return true;
                if (t < atNext) return r.id < cursorId;
                return false;
              });
            } else {
              // 行值比较形态（现实现）：游标行按 id 从内存表取**精确**值
              // （等价于生产按主键的子查询）。**不替生产做任何转换**。
              const cursorRow = rowset.find(
                (r) => r.id === String(cursorParams!.cursorId),
              );
              // 游标行已被删除 → 行值比较得 NULL → WHERE 为假 → 空页
              rows = cursorRow
                ? rows.filter((r) => tupleLess(r, cursorRow))
                : [];
            }
          }
          rows.sort(compareDesc);
          return rows;
        },
        getCount: jest.fn(async () => qb.countRows()),
        getMany: jest.fn(async () => qb.materializeRows().slice(0, take)),
        /**
         * `getManyAndCount` **不是**「行套游标、计数不套」——它两次都用当前 WHERE
         * （typeorm 的 COUNT 保留 WHERE）。这里如实建模：两者都套游标。
         * 只有这样，「用 getManyAndCount 算 keyset 的 total」才会红。
         */
        getManyAndCount: jest.fn(async () => {
          const rows = qb.materializeRows();
          return [rows.slice(0, take), rows.length];
        }),
      };
      return qb;
    }),
  };

  return { repo, state };
}

describe("§2.1 TaskService.findAll — OFFSET / keyset 双路径", () => {
  let service: TaskService;
  let rowset: Row[];
  let taskRepo: ReturnType<typeof makeTaskRepo>["repo"];
  let state: ReturnType<typeof makeTaskRepo>["state"];

  const build = async () => {
    const made = makeTaskRepo(rowset);
    taskRepo = made.repo;
    state = made.state;
    const noopRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      save: jest.fn((e: unknown) => Promise.resolve(e)),
      create: jest.fn((e: unknown) => e),
      createQueryBuilder: jest.fn(() => ({})),
    };
    const module = await Test.createTestingModule({
      providers: [
        TaskService,
        { provide: getRepositoryToken(Task), useValue: taskRepo },
        { provide: getRepositoryToken(TaskExecution), useValue: noopRepo },
        { provide: getRepositoryToken(ExecutionLogLine), useValue: noopRepo },
        { provide: getRepositoryToken(TaskVersion), useValue: noopRepo },
        { provide: getQueueToken("task-queue"), useValue: { add: jest.fn() } },
        { provide: DataSource, useValue: { transaction: jest.fn() } },
        {
          provide: SchedulerService,
          useValue: { stop: jest.fn(), scheduleOne: jest.fn() },
        },
        {
          provide: AiService,
          useValue: { analyzeFailure: jest.fn(), chat: jest.fn() },
        },
        {
          provide: AiAnalysisService,
          useValue: { analyzeFailure: jest.fn(), chat: jest.fn() },
        },
        { provide: ConfigService, useValue: { get: jest.fn(() => "") } },
        { provide: ExecutorService, useValue: {} },
        {
          provide: DomainEventBus,
          useValue: {
            emit: jest.fn(),
            on: jest.fn(),
            off: jest.fn(),
            listenerCount: jest.fn().mockReturnValue(0),
          },
        },
        {
          provide: SecretsCryptoService,
          useValue: new SecretsCryptoService({ get: () => "" } as never),
        },
        { provide: getRepositoryToken(ExecutionReport), useValue: {} },
      ],
    }).compile();
    service = module.get(TaskService);
  };

  beforeEach(async () => {
    rowset = makeRows();
    await build();
  });

  // ── ① 旧路径逐字节等价（任务书硬要求，三条全上） ──────────────────────
  describe("不带 cursor：旧路径逐字节不变", () => {
    it("响应对象的键集合与改动前完全一致（**没有** nextCursor 键）", async () => {
      const res: any = await service.findAll({ page: 1, pageSize: 20 });

      // 逐键比对（顺序也钉住：信封键序是既有产物的一部分）
      expect(Object.keys(res)).toEqual([
        "list",
        "items",
        "total",
        "page",
        "pageSize",
        "totalPages",
      ]);
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
        list: res.list,
        items: res.items,
        total: 9,
        page: 1,
        pageSize: 3,
        totalPages: 3,
      };
      expect(JSON.stringify(res)).toBe(JSON.stringify(expected));
      expect(JSON.stringify(res)).not.toContain("nextCursor");
    });

    it("仍走 findAndCount + skip/take，且 order 是默认的 createdAt DESC（没有偷换成 QueryBuilder、也没有悄悄加决胜键）", async () => {
      await service.findAll({ page: 2, pageSize: 4 });
      expect(taskRepo.findAndCount).toHaveBeenCalledTimes(1);
      expect(taskRepo.createQueryBuilder).not.toHaveBeenCalled();
      const opts = state.lastFindAndCount as any;
      expect(opts.skip).toBe(4);
      expect(opts.take).toBe(4);
      // db-8（第 3 轮 db 审计残差，**推翻了 F-03 当时"必须单键"的结论**）：
      // 缺省排序现在是稳定双键 (createdAt DESC, id DESC)。
      //
      // 当时的理由是"加决胜键会改变同刻行的相对顺序，属旧路径变了"。这个理由
      // 站不住：单键下同刻行的顺序**本来就是未定义**的（PG 不保证，换计划/换
      // 并行度就会变），所以"旧顺序"不存在可被破坏的契约；而代价是真实缺陷——
      // skip/take 翻页在并列行上会重复或漏行（见下面"翻两页无重复无遗漏"用例，
      // 那里的桩按 order 真实排序、并列顺序随调用轮转）。响应字段、行集、total、
      // totalPages 全不变，只有并列行的相对顺序从"未定义"变成"确定"。
      expect(opts.order).toEqual({ createdAt: "DESC", id: "DESC" });
    });

    it("total 语义不变（全量实数，不是当前页条数）", async () => {
      const res = await service.findAll({ page: 2, pageSize: 3 });
      expect(res.total).toBe(9);
      expect(res.items).toHaveLength(3);
      expect(res.totalPages).toBe(3);
      expect(res.page).toBe(2);
    });

    it("sortBy / lastStatus / fields 单独使用时行为不变（拒绝只在带 cursor 时生效）", async () => {
      // sortBy 单独：仍走 findAndCount，排序按其指定
      const byName: any = await service.findAll({
        page: 1,
        pageSize: 5,
        sortBy: "name",
        sortOrder: "asc",
      });
      expect(taskRepo.findAndCount).toHaveBeenCalled();
      // db-8：显式 sortBy 也只是"主键"，`id` 恒为次级决胜键（稳定全序），
      // 否则同值行在 OFFSET 翻页时会重复/漏行。方向跟随主排序。
      expect((state.lastFindAndCount as any).order).toEqual({
        name: "ASC",
        id: "ASC",
      });
      expect("nextCursor" in byName).toBe(false);

      // status / runtime / q 过滤仍生效（过滤装配抽成 buildTaskListWhere 后不得漂移）
      const filtered: any = await service.findAll({
        page: 1,
        pageSize: 20,
        status: TaskStatus.ACTIVE,
      });
      expect(filtered.total).toBe(5);
      const byKeyword: any = await service.findAll({
        page: 1,
        pageSize: 20,
        q: "older",
      });
      expect(byKeyword.total).toBe(4);
      expect("nextCursor" in byKeyword).toBe(false);
    });

    it("SEC-02：默认投影下 secrets 仍被脱敏", async () => {
      const res: any = await service.findAll({ page: 1, pageSize: 20 });
      const masked = res.items.filter((t: Row) => t.secrets);
      expect(masked.length).toBeGreaterThan(0);
      for (const t of masked) {
        expect(JSON.stringify(t.secrets)).toContain("******");
      }
    });
  });

  // ── ①-b db-8：OFFSET 翻页在并列排序值上必须无重复、无遗漏 ──────────────
  describe("db-8：OFFSET 翻页的稳定全序（并列 createdAt 不重复/不遗漏）", () => {
    // 夹具：5 条同一时刻 + 4 条更早（见 makeRows）。同一时刻这 5 行的相对顺序
    // 在单键排序下是**未定义**的——本 spec 的 findAndCount 桩按 order 真实排序，
    // 并把并列组按调用序号轮转，模拟 PG 换计划/换并行顺序（见 sortByOrder）。
    it("缺省 order 是双键 (createdAt DESC, id DESC)", async () => {
      await service.findAll({ page: 1, pageSize: 3 });
      expect((state.lastFindAndCount as any).order).toEqual({
        createdAt: "DESC",
        id: "DESC",
      });
    });

    it("翻完所有页：9 行正好各出现一次（无重复、无遗漏）", async () => {
      const collected: string[] = [];
      let pages = 0;
      for (let page = 1; page <= 5; page++) {
        const res: any = await service.findAll({ page, pageSize: 3 });
        pages += 1;
        for (const t of res.items) collected.push(t.id);
        if (res.items.length < 3) break;
      }
      expect(pages).toBe(4); // 9 行 / 每页 3 → 3 满页 + 1 空页
      expect(collected).toHaveLength(9);
      expect(new Set(collected).size).toBe(9);
      // 顺序也必须是确定的：同一时刻 5 行按 id DESC（夹具里 same-instant-4 最大）
      expect(collected[0]).toBe(
        "ffffffff-ffff-4fff-8fff-000000000004",
      );
    });

    it("sortBy=id 时不重复追加次级键（单键 id 已是全序）", async () => {
      await service.findAll({ page: 1, pageSize: 3, sortBy: "id", sortOrder: "desc" });
      expect((state.lastFindAndCount as any).order).toEqual({ id: "DESC" });
    });
  });

  // ── ② 新路径翻完 N 页不漏不重 ────────────────────────────────────────
  describe("带 cursor：keyset 翻页不漏不重", () => {
    /** 从第一页一路翻到底，返回收集到的 id 序列与页数。 */
    const walkAllPages = async (pageSize: number) => {
      const collected: string[] = [];
      // 首次请求用**空串游标**进入 keyset 模式（OFFSET 分支按设计不下发
      // nextCursor，故空串就是官方引导入口）。
      let cursor: string | null = "";
      let pages = 0;
      for (;;) {
        const res: any = await service.findAll({
          page: 1,
          pageSize,
          cursor: cursor as string,
        });
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

    it("keyset 入口（空串）与 OFFSET 首页返回**同一批行**（两种模式结果一致）", async () => {
      const offset: any = await service.findAll({ page: 1, pageSize: 3 });
      const keyset: any = await service.findAll({
        page: 1,
        pageSize: 3,
        cursor: "",
      });
      // 这是"过渡期两种模式共存"必须成立的性质：同一个"第一页"语义。
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
      // pageSize=3 会把这 5 条同一时刻的行切成 2+2+1，横跨三页——单键排序
      // 在这里必然重复返回或跳过。
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

    it("keyset 分支 page 回显 1（不与 OFFSET 的页码坐标系混用）", async () => {
      const first: any = await service.findAll({
        page: 1,
        pageSize: 2,
        cursor: "",
      });
      const res: any = await service.findAll({
        page: 7, // 调用方若同时传 page，keyset 分支必须忽略它
        pageSize: 2,
        cursor: first.nextCursor,
      });
      expect(res.page).toBe(1);
      expect(res.items[0].id).not.toBe(first.items[0].id);
    });

    it("status 过滤在 keyset 分支同样生效（不与游标条件互相覆盖）", async () => {
      const first: any = await service.findAll({
        page: 1,
        pageSize: 2,
        cursor: "",
      });
      const res: any = await service.findAll({
        page: 1,
        pageSize: 20,
        status: TaskStatus.PAUSED,
        cursor: first.nextCursor,
      });
      expect(res.items.every((r: Row) => r.status === TaskStatus.PAUSED)).toBe(
        true,
      );
      // PAUSED 只有 4 条（older-*），且它们全在游标那批之后
      expect(res.total).toBe(4);
      expect(res.items).toHaveLength(4);
    });

    it("q 关键字过滤在 keyset 分支同样生效（数组 where 经 qb.where 传入后未被游标条件覆盖）", async () => {
      const res: any = await service.findAll({
        page: 1,
        pageSize: 20,
        q: "same-instant",
        cursor: "",
      });
      expect(res.total).toBe(5);
      expect(
        res.items.every((r: Row) => r.name.startsWith("same-instant")),
      ).toBe(true);
    });

    it("排序键与游标元组同源：order 恒为 (createdAt DESC, id DESC)", async () => {
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
      expect(state.lastKeysetOrder).toEqual([
        ["task.createdAt", "DESC"],
        ["task.id", "DESC"],
      ]);
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
      // 必须是行值比较 (task."createdAt", task.id) < (子查询取游标行的精确值)
      expect(predicate).toMatch(
        /\(\s*task\.\"?createdAt\"?\s*,\s*task\.id\s*\)\s*</,
      );
      expect(predicate).toContain("SELECT");
      const params = state.lastKeysetParams as any;
      expect(params.cursorId).toBe(first.items[1].id); // 上一页最后一行
      // ⚠️ 反面断言：绝不能再出现毫秒区间那套（时间参数 at/atNext）
      expect(predicate).not.toContain(":atNext");
      expect(params.at).toBeUndefined();
      expect(params.atNext).toBeUndefined();
    });

    /**
     * ⚠️ 微秒打平的回归防线（本轮真实缺陷的直接防线）。
     *
     * 构造「**同毫秒**、微秒与 id **反序**」的行——这是半开区间漏行的精确触发条件
     * （同毫秒内存在微秒更小但 id 更大的行 → `id < cursorId` 判它不满足 → 漏行）。
     * id 与微秒同序时缺陷不显形，故这里刻意反序。
     */
    it("同毫秒不同微秒的行跨页切开时不漏不重（行值比较才成立）", async () => {
      const ms = new Date("2026-05-06T07:08:09.000Z");
      // 微秒递增 .000100→.000400，而 id 字典序递减（f…→0…）——正好反序
      rowset = [
        { micro: 100, id: "ffffffff-ffff-4fff-8fff-000000000001" },
        { micro: 200, id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000002" },
        { micro: 300, id: "55555555-5555-4555-8555-000000000003" },
        { micro: 400, id: "00000000-0000-4000-8000-000000000004" },
      ].map(({ micro, id }) => ({
        id,
        name: `micro-${micro}`,
        status: TaskStatus.ACTIVE,
        runtime: TaskRuntime.PYTHON,
        applicationId: null,
        projectId: null,
        description: null,
        secrets: null,
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

      const expected = [...rowset].sort(compareDesc).map((r) => r.id);
      expect(collected).toEqual(expected);
      expect(new Set(collected).size).toBe(collected.length);
      expect(collected).toHaveLength(4);
    });

    /**
     * 已知且**有意**的语义：游标行被删除 → 该页为空（不是报错、也不错行）。
     *
     * 行值比较依赖"游标行仍在库里"（子查询按主键取值）。这条用例把它钉成契约：
     * 将来若有人想改回"毫秒近似值硬续"，会先撞上这条断言。
     */
    it("游标行已被删除 → 返回空 items + nextCursor:null（安全提前结束，不错行）", async () => {
      const first: any = await service.findAll({
        page: 1,
        pageSize: 2,
        cursor: "",
      });
      expect(first.nextCursor).toBeTruthy();

      // 删掉游标那一行（它正是上一页的最后一行）
      const cursorRowId = (first.items[1] as Row).id;
      rowset = rowset.filter((r) => r.id !== cursorRowId);
      await build();

      const res: any = await service.findAll({
        page: 1,
        pageSize: 2,
        cursor: first.nextCursor,
      });
      // 空页 + 末页标记：不抛错、不返回游标之前的行
      expect(res.items).toEqual([]);
      expect(res.list).toEqual([]);
      expect(res.nextCursor).toBeNull();
      // total 仍是真实总数（与游标无关）
      expect(res.total).toBe(rowset.length);
    });

    it("F-10 投影在 keyset 分支也生效（?fields= 只选白名单列）", async () => {
      await service.findAll({
        page: 1,
        pageSize: 2,
        cursor: "",
        fields: "id,name",
      });
      expect(state.lastKeysetSelect).toEqual(["task.id", "task.name"]);
    });
  });

  // ── ③ 不可组合的参数 / 非法游标：一律 400，绝不静默 ──────────────────
  describe("cursor 与 sortBy / lastStatus 组合：显式 400 拒绝", () => {
    const expectRejected = async (
      params: Record<string, unknown>,
      detailIncludes: string,
    ) => {
      let caught: unknown;
      try {
        await service.findAll(params as never);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      const err = caught as BadRequestException & { errorCode?: string };
      expect(err.errorCode).toBe("VALIDATION_FAILED");
      const body = err.getResponse() as { params?: { detail?: string } };
      expect(String(body.params?.detail)).toContain(detailIncludes);
      // 关键：**没有**降级去查数据（降级正是死循环/静默错乱的入口）
      expect(taskRepo.findAndCount).not.toHaveBeenCalled();
      expect(taskRepo.createQueryBuilder).not.toHaveBeenCalled();
    };

    it("cursor + sortBy=priority → 400（游标只对 createdAt 序有意义）", async () => {
      await expectRejected(
        { page: 1, pageSize: 2, sortBy: "priority", cursor: "" },
        "sortBy",
      );
      expect(taskRepo.findAndCount).not.toHaveBeenCalled();
      expect(taskRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it("cursor + sortBy=createdAt 也拒（契约只有一种正确姿势，避免恰好正确才放行）", async () => {
      await expectRejected(
        { page: 1, pageSize: 2, sortBy: "createdAt", cursor: "" },
        "sortBy",
      );
    });

    it("cursor + lastStatus → 400（子查询分支不支持游标，明确拒绝而非静默错乱）", async () => {
      await expectRejected(
        {
          page: 1,
          pageSize: 2,
          lastStatus: "success",
          cursor: "",
        },
        "lastStatus",
      );
    });

    it("不带 cursor 时 sortBy / lastStatus 仍正常工作（拒绝是加性的）", async () => {
      // sortBy 单独：走 findAndCount，排序按其指定——证明新守卫没有误伤它。
      const byPriority: any = await service.findAll({
        page: 1,
        pageSize: 2,
        sortBy: "priority",
      });
      expect(taskRepo.findAndCount).toHaveBeenCalled();
      // db-8：主排序键 + id 决胜键（稳定全序，OFFSET 翻页才不漏不重）。
      expect((state.lastFindAndCount as any).order).toEqual({
        priority: "DESC",
        id: "DESC",
      });
      expect("nextCursor" in byPriority).toBe(false);

      // lastStatus 单独：走 findAllByLastStatus 的 QB 分支。本 spec 的假仓库
      // 没有实现 execRepo 的 EXISTS 子查询链（那是既有 task.service.spec.ts 的
      // 职责），故这里**只**断言"没有被新守卫拦截"——判定方式是错误不再是
      // VALIDATION_FAILED 的游标/sortBy 提示，且确实进了 QB 分支。
      let caught: unknown;
      try {
        await service.findAll({
          page: 1,
          pageSize: 2,
          lastStatus: "success",
        } as never);
      } catch (err) {
        caught = err;
      }
      if (caught) {
        // 走到子查询装配阶段才失败 = 守卫已放行（守卫在 findAll 开头抛，
        // 不会走到 execRepo）
        const msg = String((caught as Error).message);
        expect(msg).not.toContain("cursor 不能与");
      }
    });
  });

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
      // 沿用既有通用 400 码 + detail 点名游标
      expect(err.errorCode).toBe("VALIDATION_FAILED");
      const body = err.getResponse() as { params?: { detail?: string } };
      expect(body.params?.detail).toContain("游标");
      // 关键：**没有**降级去查数据（降级正是死循环的入口）
      expect(taskRepo.findAndCount).not.toHaveBeenCalled();
      expect(taskRepo.createQueryBuilder).not.toHaveBeenCalled();
    };

    it("乱码", () => expectBadRequest("not-a-cursor"));
    it("合法 base64 但内容不对", () =>
      expectBadRequest(Buffer.from("hello", "utf8").toString("base64url")));
    it("uuid 不合法", () =>
      expectBadRequest(
        Buffer.from("2026-01-02T03:04:05.123Z|nope", "utf8").toString(
          "base64url",
        ),
      ));
    it("时间不合法（2 月 30 日会被 Date 静默归一化，必须拒绝）", () =>
      expectBadRequest(
        Buffer.from(
          "2026-02-30T00:00:00.000Z|ffffffff-ffff-4fff-8fff-000000000000",
          "utf8",
        ).toString("base64url"),
      ));
    it("字段数不对（三段）", () =>
      expectBadRequest(
        Buffer.from("2026-01-02T03:04:05.123Z|id|extra", "utf8").toString(
          "base64url",
        ),
      ));
  });

  // ── ④ 响应契约：nextCursor 可选，既有 6 键一个不少 ────────────────────
  describe("PaginatedTaskListDto 契约（§2.1 只加不改）", () => {
    it("既有 6 键全部保留（四端消费的字段一个都不能动）", () => {
      const declared = (Reflect.getMetadata(
        DECORATORS.API_MODEL_PROPERTIES_ARRAY,
        PaginatedTaskListDto.prototype,
      ) ?? []) as string[];
      const names = declared.map((n) => n.replace(/^:/, ""));
      for (const key of [
        "list",
        "items",
        "total",
        "page",
        "pageSize",
        "totalPages",
      ]) {
        expect(names).toContain(key);
      }
    });

    it("nextCursor 声明为**可选**（OFFSET 分支不下发它；声明成必填会让契约与真实响应不符）", () => {
      const meta = Reflect.getMetadata(
        DECORATORS.API_MODEL_PROPERTIES,
        PaginatedTaskListDto.prototype,
        "nextCursor",
      ) as Record<string, unknown> | undefined;
      expect(meta).toBeDefined();
      expect(meta?.required).toBe(false);
      expect(meta?.type).toBe(String);
      expect(meta?.nullable).toBe(true);
      expect(String(meta?.description)).toContain("cursor");
    });
  });
});

/**
 * 上述用例依赖的枚举值确实存在于实体（编译期防线：若实体改了名字，这里会先红，
 * 而不是让上面 `as never` 的调用静默通过）。
 */
describe("依赖的实体枚举形状", () => {
  it("TaskStatus / TaskRuntime / TaskTriggerType 取值未变", () => {
    expect(TaskStatus.ACTIVE).toBe("active");
    expect(TaskStatus.PAUSED).toBe("paused");
    expect(TaskStatus.DELETED).toBe("deleted");
    expect(TaskRuntime.PYTHON).toBe("python");
    expect(TaskTriggerType.CRON).toBe("cron");
  });
});
