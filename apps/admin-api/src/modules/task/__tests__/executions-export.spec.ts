import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { getQueueToken } from "@nestjs/bullmq";
import { DataSource } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { TaskService } from "../task.service";
import { Task } from "../entities/task.entity";
import {
  ExecutionStatus,
  TaskExecution,
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
import { TaskController } from "../task.controller";
import { ExportExecutionsQueryDto } from "../dto/execution-query.dto";
import { ROLES_KEY } from "../../../common/decorators/roles.decorator";
import { UserRole } from "../../users/entities/user.entity";
import { ValidationPipe } from "@nestjs/common";
import {
  csvTruncationMarker,
  escapeCsvCell,
  toCsvRow,
} from "../../../common/utils/csv-export.util";

/**
 * `GET /tasks/executions/export`（流式 CSV 导出）定向 spec。
 *
 * ## 为什么要用"内存表 + 真判据"的假仓库
 *
 * 本端点最要紧的两条验收线都是**数据性质**而非调用形态：
 *   ① 公式注入防护——`=HYPERLINK("http://x")` 落在导出的 `errorMessage` 列时
 *      必须被前缀单引号（安全断言，不能省）；
 *   ② 截断有痕——行数达上限时文件末尾出现 `# truncated at N rows`。
 * 只断言 "res.write 被调用过" 对这两条毫无意义。故这里的假 QueryBuilder
 * **真的执行** `take` 与键集下界（行值比较 `(createdAt, id) < 游标`），于是
 * "翻页拿到的行集合 === 过滤后的全量、且无重复"成为可判定的事实。
 *
 * ## 覆盖矩阵（需求指定的五项 + 背压）
 *
 *   · CSV 公式注入（`=` / `+` / `-` / `@` / 制表符 / 回车 六种前缀）
 *   · 截断有痕（达上限追加注释行；未达上限**不**出现）
 *   · 过滤生效（status / taskId 生效，且与列表端点共用同一份装配）
 *   · 鉴权（ADMIN metadata 存在，非 ADMIN 被 RolesGuard 拒绝）
 *   · 空结果（只有表头，不报错）
 *   · 背压（write 返回 false 时必须等 drain 才继续写）
 */

/** 表里的行：只保留本端点会过滤/排序/导出的列。 */
interface Row {
  id: string;
  taskId: string;
  taskName: string;
  status: ExecutionStatus;
  triggerType: string | null;
  executorId: string | null;
  executorAddress: string | null;
  createdAt: Date;
  startTime: Date | null;
  endTime: Date | null;
  duration: number | null;
  retryCount: number;
  exitCode: number | null;
  failureReason: string | null;
  errorMessage: string | null;
}

const TASK_A = "11111111-1111-4111-8111-111111111111";
const TASK_B = "22222222-2222-4222-8222-222222222222";

function makeRow(over: Partial<Row> & { id: string }): Row {
  return {
    taskId: TASK_A,
    taskName: "Nightly Report",
    status: ExecutionStatus.SUCCESS,
    triggerType: "cron",
    executorId: "33333333-3333-4333-8333-333333333333",
    executorAddress: "10.0.0.5",
    createdAt: new Date("2026-01-02T03:04:05.000Z"),
    startTime: new Date("2026-01-02T03:04:06.000Z"),
    endTime: new Date("2026-01-02T03:09:06.000Z"),
    duration: 300_000,
    retryCount: 0,
    exitCode: 0,
    failureReason: null,
    errorMessage: null,
    ...over,
  };
}

/** `(createdAt, id) < (cursor.createdAt, cursor.id)`——DESC 语义的行值比较。 */
const tupleLess = (a: Row, cursor: Row): boolean => {
  const ta = a.createdAt.getTime();
  const tc = cursor.createdAt.getTime();
  if (ta !== tc) return ta < tc;
  return a.id < cursor.id;
};

/** 字典序比较，DESC：a 排在 b 前面返回正数。 */
const compareDesc = (a: Row, b: Row): number => {
  const t = b.createdAt.getTime() - a.createdAt.getTime();
  if (t !== 0) return t;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
};

/**
 * 假仓库：按 QueryBuilder 链上抓到的条件**真的**过滤 + 排序 + 取 N 行。
 *
 * 键集续页按生产实际发出的谓词形态执行（`(e.createdAt, e.id) < (SELECT …)`），
 * 游标行从内存表按 id 取**精确**值——不替生产做任何转换（mock 比生产"更正确"
 * 是 ADR-008 记录过的老坑）。
 */
function makeExecRepo(rowset: Row[]) {
  const state = {
    /** 每次 `andWhere` 的 (sql, params)，按调用序。 */
    filters: [] as Array<{ sql: string; params: Record<string, unknown> }>,
    /** 每次 `take(n)`，按调用序（用于断言分页真正发生）。 */
    takes: [] as number[],
    /** `getMany` 实际被调用的次数。 */
    getManyCalls: 0,
  };

  const repo: any = {
    createQueryBuilder: jest.fn(() => {
      const bounds: Record<string, unknown> = {};
      let take: number | null = null;
      const qb: any = {
        select: jest.fn(() => qb),
        orderBy: jest.fn(() => qb),
        addOrderBy: jest.fn(() => qb),
        leftJoin: jest.fn(() => qb),
        skip: jest.fn(() => qb),
        take: jest.fn((n: number) => {
          take = n;
          state.takes.push(n);
          return qb;
        }),
        where: jest.fn((sql: string, params: Record<string, unknown>) => {
          state.filters.push({ sql, params });
          Object.assign(bounds, params);
          return qb;
        }),
        andWhere: jest.fn((sql: string, params: Record<string, unknown>) => {
          state.filters.push({ sql, params });
          Object.assign(bounds, params);
          return qb;
        }),
        getMany: jest.fn(async () => {
          state.getManyCalls += 1;
          let rows = rowset.filter((r) => {
            if (bounds.status && r.status !== bounds.status) return false;
            if (bounds.taskId && r.taskId !== bounds.taskId) return false;
            if (
              bounds.taskName &&
              !`${r.taskName ?? ""}`
                .toLowerCase()
                .includes(
                  String(bounds.taskName).replace(/%/g, "").toLowerCase(),
                )
            ) {
              return false;
            }
            if (
              bounds.executorAddress &&
              !String(r.executorAddress ?? "")
                .toLowerCase()
                .includes(
                  String(bounds.executorAddress)
                    .replace(/%/g, "")
                    .toLowerCase(),
                )
            ) {
              return false;
            }
            if (
              bounds.startTime &&
              r.createdAt.getTime() < Date.parse(String(bounds.startTime))
            ) {
              return false;
            }
            if (
              bounds.endTime &&
              r.createdAt.getTime() > Date.parse(String(bounds.endTime))
            ) {
              return false;
            }
            return true;
          });
          rows = [...rows].sort(compareDesc);
          if (bounds.cursorId) {
            const cursorRow = rowset.find(
              (r) => r.id === String(bounds.cursorId),
            );
            // 游标行被并发删除 → 行值比较得 NULL → WHERE 为假 → 空页
            rows = cursorRow ? rows.filter((r) => tupleLess(r, cursorRow)) : [];
          }
          return take == null ? rows : rows.slice(0, take);
        }),
      };
      return qb;
    }),
    metadata: {
      // 实体列全集（PERF-03 投影按"全集 − 排除表"算，这里给全）
      columns: [
        "id",
        "taskId",
        "taskName",
        "status",
        "executorId",
        "executorAddress",
        "logs",
        "logStorage",
        "logObjectKey",
        "result",
        "params",
        "startTime",
        "endTime",
        "duration",
        "retryCount",
        "errorMessage",
        "failureReason",
        "exitCode",
        "aiAnalysis",
        "artifacts",
        "triggerType",
        "taskVersion",
        "traceId",
        "resolvedPackageUrl",
        "resolvedPackageVersion",
        "createdAt",
        "depsFiredAt",
        "mutexGroupId",
        "version",
      ].map((propertyName) => ({ propertyName })),
    },
  };

  return { repo, state };
}

async function buildService(rowset: Row[]) {
  const made = makeExecRepo(rowset);
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
      { provide: getRepositoryToken(TaskExecution), useValue: made.repo },
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
  return { service: module.get(TaskService), ...made };
}

/** 收集写出内容的小工具（模拟 res.write 的"只进不出"）。 */
function collector() {
  const chunks: string[] = [];
  const write = jest.fn(async (chunk: string) => {
    chunks.push(chunk);
  });
  return {
    write,
    chunks,
    get text() {
      return chunks.join("");
    },
    get lines() {
      // 流式写法每页末尾都带换行，故末元素恒为空串——去掉它再比对
      const all = chunks.join("").split("\n");
      if (all.length > 0 && all[all.length - 1] === "") all.pop();
      return all;
    },
  };
}

describe("GET /tasks/executions/export — 执行记录 CSV 流式导出", () => {
  let service: TaskService;
  let state: ReturnType<typeof makeExecRepo>["state"];
  let rowset: Row[];

  const build = async () => {
    const made = await buildService(rowset);
    service = made.service;
    state = made.state;
  };

  describe("CSV 公式注入防护（安全断言）", () => {
    it("errorMessage = '=HYPERLINK(\"http://x\")' 被前缀单引号", async () => {
      rowset = [
        makeRow({
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          status: ExecutionStatus.FAILED,
          errorMessage: '=HYPERLINK("http://x")',
        }),
      ];
      await build();
      const out = collector();

      await service.streamExecutionsCsv({}, out.write);

      const row = out.lines[1];
      // 单引号前缀是唯一被 Excel / Google Sheets 共同认可的"这是字面文本"标记。
      expect(row).toContain(`'=HYPERLINK`);
      // 单元格含逗号/双引号 → 同时被 RFC 4180 引号包裹（两条防护叠加生效）。
      expect(row).toContain('"\'=HYPERLINK(""http://x"")"');
      // 关键反面断言：绝不能出现**裸**公式（行内 `,"=` 表示未加前缀）
      expect(row).not.toMatch(/,"=/);
    });

    it.each([
      ["=", "=1+1"],
      ["+", "+1+1"],
      ["-", "-1+1"],
      ["@", "@SUM(1)"],
      ["\t", "\t=1+1"],
      ["\r", "\r=1+1"],
    ])(
      "前缀 %j 的单元格被加单引号（OWASP 六种口径全覆盖）",
      async (_name, evil) => {
        // 直接钉纯函数：六种前缀各写一条，避免"只测了 = 就以为都覆盖了"。
        // 注意剥离可能存在的 RFC4180 外层引号——`\r` 这类值同时会触发引号包裹，
        // 此时防注入单引号在**引号内部第一位**（这才是正确形态，见 util 头注）。
        const cell = escapeCsvCell(evil);
        const inner = cell.startsWith('"') ? cell.slice(1) : cell;
        expect(inner.startsWith("'")).toBe(true);
      },
    );

    it("普通文本不被改写（防误伤）", () => {
      expect(escapeCsvCell("nightly report")).toBe("nightly report");
      expect(escapeCsvCell(0)).toBe("0");
      expect(escapeCsvCell(null)).toBe("");
      expect(escapeCsvCell(undefined)).toBe("");
    });

    it("单独 \\r 也会触发 RFC 4180 引号包裹（否则会把一行切成两行）", () => {
      expect(escapeCsvCell("a\rb")).toBe('"a\rb"');
    });

    it("注入防护在引号包裹**之前**做（顺序反了内容会多一个单引号）", () => {
      // 期望形态：外层是 RFC4180 引号，内层第一个字符是防注入单引号。
      const cell = escapeCsvCell("=A1,B1");
      expect(cell).toBe('"\'=A1,B1"');
      // 反面形态（先包裹后加前缀）会得到 `"'=A1,B1"` 之外的东西，例如
      // 把引号也包进去：`"'=A1,B1'"` —— 这种形态 Excel 会显示多余引号。
      expect(cell).not.toBe("\"'=A1,B1'\"");
    });
  });

  describe("截断有痕", () => {
    it("行数达 limit 时文件末尾出现 `# truncated at N rows` 注释行", async () => {
      rowset = Array.from({ length: 5 }, (_, i) =>
        makeRow({
          id: `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${i}`,
          createdAt: new Date(2026, 0, 2, 3, 4, 5 - i),
        }),
      );
      await build();
      const out = collector();

      const result = await service.streamExecutionsCsv({}, out.write, {
        limit: 3,
      });

      expect(result).toEqual({ rows: 3, truncated: true });
      expect(out.lines[out.lines.length - 1]).toBe(csvTruncationMarker(3));
      expect(out.lines[out.lines.length - 1]).toBe("# truncated at 3 rows");
      // 注释行本身是纯文本：无逗号、不被引号包裹（人能一眼看见）
      expect(out.lines[out.lines.length - 1]).not.toContain(",");
      expect(out.lines[out.lines.length - 1]).not.toContain('"');
      // 表头 + 3 行数据 + 1 行注释
      expect(out.lines).toHaveLength(5);
    });

    it("未达上限时不出现截断注释行（不能「永远警告」）", async () => {
      rowset = Array.from({ length: 2 }, (_, i) =>
        makeRow({ id: `aaaaaaaa-aaaa-4aaa-8aaa-00000000010${i}` }),
      );
      await build();
      const out = collector();

      const result = await service.streamExecutionsCsv({}, out.write, {
        limit: 100,
      });

      expect(result).toEqual({ rows: 2, truncated: false });
      expect(out.text).not.toContain("# truncated at");
      expect(out.lines).toHaveLength(3); // header + 2
    });

    it("limit 超过硬顶（50000）时归一到硬顶，不报错", async () => {
      rowset = [makeRow({ id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000200" })];
      await build();
      const out = collector();

      // 归一发生在 cap 计算处；此处只验证"不抛错且正常导出"
      const result = await service.streamExecutionsCsv({}, out.write, {
        limit: 10_000_000,
      });
      expect(result.rows).toBe(1);
      expect(result.truncated).toBe(false);
      expect(out.text).toContain("id,taskId,taskName");
    });

    it("非法 limit（0 / 负数 / NaN）退回硬顶而不是导出一个空文件", async () => {
      rowset = [makeRow({ id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000300" })];
      await build();
      for (const bad of [0, -5, Number.NaN]) {
        const out = collector();
        const result = await service.streamExecutionsCsv({}, out.write, {
          limit: bad as number,
        });
        expect(result.rows).toBe(1);
      }
    });
  });

  describe("过滤生效", () => {
    beforeEach(() => {
      rowset = [
        makeRow({ id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000401" }),
        makeRow({
          id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000402",
          status: ExecutionStatus.FAILED,
          errorMessage: "boom",
          failureReason: null,
          exitCode: 1,
        }),
        makeRow({
          id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000403",
          taskId: TASK_B,
          taskName: "Other Task",
          executorAddress: "10.0.0.9",
        }),
      ];
    });

    /** 从导出文本里抽出 id 列（第一列），按出现序。 */
    const idsOf = (out: ReturnType<typeof collector>): string[] =>
      out.lines.slice(1).map((line) => line.split(",")[0]);
    // 注意：截断注释行也会被切出首段——用 "以 a-uuid 开头" 过滤掉
    const uuidIdsOf = (out: ReturnType<typeof collector>): string[] =>
      idsOf(out).filter((id) => /^[0-9a-f-]{36}$/.test(id));

    it("status 过滤：只导出该状态的行", async () => {
      await build();
      const out = collector();

      await service.streamExecutionsCsv(
        { status: ExecutionStatus.FAILED },
        out.write,
      );

      expect(uuidIdsOf(out)).toEqual(["aaaaaaaa-aaaa-4aaa-8aaa-000000000402"]);
      expect(out.text).toContain("boom");
      expect(out.text).not.toContain("Other Task");
    });

    it("taskId 过滤：只导出该任务的行", async () => {
      await build();
      const out = collector();

      await service.streamExecutionsCsv({ taskId: TASK_B }, out.write);

      expect(uuidIdsOf(out)).toEqual(["aaaaaaaa-aaaa-4aaa-8aaa-000000000403"]);
    });

    it("status + taskId 组合：两个条件取交集（不是互相覆盖）", async () => {
      await build();
      const out = collector();

      await service.streamExecutionsCsv(
        { status: ExecutionStatus.FAILED, taskId: TASK_A },
        out.write,
      );

      expect(uuidIdsOf(out)).toEqual(["aaaaaaaa-aaaa-4aaa-8aaa-000000000402"]);
    });

    it("时间范围过滤按 createdAt（与列表端点同列，不是 startTime 列）", async () => {
      rowset = [
        makeRow({
          id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000411",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        }),
        makeRow({
          id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000412",
          createdAt: new Date("2026-01-05T00:00:00.000Z"),
        }),
      ];
      await build();
      const out = collector();

      await service.streamExecutionsCsv(
        {
          startTime: "2026-01-03T00:00:00.000Z",
          endTime: "2026-01-09T00:00:00.000Z",
        },
        out.write,
      );

      expect(uuidIdsOf(out)).toEqual(["aaaaaaaa-aaaa-4aaa-8aaa-000000000412"]);
    });

    it("过滤器走的是**同一份**装配（applyAllExecutionsFilters 的谓词逐字出现）", async () => {
      await build();
      const out = collector();

      await service.streamExecutionsCsv(
        {
          status: ExecutionStatus.SUCCESS,
          taskId: TASK_A,
          taskName: "nightly",
          executorAddress: "10.0.0",
          startTime: "2026-01-01T00:00:00.000Z",
          endTime: "2026-12-31T23:59:59.000Z",
        },
        out.write,
      );

      const sqls = state.filters.map((f) => f.sql);
      // 六个谓词的形态与 getAllExecutions 逐字一致（唯一真值源的证据）
      expect(sqls).toContain("e.status = :status");
      expect(sqls).toContain("e.taskId = :taskId");
      expect(sqls).toContain(
        "(e.taskName ILIKE :taskName OR t.name ILIKE :taskName)",
      );
      expect(sqls).toContain("e.executorAddress ILIKE :executorAddress");
      expect(sqls).toContain("e.createdAt >= :startTime");
      expect(sqls).toContain("e.createdAt <= :endTime");
      // 一个都不少（少一个说明某条件根本没下发）
      expect(sqls.filter((s) => !s.includes("task_executions c"))).toHaveLength(
        6,
      );
    });

    it("LIKE 元字符被转义（`_` 不当作单字符通配）", async () => {
      await build();
      const out = collector();

      await service.streamExecutionsCsv(
        { executorAddress: "host_a" },
        out.write,
      );

      const bound = state.filters.find(
        (f) => f.sql === "e.executorAddress ILIKE :executorAddress",
      );
      // escapeLikePattern：`_` → `\_`
      expect(bound?.params.executorAddress).toBe("%host\\_a%");
    });
  });

  describe("空结果", () => {
    it("没有任何匹配行时只输出表头，不报错", async () => {
      rowset = [];
      await build();
      const out = collector();

      const result = await service.streamExecutionsCsv({}, out.write);

      expect(result).toEqual({ rows: 0, truncated: false });
      expect(out.lines).toHaveLength(1);
      expect(out.lines[0]).toBe(
        "id,taskId,taskName,status,triggerType,executorId,executorAddress,createdAt,startTime,endTime,durationMs,retryCount,exitCode,failureReason,errorMessage",
      );
      expect(out.text).not.toContain("# truncated at");
      // 空表也必须真的查过一次（不是短路返回）
      expect(state.getManyCalls).toBe(1);
    });

    it("过滤条件命中 0 行时同样只有表头", async () => {
      rowset = [makeRow({ id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000501" })];
      await build();
      const out = collector();

      const result = await service.streamExecutionsCsv(
        { taskId: "99999999-9999-4999-8999-999999999999" },
        out.write,
      );

      expect(result.rows).toBe(0);
      expect(out.lines).toHaveLength(1);
    });
  });

  describe("流式与键集续页", () => {
    it("超过单页大小（1000 行）时分多页取数且不漏不重", async () => {
      // 1200 行 → 2 页（1000 + 200）。时间戳全不同，等价于真实分布。
      rowset = Array.from({ length: 1200 }, (_, i) =>
        makeRow({
          id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`,
          createdAt: new Date(2026, 0, 1, 0, 0, 0, i),
        }),
      );
      await build();
      const out = collector();

      const result = await service.streamExecutionsCsv({}, out.write);

      expect(result).toEqual({ rows: 1200, truncated: false });
      // 至少两页（不是一次 1200 行全量拉进内存）
      expect(state.getManyCalls).toBeGreaterThanOrEqual(2);
      expect(state.takes[0]).toBe(1000);
      // 每页一次 write（不是每行一次）
      expect(out.write.mock.calls.length).toBeLessThan(10);
      // 不漏不重：导出的 id 集合 === 全量
      const ids = out.lines
        .slice(1)
        .map((l) => l.split(",")[0])
        .filter((id) => /^[0-9a-f-]{36}$/.test(id));
      expect(ids).toHaveLength(1200);
      expect(new Set(ids).size).toBe(1200);
      const expected = [...rowset].sort(compareDesc).map((r) => r.id);
      expect(ids).toEqual(expected);
    });

    it("键集续页用行值比较（不是 OFFSET：深翻页不退化且有决胜键）", async () => {
      // 必须真的跨页（单页 1000 行），否则续页谓词压根不会下发——这正是
      // 上一版用例空转的原因（3 行一次就取完）。1005 行**同一时刻**专打
      // 决胜键：只按 createdAt 排序时这里必然重复/漏行。
      rowset = Array.from({ length: 1005 }, (_, i) =>
        makeRow({
          id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`,
          createdAt: new Date("2026-02-03T04:05:06.000Z"),
        }),
      );
      await build();
      const out = collector();

      const result = await service.streamExecutionsCsv({}, out.write);

      const keyset = state.filters.filter((f) =>
        f.sql.includes("task_executions c"),
      );
      expect(keyset).toHaveLength(1);
      expect(keyset[0].sql).toMatch(
        /\(\s*e\.\"?createdAt\"?\s*,\s*e\.id\s*\)\s*</,
      );
      // 续页下界是**上一页最后一行**的 id（不是时间近似值）。1005 行同刻时
      // 排序退化为 id DESC，故第一页的末行是第 1000 个（id 001004 → 000005）。
      expect(keyset[0].params.cursorId).toBe(
        "aaaaaaaa-aaaa-4aaa-8aaa-000000000005",
      );
      // 同一时刻的 1005 行全部导出且无重复
      expect(result.rows).toBe(1005);
      const ids = out.lines
        .slice(1)
        .map((l) => l.split(",")[0])
        .filter((id) => /^[0-9a-f-]{36}$/.test(id));
      expect(new Set(ids).size).toBe(1005);
      // 绝不使用 OFFSET（skip 从未被调用）
      const qb = (service as any).execRepo.createQueryBuilder.mock.results[0]
        .value;
      expect(qb.skip).not.toHaveBeenCalled();
    });

    it("客户端中途取消（signal aborted）时停止继续拉库", async () => {
      rowset = Array.from({ length: 3000 }, (_, i) =>
        makeRow({
          id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`,
          createdAt: new Date(2026, 0, 1, 0, 0, 0, i),
        }),
      );
      await build();
      const ac = new AbortController();
      let calls = 0;
      const write = jest.fn(async () => {
        calls += 1;
        if (calls === 1) {
          // 第一块之后客户端断开（等价于 res 触发 close → abort）
          ac.abort();
        }
      });

      const result = await service.streamExecutionsCsv({}, write, {
        signal: ac.signal,
      });

      // 表头写出后即中止：只跑了 1 次 getMany（或 0 次，取决于 aborted 检查点）
      expect(state.getManyCalls).toBeLessThanOrEqual(1);
      expect(result.rows).toBe(0);
    });
  });

  describe("时间与空值列的口径", () => {
    it("时间落 ISO 8601 UTC；null 时间落空串（不写 Invalid Date）", async () => {
      rowset = [
        makeRow({
          id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000701",
          startTime: null,
          endTime: null,
          duration: null,
          exitCode: null,
          failureReason: null,
          errorMessage: null,
        }),
      ];
      await build();
      const out = collector();

      await service.streamExecutionsCsv({}, out.write);

      const row = out.lines[1];
      expect(row).toContain("2026-01-02T03:04:05.000Z"); // createdAt
      expect(row).not.toContain("Invalid Date");
      expect(row).not.toContain("null");
      // 表头顺序与数据列顺序一致（durationMs 对应 duration 列）
      const cells = row.split(",");
      expect(cells[10]).toBe(""); // durationMs
      expect(cells[12]).toBe(""); // exitCode
    });

    it("status 落原始枚举值（不是本地化标签——导出是账本不是视图）", async () => {
      rowset = [makeRow({ id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000801" })];
      await build();
      const out = collector();

      await service.streamExecutionsCsv({}, out.write);

      expect(out.text).toContain("success");
      expect(out.text).not.toContain("成功");
    });

    it("logs / aiAnalysis 不出现在导出里（重型列，且各有专项通道）", async () => {
      rowset = [makeRow({ id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000901" })];
      await build();
      const out = collector();

      await service.streamExecutionsCsv({}, out.write);

      expect(out.text).not.toContain("logs");
      expect(out.text).not.toContain("aiAnalysis");
    });
  });

  describe("TaskController 接线（鉴权与背压）", () => {
    const buildController = async () => {
      const streamExecutionsCsv = jest.fn().mockResolvedValue({
        rows: 0,
        truncated: false,
      });
      const controller = new TaskController(
        { streamExecutionsCsv } as any,
        {} as any,
        {} as any,
      );
      return { controller, streamExecutionsCsv };
    };

    /** 最小 Express Response 替身：记录头、累计写出、可触发 drain/close。 */
    const makeRes = () => {
      const listeners: Record<string, Array<() => void>> = {};
      const res: any = {
        headers: {} as Record<string, string>,
        written: [] as string[],
        writableEnded: false,
        setHeader: jest.fn((k: string, v: string) => {
          res.headers[k] = v;
        }),
        write: jest.fn((chunk: string) => {
          res.written.push(chunk);
          return true; // 不背压
        }),
        end: jest.fn(() => {
          res.writableEnded = true;
        }),
        on: jest.fn((event: string, fn: () => void) => {
          (listeners[event] ??= []).push(fn);
        }),
        once: jest.fn((event: string, fn: () => void) => {
          (listeners[event] ??= []).push(fn);
        }),
        off: jest.fn((event: string, fn: () => void) => {
          listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn);
        }),
        emit: (event: string) => {
          for (const fn of [...(listeners[event] ?? [])]) fn();
        },
      };
      return res;
    };

    it("@Roles(ADMIN)：非 ADMIN 被 RolesGuard 拒绝（403）", async () => {
      const { controller } = await buildController();
      const { RolesGuard } = await import("../../../common/guards/roles.guard");
      const { Reflector } = await import("@nestjs/core");

      const roles = Reflect.getMetadata(
        ROLES_KEY,
        TaskController.prototype.exportExecutions,
      );
      expect(roles).toEqual([UserRole.ADMIN]);

      const guard = new RolesGuard(new Reflector());
      const context = (role: UserRole) =>
        ({
          getHandler: () => TaskController.prototype.exportExecutions,
          getClass: () => TaskController,
          switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
        }) as any;

      // 真跑守卫（不只看 metadata）：普通用户被拒
      expect(guard.canActivate(context(UserRole.USER))).toBe(false);
      expect(guard.canActivate(context(UserRole.ADMIN))).toBe(true);
      // 未认证（req.user 缺失）同样拒绝
      const guard2 = new RolesGuard(new Reflector());
      expect(
        guard2.canActivate({
          getHandler: () => TaskController.prototype.exportExecutions,
          getClass: () => TaskController,
          switchToHttp: () => ({ getRequest: () => ({}) }),
        } as any),
      ).toBe(false);
      void controller;
    });

    it("设置 text/csv + attachment 头，并把过滤条件透传给 service", async () => {
      const { controller, streamExecutionsCsv } = await buildController();
      const res = makeRes();

      await controller.exportExecutions(
        {
          status: "failed",
          taskId: TASK_A,
          taskName: "nightly",
          executorAddress: "10.0.0.5",
          startTime: "2026-01-01T00:00:00.000Z",
          endTime: "2026-01-31T23:59:59.000Z",
          limit: 500,
        } as ExportExecutionsQueryDto,
        res,
      );

      expect(res.headers["Content-Type"]).toBe("text/csv; charset=utf-8");
      expect(res.headers["Content-Disposition"]).toContain("attachment");
      expect(res.headers["Content-Disposition"]).toContain(
        "task-executions.csv",
      );
      expect(streamExecutionsCsv).toHaveBeenCalledWith(
        {
          status: "failed",
          taskId: TASK_A,
          taskName: "nightly",
          executorAddress: "10.0.0.5",
          startTime: "2026-01-01T00:00:00.000Z",
          endTime: "2026-01-31T23:59:59.000Z",
        },
        expect.any(Function),
        expect.objectContaining({ limit: 500 }),
      );
      expect(res.end).toHaveBeenCalled();
    });

    it("write 返回 false 时等待 drain（背压），恢复后才继续", async () => {
      const { controller } = await buildController();
      const controller2 = controller as any;
      // 用真实 service 的行为替身：拿到 controller 传下来的 write，连写三块
      const streamExecutionsCsv = jest
        .fn()
        .mockImplementation(async (filters, write) => {
          await write("chunk-1\n");
          await write("chunk-2\n");
          await write("chunk-3\n");
          return { rows: 2, truncated: false };
        });
      controller2.taskService = { streamExecutionsCsv };
      const res = makeRes();
      // 第一次 write 触发背压，随后异步 drain
      let writeCount = 0;
      res.write = jest.fn((chunk: string) => {
        res.written.push(chunk);
        writeCount += 1;
        return writeCount !== 1; // 仅第一块背压
      });
      setTimeout(() => res.emit("drain"), 5);

      await controller.exportExecutions({} as ExportExecutionsQueryDto, res);

      // 三块全部写出（drain 后继续），顺序不变
      expect(res.written).toEqual(["chunk-1\n", "chunk-2\n", "chunk-3\n"]);
      expect(res.end).toHaveBeenCalled();
    });

    it("响应已结束（客户端断开）时不再写入", async () => {
      const { controller } = await buildController();
      const controller2 = controller as any;
      const streamExecutionsCsv = jest
        .fn()
        .mockImplementation(async (filters, write) => {
          res2.writableEnded = true; // 模拟客户端已断开
          await write("late\n");
          return { rows: 1, truncated: false };
        });
      controller2.taskService = { streamExecutionsCsv };
      const res2 = makeRes();
      res2.write = jest.fn(() => true);

      await controller.exportExecutions({} as ExportExecutionsQueryDto, res2);

      // writableEnded 之后 write 直接 resolve，不再触碰 res.write
      expect(res2.write).not.toHaveBeenCalled();
    });
  });
});

describe("ExportExecutionsQueryDto — 白名单与上限校验", () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  });

  const run = (value: unknown) =>
    pipe.transform(value, {
      type: "query",
      metatype: ExportExecutionsQueryDto,
    });

  it("接受六个过滤器 + limit 并完成类型转换（limit 为 number）", async () => {
    const out: any = await run({
      status: "failed",
      taskId: TASK_A,
      taskName: "n",
      executorAddress: "e",
      startTime: "2026-01-01T00:00:00.000Z",
      endTime: "2026-01-31T00:00:00.000Z",
      limit: "500",
    });
    expect(out.limit).toBe(500);
    expect(out.status).toBe("failed");
  });

  it("分页参数在这里**不**合法（page/pageSize 会 400——导出不分页）", async () => {
    await expect(run({ page: "2" })).rejects.toBeTruthy();
    await expect(run({ pageSize: "50" })).rejects.toBeTruthy();
  });

  it("未声明的查询键被拒绝（防「传了没生效」的静默忽略）", async () => {
    await expect(run({ cursor: "abc" })).rejects.toBeTruthy();
    await expect(run({ name: "x" })).rejects.toBeTruthy();
  });

  it("limit < 1 被拒绝；非数字被拒绝", async () => {
    await expect(run({ limit: "0" })).rejects.toBeTruthy();
    await expect(run({ limit: "abc" })).rejects.toBeTruthy();
  });
});

describe("csv-export.util — 纯函数判据", () => {
  it("toCsvRow 逐单元格转义并用逗号连接", () => {
    expect(toCsvRow(["a", "=evil", "b,c"])).toBe(`a,'=evil,"b,c"`);
  });

  it("数字与布尔按字符串渲染（不是 JSON）", () => {
    expect(toCsvRow([1, 0, true])).toBe("1,0,true");
  });

  it("截断注释行形如 `# truncated at N rows`", () => {
    expect(csvTruncationMarker(50_000)).toBe("# truncated at 50000 rows");
  });
});
