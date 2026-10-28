import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { getQueueToken } from "@nestjs/bullmq";
import { DataSource } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { TaskService } from "../task.service";
import { Task } from "../entities/task.entity";
import {
  TaskExecution,
  ExecutionStatus,
} from "../entities/task-execution.entity";
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
import { decodeExecutionCursor } from "../../../common/utils/keyset-cursor.util";

/**
 * §2.1 游标分页 · **服务层**定向 spec（GET /tasks/executions/all）。
 *
 * 与 `executions-keyset-pagination.spec.ts`（单任务执行历史）同构，同样钉三条
 * 验收线：
 *   ① 不带 cursor 的旧路径**逐字节等价**（键集合、JSON 形态、SQL 形态不变）；
 *   ② 带 cursor 的新路径**翻完 N 页不漏不重**（5 条同一 createdAt 专打决胜键）；
 *   ③ 非法游标一律 400，绝不静默退回第一页（那会造成翻页死循环）。
 *
 * 外加本端点独有的第四条：**六个全局过滤器必须与游标条件正确 AND 组合**，
 * 且两条路径共用同一份过滤装配——过滤器被游标条件覆盖（或反之）会让结果集
 * 静默变宽/变窄，而 `total` 与 `items` 都不报错。
 *
 * ## 为什么用"内存表 + 真元组过滤"的假仓库
 *
 * 与同目录两个兄弟 spec 同因：只断言 `andWhere` 被调用过证明不了不漏不重——
 * 参数绑错、排序方向反了、决胜键写反，SQL 字符串都能看起来是对的。这里让假
 * 仓库真的按 `(createdAt DESC, id DESC)` 排序、真的执行
 * `(createdAt, id) < (cursorAt, cursorId)` 的字典序比较，于是"翻完所有页收集
 * 到的 id 集合 === 全量 id 集合且无重复"成为可判定的事实。
 */

/** 表里的行：只保留本端点会过滤/排序/回填的列。 */
interface Row {
  id: string;
  taskId: string;
  taskName: string | null;
  status: ExecutionStatus;
  executorAddress: string | null;
  createdAt: Date;
  /**
   * 微秒分量（0–999）。真实列 `timestamp without time zone` 精度 6，实体读出来
   * 才截成毫秒；显式建模微秒才能复现"同毫秒但微秒不同"的漏行条件。
   */
  micro?: number;
  /** tasks 表里该 taskId 对应的名字（taskName 回填用；null = tasks 表无此行）。 */
  readonly taskRowName?: string | null;
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

const TASK_A = "11111111-1111-4111-8111-111111111111";
const TASK_B = "22222222-2222-4222-8222-222222222222";
const SAME_INSTANT = new Date("2026-01-02T03:04:05.123Z");

/**
 * 造一批行：5 条**完全相同**的 createdAt（专打决胜键）+ 4 条不同时刻的
 * + 2 条属于别的任务、别的状态、别的执行器地址的行（供过滤器用例使用）。
 *
 * id 的字典序与插入序**刻意相反**（真实 uuid 随机；若按插入序递增，决胜键
 * 写反了也看不出来）。
 */
function makeRows(): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < 5; i++) {
    rows.push({
      id: `ffffffff-ffff-4fff-8fff-${String(i).padStart(12, "0")}`,
      taskId: TASK_A,
      taskName: "Nightly Report",
      status: ExecutionStatus.SUCCESS,
      executorAddress: "10.0.0.5",
      createdAt: SAME_INSTANT,
    });
  }
  for (let i = 0; i < 4; i++) {
    rows.push({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      taskId: TASK_A,
      taskName: "Nightly Report",
      status: ExecutionStatus.FAILED,
      executorAddress: "10.0.0.5",
      createdAt: new Date(SAME_INSTANT.getTime() - (i + 1) * 1000),
    });
  }
  // 别的任务：既验证"不带 taskId 时也能出现"（全局列表），也供过滤用例使用
  rows.push({
    id: "99999999-9999-4999-8999-999999999999",
    taskId: TASK_B,
    taskName: null, // 行自身无值 → 走 tasks 表回填
    status: ExecutionStatus.RUNNING,
    executorAddress: "10.0.0.9",
    createdAt: new Date("2026-01-02T03:04:00.000Z"),
    taskRowName: "Backfill Target",
  });
  rows.push({
    id: "99999999-9999-4999-8999-888888888888",
    taskId: TASK_B,
    taskName: "Other Name",
    status: ExecutionStatus.SUCCESS,
    executorAddress: "host_b",
    createdAt: new Date("2026-01-02T03:03:00.000Z"),
  });
  return rows;
}

/** 假仓库 + 被记录下来的"最后一次查询形态"。 */
function makeExecRepo(rowset: Row[]) {
  const state = {
    lastFindAndCount: null as unknown,
    lastKeysetPredicate: null as string | null,
    lastKeysetParams: null as Record<string, unknown> | null,
    lastKeysetOrder: [] as Array<[string, string]>,
    lastKeysetSelect: null as unknown,
    lastKeysetFilters: [] as string[],
    lastTake: null as number | null,
    countCalls: 0,
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
    filters: {
      status?: string;
      taskId?: string;
      taskName?: string;
      executorAddress?: string;
      startTime?: string;
      endTime?: string;
    },
    cursorParams: Record<string, unknown> | null,
    take: number | null,
  ): Row[] => {
    let rows = rowset.filter((r) => {
      if (filters.status && r.status !== filters.status) return false;
      if (filters.taskId && r.taskId !== filters.taskId) return false;
      if (
        filters.taskName &&
        !`${r.taskName ?? ""} ${r.taskRowName ?? ""}`
          .toLowerCase()
          .includes(filters.taskName.replace(/%/g, "").toLowerCase())
      ) {
        return false;
      }
      if (
        filters.executorAddress &&
        !String(r.executorAddress ?? "")
          .toLowerCase()
          .includes(filters.executorAddress.replace(/%/g, "").toLowerCase())
      ) {
        return false;
      }
      if (
        filters.startTime &&
        r.createdAt.getTime() < Date.parse(filters.startTime)
      )
        return false;
      if (
        filters.endTime &&
        r.createdAt.getTime() > Date.parse(filters.endTime)
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
        const cursorRow = rowset.find(
          (r) => r.id === String(cursorParams.cursorId),
        );
        // 游标行已被删除 → 行值比较得 NULL → WHERE 为假 → 空页
        rows = cursorRow ? rows.filter((r) => tupleLess(r, cursorRow)) : [];
      }
    }

    rows = [...rows].sort(compareDesc);
    return take == null ? rows : rows.slice(0, take);
  };

  /** 过滤条件一律经 andWhere("… = :key", {key}) 下发；这里按 SQL 文本归类。 */
  const absorbFilter = (
    sql: string,
    params: Record<string, unknown> | undefined,
  ): void => {
    state.lastKeysetFilters.push(sql);
    if (!params) return;
    for (const key of [
      "status",
      "taskId",
      "taskName",
      "executorAddress",
      "startTime",
      "endTime",
    ]) {
      if (key in params) {
        filters[key] = params[key] as string;
      }
    }
  };
  const filters: {
    status?: string;
    taskId?: string;
    taskName?: string;
    executorAddress?: string;
    startTime?: string;
    endTime?: string;
  } = {};

  const repo: any = {
    findAndCount: jest.fn(),
    createQueryBuilder: jest.fn(() => {
      let cursorParams: Record<string, unknown> | null = null;
      let take: number | null = null;
      const qb: any = {
        select: jest.fn((sel: unknown) => {
          state.lastKeysetSelect = sel;
          return qb;
        }),
        orderBy: jest.fn((col: string, dir: string) => {
          state.lastKeysetOrder = [[col, dir]];
          return qb;
        }),
        addOrderBy: jest.fn((col: string, dir: string) => {
          state.lastKeysetOrder = [...state.lastKeysetOrder, [col, dir]];
          return qb;
        }),
        leftJoin: jest.fn(() => qb),
        skip: jest.fn(() => qb),
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
        /**
         * total 语义：**当前 WHERE 下的行数**——与真实 typeorm 一致
         * （`executeCountQuery` 只清 orderBy/limit，WHERE 原样保留）。
         * 因此这里必须用**调用时刻已加的** cursorParams，而不是恒为 null：
         * 恒为 null 会让「先加游标再 COUNT」这种真实缺陷在 mock 里变成绿
         * （mock 比生产更正确的老坑）。生产现在是在加游标之前调它。
         */
        getCount: jest.fn(async () => {
          state.countCalls += 1;
          return runQuery(filters, cursorParams, null).length;
        }),
        // OFFSET 分支的取数入口（keyset 分支不得用它——由 getManyAndCountCalls
        // 计数断言，而不是抛错：抛错会让"顺手在 OFFSET 路径也换成 getMany"
        // 之类的改动以异常形式暴露，掩盖真正的断言失败位置）。
        getManyAndCount: jest.fn(async () => {
          state.getManyAndCountCalls += 1;
          return [
            runQuery(filters, null, take),
            runQuery(filters, null, null).length,
          ];
        }),
      };
      return qb;
    }),
    metadata: {
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
    },
  };

  return { repo, state };
}

describe("§2.1 TaskService.getAllExecutions — OFFSET / keyset 双路径", () => {
  let service: TaskService;
  let rowset: Row[];
  let execRepo: ReturnType<typeof makeExecRepo>["repo"];
  let state: ReturnType<typeof makeExecRepo>["state"];
  let taskRepo: { find: jest.Mock };

  const build = async () => {
    const made = makeExecRepo(rowset);
    execRepo = made.repo;
    state = made.state;
    taskRepo = {
      // taskName 回填：按 taskId 批量取 tasks.name
      find: jest.fn(async (opts: any) => {
        const ids = (opts?.where?.id?._value ?? []) as string[];
        const out: Array<{ id: string; name: string }> = [];
        for (const row of rowset) {
          if (ids.includes(row.taskId) && row.taskRowName) {
            out.push({ id: row.taskId, name: row.taskRowName });
          }
        }
        return out;
      }),
    };
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
        { provide: getRepositoryToken(Task), useValue: taskRepo },
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
      const res: any = await service.getAllExecutions({
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
      const res = await service.getAllExecutions({ page: 1, pageSize: 3 });
      // 手写一份"改动前的期望产物"再序列化比对，而不是只比键集合：
      // JSON 是四端真正看到的东西，undefined 值在那里会被整个丢掉，
      // 这正是旧路径能保持逐字节不变的机制。
      const expected = {
        list: res.list,
        items: res.items,
        total: 11,
        page: 1,
        pageSize: 3,
        totalPages: 4,
      };
      expect(JSON.stringify(res)).toBe(JSON.stringify(expected));
      expect(JSON.stringify(res)).not.toContain("nextCursor");
    });

    it("total 语义不变（全量实数，不是当前页条数）", async () => {
      const res = await service.getAllExecutions({ page: 2, pageSize: 3 });
      // 全局列表：11 条全部计入（两个任务的都在）
      expect(res.total).toBe(11);
      expect(res.items).toHaveLength(3);
      expect(res.totalPages).toBe(4);
      expect(res.page).toBe(2);
    });

    it("仍走 QueryBuilder + getManyAndCount（没被改名/换成 findAndCount）", async () => {
      await service.getAllExecutions({ page: 2, pageSize: 4 });
      expect(execRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(execRepo.findAndCount).not.toHaveBeenCalled();
      // skip/take 与改动前逐字段一致
      const qb = execRepo.createQueryBuilder.mock.results[0].value;
      expect(qb.skip).toHaveBeenCalledWith(4);
      expect(qb.take).toHaveBeenCalledWith(4);
      expect(state.lastKeysetOrder).toEqual([
        ["e.createdAt", "DESC"],
        ["e.id", "DESC"],
      ]);
      // 旧路径的 total 来自 getManyAndCount，不额外发 COUNT
      expect(qb.getManyAndCount).toHaveBeenCalledTimes(1);
      expect(state.countCalls).toBe(0);
    });

    it("status/taskId 过滤：andWhere 形态与改动前逐字一致", async () => {
      await service.getAllExecutions({
        page: 1,
        pageSize: 20,
        status: "success",
        taskId: TASK_A,
      });
      const qb = execRepo.createQueryBuilder.mock.results[0].value;
      expect(qb.andWhere).toHaveBeenCalledWith("e.status = :status", {
        status: "success",
      });
      expect(qb.andWhere).toHaveBeenCalledWith("e.taskId = :taskId", {
        taskId: TASK_A,
      });
    });

    it("taskName 过滤仍保留 tasks 的 leftJoin（匹配 t.name）", async () => {
      await service.getAllExecutions({
        page: 1,
        pageSize: 20,
        taskName: "nightly",
      });
      const qb = execRepo.createQueryBuilder.mock.results[0].value;
      expect(qb.leftJoin).toHaveBeenCalledWith("tasks", "t", "t.id = e.taskId");
      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining("t.name ILIKE"),
        { taskName: "%nightly%" },
      );
    });

    it("taskName 回填语义不变（行自身有值优先，否则批量取 tasks.name）", async () => {
      const res: any = await service.getAllExecutions({
        page: 1,
        pageSize: 20,
      });
      // 行自身无 taskName → 由 tasks 表批量回填
      const backfilled = res.items.find(
        (r: Row) => r.id === "99999999-9999-4999-8999-999999999999",
      );
      expect(backfilled?.taskName).toBe("Backfill Target");
      // 行自身已有 taskName → 不被回填覆盖
      const inline = res.items.find(
        (r: Row) => r.id === "99999999-9999-4999-8999-888888888888",
      );
      expect(inline?.taskName).toBe("Other Name");
      // 回填只发一次批量查询（不是 N+1）
      expect(taskRepo.find).toHaveBeenCalledTimes(1);
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
        const res: any = await service.getAllExecutions({
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
        expect(decodeExecutionCursor(cursor!).createdAt).toBeTruthy();
        expect(pages).toBeLessThan(50); // 死循环保险
      }
      return { collected, pages };
    };

    it("keyset 入口（空串）与 OFFSET 首页返回**同一批行**（两种模式结果一致）", async () => {
      const offset: any = await service.getAllExecutions({
        page: 1,
        pageSize: 3,
      });
      const keyset: any = await service.getAllExecutions({
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

    it("pageSize=2 翻完全部页：恰好覆盖 11 条，无重复、无遗漏", async () => {
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
      expect(collected).toHaveLength(11);
      expect(pages).toBe(11);
    });

    it("末页 nextCursor 为 null，且该键**出现**（与 OFFSET 分支的「键不存在」相对）", async () => {
      const single: any = await service.getAllExecutions({
        page: 1,
        pageSize: 100,
      });
      expect("nextCursor" in single).toBe(false); // OFFSET 分支

      let last: any = await service.getAllExecutions({
        page: 1,
        pageSize: 2,
        cursor: "",
      });
      let guard = 0;
      while (last.nextCursor !== null && guard++ < 50) {
        last = await service.getAllExecutions({
          page: 1,
          pageSize: 2,
          cursor: last.nextCursor,
        });
      }
      expect(last.nextCursor).toBeNull();
      expect("nextCursor" in last).toBe(true);
    });

    it("keyset 分支的 total 仍是**真实总数**（同过滤条件，不受游标影响）", async () => {
      const first: any = await service.getAllExecutions({
        page: 1,
        pageSize: 2,
        cursor: "",
      });
      const second: any = await service.getAllExecutions({
        page: 1,
        pageSize: 2,
        cursor: first.nextCursor,
      });
      // 11 条全量，与第一页一致——不是"剩余条数"、也不是 -1
      expect(second.total).toBe(11);
      expect(second.total).toBe(first.total);
    });

    it("keyset 分支 page 回显 1（不与 OFFSET 的页码坐标系混用）", async () => {
      const first: any = await service.getAllExecutions({
        page: 1,
        pageSize: 2,
        cursor: "",
      });
      const res: any = await service.getAllExecutions({
        page: 7, // 调用方若同时传 page，keyset 分支必须忽略它
        pageSize: 2,
        cursor: first.nextCursor,
      });
      expect(res.page).toBe(1);
      // 且结果确实是"从游标继续"，不是"第 7 页"
      expect(res.items[0].id).not.toBe(first.items[0].id);
    });

    it("多取一行用 getCount 取 total（不调用 getManyAndCount）", async () => {
      await service.getAllExecutions({
        page: 1,
        pageSize: 2,
        cursor: "",
      });
      const qb = execRepo.createQueryBuilder.mock.results[0].value;
      expect(qb.getManyAndCount).not.toHaveBeenCalled();
      expect(state.getManyCalls).toBe(1);
      expect(state.countCalls).toBe(1);
      // 页查询真的多取了一行（hasMore 判定）
      expect(state.lastTake).toBe(3);
    });

    it("PERF-03 投影在 keyset 分支也生效（logs/aiAnalysis 仍被排除）", async () => {
      await service.getAllExecutions({
        page: 1,
        pageSize: 2,
        cursor: "",
      });
      const selectArg = state.lastKeysetSelect as string[];
      expect(selectArg.some((c: string) => c.endsWith(".logs"))).toBe(false);
      expect(selectArg.some((c: string) => c.endsWith(".aiAnalysis"))).toBe(
        false,
      );
      expect(selectArg).toContain("e.id");
    });

    it("SQL 谓词是**行值比较**形态（不是毫秒半开区间——那版在微秒打平时漏/重）", async () => {
      const first: any = await service.getAllExecutions({
        page: 1,
        pageSize: 2,
        cursor: "",
      });
      await service.getAllExecutions({
        page: 1,
        pageSize: 2,
        cursor: first.nextCursor,
      });
      const predicate = state.lastKeysetPredicate as string;
      expect(predicate).toBeTruthy();
      // 必须是行值比较：(e."createdAt", e.id) < (子查询取游标行的精确值)
      expect(predicate).toMatch(/\(\s*e\.\"?createdAt\"?\s*,\s*e\.id\s*\)\s*</);
      expect(predicate).toContain("SELECT");
      expect(predicate).toContain("FROM task_executions c");
      // 参数只有游标行 id（时间由子查询从库里取，不再由 JS 传入）
      const params = state.lastKeysetParams as Record<string, unknown>;
      expect(params.cursorId).toBe(first.items[1].id); // 上一页最后一行
      // ⚠️ 反面断言：绝不能再出现毫秒区间那套（`< :at` / `:atNext`）
      expect(predicate).not.toContain(":atNext");
      expect(params.at).toBeUndefined();
      expect(params.atNext).toBeUndefined();
    });

    /**
     * ⚠️ 微秒打平的回归防线（与兄弟 spec 同因，同一份数据条件）。
     *
     * 4 行同一毫秒、微秒递增、id 字典序**递减**——这是能精确触发"毫秒半开区间
     * 漏行"的条件（微秒更小 = 时间上在游标之后，却 id 更大 → 被判不满足）。
     */
    it("同毫秒不同微秒、且 id 与微秒**反序**时不漏不重（半开区间在此必漏）", async () => {
      const ms = new Date("2026-05-06T07:08:09.000Z");
      rowset = [
        { micro: 100, id: "ffffffff-ffff-4fff-8fff-000000000001" },
        { micro: 200, id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000002" },
        { micro: 300, id: "55555555-5555-4555-8555-000000000003" },
        { micro: 400, id: "00000000-0000-4000-8000-000000000004" },
      ].map(({ micro, id }) => ({
        id,
        taskId: TASK_A,
        taskName: "same-ms",
        status: ExecutionStatus.SUCCESS,
        executorAddress: "10.0.0.5",
        createdAt: ms,
        micro,
      }));
      await build();

      const collected: string[] = [];
      let cursor: string | null = "";
      let pages = 0;
      for (;;) {
        const res: any = await service.getAllExecutions({
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
  });

  // ── ③ 过滤器 × 游标：必须 AND 组合，且共用同一份装配 ──────────────────
  describe("六个过滤器与游标条件正确 AND 组合", () => {
    it("status 过滤在 keyset 分支同样生效（不与游标条件互相覆盖）", async () => {
      const first: any = await service.getAllExecutions({
        page: 1,
        pageSize: 2,
        cursor: "",
      });
      const res: any = await service.getAllExecutions({
        page: 1,
        pageSize: 20,
        status: ExecutionStatus.FAILED,
        cursor: first.nextCursor,
      });
      expect(
        res.items.every((r: Row) => r.status === ExecutionStatus.FAILED),
      ).toBe(true);
      // FAILED 只有 4 条（older-*），total 不受游标影响
      expect(res.total).toBe(4);
      expect(res.items).toHaveLength(4);
    });

    it("taskId 过滤在 keyset 分支同样生效，且翻页只覆盖该任务", async () => {
      const { collected } = await (async () => {
        const out: string[] = [];
        let cursor: string | null = "";
        for (;;) {
          const res: any = await service.getAllExecutions({
            page: 1,
            pageSize: 2,
            taskId: TASK_B,
            cursor: cursor as string,
          });
          expect(res.total).toBe(2); // 恒为该过滤下的总数
          out.push(...res.items.map((r: Row) => r.id));
          cursor = res.nextCursor;
          if (cursor === null) break;
        }
        return { collected: out };
      })();
      expect(collected).toEqual(
        rowset
          .filter((r) => r.taskId === TASK_B)
          .sort(compareDesc)
          .map((r) => r.id),
      );
    });

    it("taskName 过滤在 keyset 分支同样生效（含 tasks.name 回填匹配）", async () => {
      const res: any = await service.getAllExecutions({
        page: 1,
        pageSize: 20,
        taskName: "backfill", // 只命中 tasks 表里的名字
        cursor: "",
      });
      expect(res.total).toBe(1);
      expect(res.items).toHaveLength(1);
      expect(res.items[0].id).toBe("99999999-9999-4999-8999-999999999999");
    });

    it("executorAddress 过滤在 keyset 分支同样生效", async () => {
      const res: any = await service.getAllExecutions({
        page: 1,
        pageSize: 20,
        executorAddress: "10.0.0.9",
        cursor: "",
      });
      expect(res.total).toBe(1);
      expect(res.items[0].executorAddress).toBe("10.0.0.9");
    });

    it("startTime/endTime 时间范围在 keyset 分支同样生效（与游标条件是 AND）", async () => {
      const res: any = await service.getAllExecutions({
        page: 1,
        pageSize: 20,
        // 只保留 5 条同刻行（SAME_INSTANT 前后都不含）
        startTime: "2026-01-02T03:04:05.000Z",
        endTime: "2026-01-02T03:04:05.999Z",
        cursor: "",
      });
      expect(res.total).toBe(5);
      expect(
        res.items.every(
          (r: Row) => r.createdAt.getTime() === SAME_INSTANT.getTime(),
        ),
      ).toBe(true);
    });

    it("过滤器 + 游标组合时，翻页不漏不重（AND 而非覆盖）", async () => {
      const collected: string[] = [];
      let cursor: string | null = "";
      let pages = 0;
      for (;;) {
        const res: any = await service.getAllExecutions({
          page: 1,
          pageSize: 2,
          status: ExecutionStatus.SUCCESS,
          cursor: cursor as string,
        });
        pages++;
        expect(
          res.items.every((r: Row) => r.status === ExecutionStatus.SUCCESS),
        ).toBe(true);
        collected.push(...res.items.map((r: Row) => r.id));
        cursor = res.nextCursor;
        if (cursor === null) break;
        expect(pages).toBeLessThan(20);
      }
      const expected = rowset
        .filter((r) => r.status === ExecutionStatus.SUCCESS)
        .sort(compareDesc)
        .map((r) => r.id);
      expect(collected).toEqual(expected);
      expect(new Set(collected).size).toBe(collected.length);
    });

    /**
     * 单一真值源守卫：两条路径必须发出**同一组**过滤谓词。
     *
     * 这条用例的存在意义是防"复制粘贴第二份 where 构造"——一旦有人把过滤
     * 装配复制进 keyset 分支并只改一处，两条路径的谓词集合就会不同。
     */
    it("OFFSET 与 keyset 两条路径发出同一组过滤谓词（单一真值源）", async () => {
      const params = {
        status: ExecutionStatus.SUCCESS,
        taskId: TASK_A,
        taskName: "nightly",
        executorAddress: "10.0.0",
        startTime: "2026-01-01T00:00:00.000Z",
        endTime: "2026-12-31T23:59:59.000Z",
      } as const;

      await service.getAllExecutions({ page: 1, pageSize: 5, ...params });
      const offsetSql = [...state.lastKeysetFilters];

      // 重建仓库状态，再走 keyset 分支
      await build();
      await service.getAllExecutions({
        page: 1,
        pageSize: 5,
        ...params,
        cursor: "",
      });
      const keysetSql = [...state.lastKeysetFilters];

      expect(keysetSql).toEqual(offsetSql);
      // 有齿校验：确实装配了 6 个过滤器（少一个说明某条件根本没下发）
      expect(offsetSql).toHaveLength(6);
    });
  });

  // ── ④ 非法游标 400，绝不静默退回第一页 ────────────────────────────────
  describe("非法 cursor：一律 400，绝不静默从第一页开始", () => {
    const expectBadRequest = async (cursor: string) => {
      let caught: unknown;
      try {
        await service.getAllExecutions({ page: 1, pageSize: 2, cursor });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      const err = caught as BadRequestException & { errorCode?: string };
      // 与另两个端点同码同文案：调用方只需实现一次处理逻辑
      expect(err.errorCode).toBe("VALIDATION_FAILED");
      const body = err.getResponse() as { params?: { detail?: string } };
      expect(body.params?.detail).toContain("游标");
      // 关键：**没有**降级去查数据（降级正是死循环的入口）
      expect(execRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(execRepo.findAndCount).not.toHaveBeenCalled();
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
          "2026-02-30T03:04:05.123Z|99999999-9999-4999-8999-999999999999",
          "utf8",
        ).toString("base64url"),
      ));
  });
});
