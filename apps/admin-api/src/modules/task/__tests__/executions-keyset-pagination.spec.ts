import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { getQueueToken } from "@nestjs/bullmq";
import { DataSource } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { DECORATORS } from "@nestjs/swagger";
import { TaskService } from "../task.service";
import { Task } from "../entities/task.entity";
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
import { ProjectAccessService } from "../../project/project-access.service";
import { ExecutionStatus } from "../entities/task-execution.entity";
import { PaginatedExecutionListDto } from "../dto/task-response.dto";
import { decodeExecutionCursor } from "../../../common/utils/keyset-cursor.util";

/**
 * §2.1 游标分页 · **服务层**定向 spec（GET /tasks/:id/executions）。
 *
 * 三条验收线，逐条对应任务书：
 *   ① 不带 cursor 的旧路径**逐字节等价**（键集合、total 语义、SQL 形态都不变）；
 *   ② 带 cursor 的新路径**翻完 N 页不漏不重**（造 5 条同一 createdAt 的数据，
 *      专门打决胜键——这是 keyset 唯一真正难写对的地方）；
 *   ③ 非法游标一律 400，绝不静默退回第一页（那会造成翻页死循环）。
 *
 * ## 为什么用一个"内存表 + 真元组过滤"的假仓库，而不是断言 SQL 字符串
 *
 * 只断言 `andWhere` 被调过、或 SQL 里含某个子串，**证明不了不漏不重**——参数绑错、
 * 排序方向反了、决胜键写反、毫秒区间算错，SQL 字符串看起来都可以是对的。这里
 * 让假仓库真的按 `(createdAt DESC, id DESC)` 排序并真的执行
 * `(createdAt, id) < (cursorAt, cursorId)` 的**字典序比较**，于是"翻完所有页
 * 收集到的 id 集合 === 全量 id 集合且无重复"成为一个可判定的事实。
 */

/** 表里的行（createdAt 用毫秒精度的 Date，与实体读出来的一致）。 */
interface Row {
  id: string;
  taskId: string;
  status: ExecutionStatus;
  createdAt: Date;
}

const TASK_ID = "task-1";

/** 造一批行：`count` 条同一 createdAt（专打决胜键）+ 不同时刻的行。 */
function makeRows(): Row[] {
  const sameInstant = new Date("2026-01-02T03:04:05.123Z");
  const rows: Row[] = [];
  // 5 条**完全相同**的 createdAt——单键排序下必然漏/重，决胜键才救得回来
  for (let i = 0; i < 5; i++) {
    rows.push({
      // uuid v4 形状，且字典序与插入序**刻意相反**（真实 uuid 是随机的，
      // 若这里按插入序递增，决胜键写反了也看不出来）
      id: `ffffffff-ffff-4fff-8fff-${String(i).padStart(12, "0")}`,
      taskId: TASK_ID,
      status: ExecutionStatus.SUCCESS,
      createdAt: sameInstant,
    });
  }
  // 更早的 4 条，各差 1 秒
  for (let i = 0; i < 4; i++) {
    rows.push({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      taskId: TASK_ID,
      status: ExecutionStatus.SUCCESS,
      createdAt: new Date(sameInstant.getTime() - (i + 1) * 1000),
    });
  }
  // 别的任务的行：绝不能出现在结果里
  rows.push({
    id: "99999999-9999-4999-8999-999999999999",
    taskId: "other-task",
    status: ExecutionStatus.SUCCESS,
    createdAt: new Date(),
  });
  return rows;
}

/** 字典序比较 `(createdAt, id)`：DESC 用 `>` 表示"排在前面"。 */
const compareDesc = (a: Row, b: Row): number => {
  const t = b.createdAt.getTime() - a.createdAt.getTime();
  if (t !== 0) return t;
  // id DESC
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
};

/**
 * 假仓库：真的排序 + 真的执行游标过滤 + 真的分页。
 *
 * 同时记录最后一次 `findAndCount` 的入参，供"旧路径逐字节等价"的断言使用。
 */
function makeExecRepo(rowset: Row[]) {
  const state = {
    lastFindAndCount: null as unknown,
    lastCountWhere: null as unknown,
    lastKeysetSql: null as string | null,
    lastKeysetParams: null as unknown,
  };

  /** 从 QueryBuilder 链上抓到的条件，模拟 PG 执行。 */
  const runKeysetQuery = (
    filters: { taskId?: string; status?: string },
    cursorCond: { at: string; atNext: Date; cursorId: string } | null,
    take: number,
  ): { rows: Row[]; sql: string; params: unknown } => {
    let rows = rowset.filter((r) => r.taskId === filters.taskId);
    if (filters.status) rows = rows.filter((r) => r.status === filters.status);
    if (cursorCond) {
      const at = new Date(cursorCond.at);
      const atNext = new Date(cursorCond.atNext);
      rows = rows.filter((r) => {
        // 与生产 SQL 逐字节同构的谓词：
        //   (createdAt < :at OR (createdAt < :atNext AND id < :cursorId))
        if (r.createdAt.getTime() < at.getTime()) return true;
        if (r.createdAt.getTime() < atNext.getTime()) {
          return r.id < cursorCond.cursorId;
        }
        return false;
      });
    }
    rows = [...rows].sort(compareDesc);
    return {
      rows: rows.slice(0, take),
      sql:
        "SELECT e.* FROM task_executions e WHERE e.taskId = $1" +
        (filters.status ? " AND e.status = $2" : "") +
        (cursorCond
          ? " AND (e.createdAt < $3 OR (e.createdAt < $4 AND e.id < $5))"
          : "") +
        " ORDER BY e.createdAt DESC, e.id DESC LIMIT $6",
      params: { ...filters, ...(cursorCond ?? {}), take },
    };
  };

  const repo = {
    findAndCount: jest.fn(async (opts: any) => {
      state.lastFindAndCount = opts;
      const where = opts.where ?? {};
      let rows = rowset.filter((r) => r.taskId === where.taskId);
      if (where.status) rows = rows.filter((r) => r.status === where.status);
      rows = [...rows].sort(compareDesc);
      const skip = opts.skip ?? 0;
      const take = opts.take ?? rows.length;
      return [rows.slice(skip, skip + take), rows.length];
    }),
    count: jest.fn(async (opts: any) => {
      state.lastCountWhere = opts?.where;
      const where = opts?.where ?? {};
      let rows = rowset.filter((r) => r.taskId === where.taskId);
      if (where.status) rows = rows.filter((r) => r.status === where.status);
      return rows.length;
    }),
    createQueryBuilder: jest.fn(() => {
      const filters: { taskId?: string; status?: string } = {};
      let cursorCond: { at: string; atNext: Date; cursorId: string } | null =
        null;
      let take = 20;
      const qb: any = {
        select: jest.fn(() => qb),
        orderBy: jest.fn(() => qb),
        addOrderBy: jest.fn(() => qb),
        skip: jest.fn(() => qb),
        take: jest.fn((n: number) => {
          take = n;
          return qb;
        }),
        where: jest.fn((sql: string, params: any) => {
          if (/taskId/.test(sql)) filters.taskId = params.taskId;
          if (/status/.test(sql)) filters.status = params.status;
          return qb;
        }),
        andWhere: jest.fn((sql: string, params: any) => {
          if (/status/.test(sql)) filters.status = params.status;
          if (/createdAt/.test(sql) && params?.at) {
            cursorCond = {
              at: params.at,
              atNext: params.atNext,
              cursorId: params.cursorId,
            };
          }
          return qb;
        }),
        getMany: jest.fn(async () => {
          const out = runKeysetQuery(filters, cursorCond, take);
          state.lastKeysetSql = out.sql;
          state.lastKeysetParams = out.params;
          return out.rows;
        }),
        getRawMany: jest.fn(async () => []),
        getOne: jest.fn(async () => null),
      };
      return qb;
    }),
    metadata: { columns: TaskExecution.prototype ? [] : [] },
  } as any;

  // 列元数据：投影 helper 靠它派生 select 清单（生产从 TypeORM 元数据取）。
  repo.metadata = {
    columns: [
      "id",
      "taskId",
      "taskName",
      "status",
      "executorAddress",
      "startTime",
      "endTime",
      "duration",
      "errorMessage",
      "result",
      "logs",
      "aiAnalysis",
      "createdAt",
    ].map((propertyName) => ({ propertyName })),
  };

  return { repo, state };
}

describe("§2.1 TaskService.getExecutions — OFFSET / keyset 双路径", () => {
  let service: TaskService;
  let rowset: Row[];
  let execRepo: ReturnType<typeof makeExecRepo>["repo"];
  let state: ReturnType<typeof makeExecRepo>["state"];

  const build = async () => {
    const made = makeExecRepo(rowset);
    execRepo = made.repo;
    state = made.state;
    const noopRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      save: jest.fn((e: unknown) => Promise.resolve(e)),
      create: jest.fn((e: unknown) => e),
    };
    const module = await Test.createTestingModule({
      providers: [
        TaskService,
        { provide: getRepositoryToken(Task), useValue: noopRepo },
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
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
        {
          provide: ProjectAccessService,
          useValue: {
            hasProjectRole: jest.fn().mockResolvedValue(false),
            resolveRole: jest.fn().mockResolvedValue(null),
          },
        },
      ],
    }).compile();
    service = module.get(TaskService);
  };

  beforeEach(async () => {
    rowset = makeRows();
    await build();
  });

  // ── ① 旧路径逐字节等价 ───────────────────────────────────────────────
  describe("不带 cursor：旧路径逐字节不变", () => {
    it("响应对象的键集合与改动前完全一致（**没有** nextCursor 键）", async () => {
      const res: any = await service.getExecutions(TASK_ID, {
        page: 1,
        pageSize: 20,
      });

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
      const res = await service.getExecutions(TASK_ID, {
        page: 1,
        pageSize: 3,
      });
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

    it("total 语义不变（全量实数，不是当前页条数）", async () => {
      const res = await service.getExecutions(TASK_ID, {
        page: 2,
        pageSize: 3,
      });
      // 9 条属于本任务（别的任务的 1 条不计入）
      expect(res.total).toBe(9);
      expect(res.items).toHaveLength(3);
      expect(res.totalPages).toBe(3);
      expect(res.page).toBe(2);
    });

    it("仍走 findAndCount + skip/take（没有偷换成 QueryBuilder）", async () => {
      await service.getExecutions(TASK_ID, { page: 2, pageSize: 4 });
      expect(execRepo.findAndCount).toHaveBeenCalledTimes(1);
      expect(execRepo.createQueryBuilder).not.toHaveBeenCalled();
      const opts = state.lastFindAndCount as any;
      // skip/take/order 与改动前逐字段一致
      expect(opts.skip).toBe(4);
      expect(opts.take).toBe(4);
      expect(opts.order).toEqual({ createdAt: "DESC", id: "DESC" });
      expect(opts.where).toEqual({ taskId: TASK_ID });
      // PERF-03 投影仍在（logs/aiAnalysis 必须继续被排除）
      expect(opts.select.logs).toBeUndefined();
      expect(opts.select.aiAnalysis).toBeUndefined();
      expect(opts.select.id).toBe(true);
    });

    it("status 过滤：where 与改动前同形", async () => {
      await service.getExecutions(TASK_ID, {
        page: 1,
        pageSize: 20,
        status: "success",
      });
      const opts = state.lastFindAndCount as any;
      expect(opts.where).toEqual({ taskId: TASK_ID, status: "success" });
    });

    it("空串 cursor 是**显式的 keyset 起点**，不是「没传游标」", async () => {
      const res: any = await service.getExecutions(TASK_ID, {
        page: 1,
        pageSize: 2,
        cursor: "",
      });
      // 走 keyset 分支（QueryBuilder），而不是 OFFSET 的 findAndCount
      expect(execRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(execRepo.findAndCount).not.toHaveBeenCalled();
      // 且下发游标——否则客户端永远拿不到第一个游标（OFFSET 分支不返回它）
      expect(typeof res.nextCursor).toBe("string");
      // 起点无下界：第一页就是最新的一批
      const expectedFirst = rowset
        .filter((r) => r.taskId === TASK_ID)
        .sort(compareDesc)
        .slice(0, 2)
        .map((r) => r.id);
      expect(res.items.map((r: Row) => r.id)).toEqual(expectedFirst);
      expect(res.total).toBe(9);
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
        const res: any = await service.getExecutions(TASK_ID, {
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
        expect(decodeExecutionCursor(cursor!).createdAt).toBeTruthy();
        expect(pages).toBeLessThan(50); // 死循环保险
      }
      return { collected, pages };
    };

    it("keyset 入口（空串）与 OFFSET 首页返回**同一批行**（两种模式结果一致）", async () => {
      const offset: any = await service.getExecutions(TASK_ID, {
        page: 1,
        pageSize: 3,
      });
      const keyset: any = await service.getExecutions(TASK_ID, {
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
      const expected = rowset
        .filter((r) => r.taskId === TASK_ID)
        .sort(compareDesc)
        .map((r) => r.id);

      expect(collected).toHaveLength(expected.length);
      expect(new Set(collected).size).toBe(collected.length); // 无重复
      expect(collected).toEqual(expected); // 顺序正确且无遗漏
    });

    it("同一 createdAt 的 5 条被跨页切开时也不漏不重（决胜键生效）", async () => {
      // pageSize=3 会把这 5 条同一时刻的行切成 2+2+1，横跨三页——单键排序
      // 在这里必然重复返回或跳过。
      const { collected } = await walkAllPages(3);
      // 精确取"最早那一秒"的 5 条（makeRows 里 only 这 5 条共享同一时刻）
      const sameInstant = rowset.filter(
        (r) =>
          r.taskId === TASK_ID &&
          r.createdAt.getTime() ===
            new Date("2026-01-02T03:04:05.123Z").getTime(),
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
      const single: any = await service.getExecutions(TASK_ID, {
        page: 1,
        pageSize: 100,
      });
      expect("nextCursor" in single).toBe(false); // OFFSET 分支

      // 从 keyset 起点一路翻到末页
      let last: any = await service.getExecutions(TASK_ID, {
        page: 1,
        pageSize: 2,
        cursor: "",
      });
      let guard = 0;
      while (last.nextCursor !== null && guard++ < 50) {
        last = await service.getExecutions(TASK_ID, {
          page: 1,
          pageSize: 2,
          cursor: last.nextCursor,
        });
      }
      expect(last.nextCursor).toBeNull();
      expect("nextCursor" in last).toBe(true);
    });

    it("keyset 分支的 total 仍是**真实总数**（不返回 -1/近似值撒谎）", async () => {
      const first: any = await service.getExecutions(TASK_ID, {
        page: 1,
        pageSize: 2,
        cursor: "",
      });
      const second: any = await service.getExecutions(TASK_ID, {
        page: 1,
        pageSize: 2,
        cursor: first.nextCursor,
      });
      // 9 条全量，与第一页一致——不是"剩余条数"、也不是 -1
      expect(second.total).toBe(9);
      expect(second.total).toBe(first.total);
    });

    it("keyset 分支 page 回显 1（不与 OFFSET 的页码坐标系混用）", async () => {
      const first: any = await service.getExecutions(TASK_ID, {
        page: 1,
        pageSize: 2,
        cursor: "",
      });
      const res: any = await service.getExecutions(TASK_ID, {
        page: 7, // 调用方若同时传 page，keyset 分支必须忽略它
        pageSize: 2,
        cursor: first.nextCursor,
      });
      expect(res.page).toBe(1);
      // 且结果确实是"从游标继续"，不是"第 7 页"
      expect(res.items[0].id).not.toBe(first.items[0].id);
    });

    it("status 过滤在 keyset 分支同样生效（不与游标条件互相覆盖）", async () => {
      rowset = rowset.map((r) => ({ ...r }));
      rowset
        .filter((r) => r.taskId === TASK_ID)
        .forEach((r, i) => {
          r.status =
            i % 2 === 0 ? ExecutionStatus.SUCCESS : ExecutionStatus.FAILED;
        });
      await build();

      const first: any = await service.getExecutions(TASK_ID, {
        page: 1,
        pageSize: 2,
        cursor: "",
      });
      const res: any = await service.getExecutions(TASK_ID, {
        page: 1,
        pageSize: 2,
        status: "failed",
        cursor: first.nextCursor,
      });
      expect(
        res.items.every((r: Row) => r.status === ExecutionStatus.FAILED),
      ).toBe(true);
    });

    it("SQL 谓词是毫秒半开区间形态（微秒精度下列不会因截断而重复返回）", async () => {
      const first: any = await service.getExecutions(TASK_ID, {
        page: 1,
        pageSize: 2,
        cursor: "",
      });
      await service.getExecutions(TASK_ID, {
        page: 1,
        pageSize: 2,
        cursor: first.nextCursor,
      });
      // 断言形态而非具体值：`(createdAt < :at OR (createdAt < :atNext AND id < :cursorId))`
      const params = state.lastKeysetParams as any;
      expect(params.at).toBeTruthy();
      expect(params.atNext).toBeInstanceOf(Date);
      // atNext 恰好是 at + 1ms（毫秒桶的上界，左闭右开）
      expect(
        (params.atNext as Date).getTime() - new Date(params.at).getTime(),
      ).toBe(1);
      expect(params.cursorId).toBe(first.items[1].id); // 上一页最后一行
      // 谓词里**必须**是 `< :at`；写成 `<=` 会让游标那一行被再次返回（死循环）。
      // 取最近一次 QueryBuilder（第二次调用才是带游标的那次）。
      const qbs = execRepo.createQueryBuilder.mock.results;
      const qb = qbs[qbs.length - 1].value;
      const predicate = (qb.andWhere.mock.calls as unknown[][])
        .map((c) => String(c[0]))
        .find((s) => s.includes("createdAt"));
      expect(predicate).toBeDefined();
      expect(predicate).toContain("e.createdAt < :at");
      expect(predicate).not.toContain("<=");
    });

    it("PERF-03 投影在 keyset 分支也生效（logs/aiAnalysis 仍被排除）", async () => {
      const first: any = await service.getExecutions(TASK_ID, {
        page: 1,
        pageSize: 2,
        cursor: "",
      });
      await service.getExecutions(TASK_ID, {
        page: 1,
        pageSize: 2,
        cursor: first.nextCursor,
      });
      const qb = execRepo.createQueryBuilder.mock.results[0].value;
      const selectArg = qb.select.mock.calls[0][0] as string[];
      expect(selectArg.some((c: string) => c.endsWith(".logs"))).toBe(false);
      expect(selectArg.some((c: string) => c.endsWith(".aiAnalysis"))).toBe(
        false,
      );
      expect(selectArg).toContain("e.id");
    });
  });

  // ── ③ 非法游标 400，绝不静默退回第一页 ────────────────────────────────
  describe("非法 cursor：一律 400，绝不静默从第一页开始", () => {
    const expectBadRequest = async (cursor: string) => {
      let caught: unknown;
      try {
        await service.getExecutions(TASK_ID, { page: 1, pageSize: 2, cursor });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      const err = caught as BadRequestException & { errorCode?: string };
      // 沿用既有通用 400 码 + detail 点名游标（新增专用码会让
      // check:error-i18n-drift 变红，而本轮禁止改 apps/admin-web 重新生成产物）
      expect(err.errorCode).toBe("VALIDATION_FAILED");
      const body = err.getResponse() as { params?: { detail?: string } };
      expect(body.params?.detail).toContain("游标");
      // 关键：**没有**降级去查数据（降级正是死循环的入口）
      expect(execRepo.findAndCount).not.toHaveBeenCalled();
      expect(execRepo.createQueryBuilder).not.toHaveBeenCalled();
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
    it("时间不合法", () =>
      expectBadRequest(
        Buffer.from(
          "2026-02-30T00:00:00.000Z|ffffffff-ffff-4fff-8fff-000000000000",
          "utf8",
        ).toString("base64url"),
      ));
  });

  // ── ④ 响应契约：nextCursor 进 OpenAPI，且既有 6 键一个不少 ────────────
  describe("PaginatedExecutionListDto 契约（§2.1 只加不改）", () => {
    it("既有 6 键全部保留（四端消费的字段一个都不能动）", () => {
      const declared = (Reflect.getMetadata(
        DECORATORS.API_MODEL_PROPERTIES_ARRAY,
        PaginatedExecutionListDto.prototype,
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
        PaginatedExecutionListDto.prototype,
        "nextCursor",
      ) as Record<string, unknown> | undefined;
      expect(meta).toBeDefined();
      // ApiPropertyOptional 的产物是 required: false
      expect(meta?.required).toBe(false);
      // 类型必须是 string|null 的表达（nullable），不是 array/object
      expect(meta?.type).toBe(String);
      expect(meta?.nullable).toBe(true);
      // 描述里必须写清"出现在什么条件下"——否则调用方会以为它恒存在
      expect(String(meta?.description)).toContain("cursor");
    });
  });
});
