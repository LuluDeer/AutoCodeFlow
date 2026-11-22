import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { getQueueToken } from "@nestjs/bullmq";
import { DataSource } from "typeorm";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TaskService } from "../task.service";
import {
  ExecutionRead,
  parseExecutionStatusFilter,
} from "../execution-read.collaborator";
import { Task } from "../entities/task.entity";
import {
  TaskExecution,
  ExecutionStatus,
} from "../entities/task-execution.entity";
import { ExecutionLogLine } from "../entities/execution-log-line.entity";
import { TaskVersion } from "../entities/task-version.entity";
import { ExecutionReport } from "../../metrics/entities/execution-report.entity";
import { SchedulerService } from "../../scheduler/scheduler.service";
import { AiService } from "../../ai/ai.service";
import { AiAnalysisService } from "../../ai/ai-analysis.service";
import { ExecutorService } from "../../executor/executor.service";
import { ConfigService } from "@nestjs/config";
import { AuditService } from "../../audit/audit.service";
import { DomainEventBus } from "../../../common/services/domain-event-bus.service";
import { SecretsCryptoService } from "../../../common/utils/secret-crypto.util.service";

/**
 * T2-B4 第一刀（执行记录读面与导出）的**结构契约**。
 *
 * 这一刀把 9 个 Facade 公共方法搬进了 `ExecutionRead` 协作者。本 spec 钉住
 * 三条**搬错了就会静默失效**的不变量：
 *
 * 1. **spy 拦截面**：Facade 转发层是 spy 拦截面——既有 spec 用
 *    `jest.spyOn(service, "getExecutionReport")` 断言「确实走了这个方法」。
 *    若 Facade 把实现搬走却**不保留同名 public 方法**，或协作者内部
 *    **self-call** 自己的 public 方法，spy 都会**静默失效**（不是报错）。
 * 2. **`execRepo` 调用顺序**：`executions-export.spec.ts:705` 用
 *    `(service as any).execRepo.createQueryBuilder.mock.results[0]` 断言
 *    「绝不使用 OFFSET」——**索引型断言不会因为「多一次调用」而红，它会把别的
 *    调用结果当成本次的结果，断言假过**。⇒ Facade 转发层不许「预检一次」，
 *    协作者内的调用次数与顺序必须与搬迁前一致。
 * 3. **实现确实搬走了**（不是「复制了一份」）：协作者是**唯一**实现处，
 *    Facade 侧不得残留实现体。
 */

const makeRepo = () => ({
  create: jest.fn((d) => d),
  save: jest.fn((e) => Promise.resolve(e)),
  findOne: jest.fn(),
  find: jest.fn().mockResolvedValue([]),
  findAndCount: jest.fn().mockResolvedValue([[], 0]),
  count: jest.fn().mockResolvedValue(0),
  delete: jest.fn().mockResolvedValue({ affected: 1 }),
  createQueryBuilder: jest.fn(),
});

describe("T2-B4 第一刀 · ExecutionRead 协作者的转发契约", () => {
  let service: TaskService;
  let execRepo: ReturnType<typeof makeRepo>;

  beforeEach(async () => {
    execRepo = makeRepo();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TaskService,
        { provide: getRepositoryToken(Task), useValue: makeRepo() },
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
        {
          provide: getRepositoryToken(ExecutionLogLine),
          useValue: makeRepo(),
        },
        { provide: getRepositoryToken(TaskVersion), useValue: makeRepo() },
        { provide: getRepositoryToken(ExecutionReport), useValue: makeRepo() },
        { provide: getQueueToken("task-queue"), useValue: { add: jest.fn() } },
        { provide: DataSource, useValue: { transaction: jest.fn() } },
        {
          provide: SchedulerService,
          useValue: {
            stop: jest.fn(),
            scheduleOne: jest.fn(),
            getStats: jest.fn(),
          },
        },
        { provide: AiService, useValue: { analyzeFailure: jest.fn() } },
        { provide: AiAnalysisService, useValue: { analyzeFailure: jest.fn() } },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue("") },
        },
        {
          provide: ExecutorService,
          useValue: {
            getExecutorUrl: jest.fn(),
            getSharedToken: jest.fn().mockResolvedValue(""),
            notifyExecutorKill: jest.fn(),
            scheduleRetryAfterRecovery: jest.fn(),
            hasRetryBudget: jest.fn().mockReturnValue(true),
          },
        },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: DomainEventBus, useValue: { emit: jest.fn() } },
        {
          provide: SecretsCryptoService,
          useValue: new SecretsCryptoService({ get: () => "" } as never),
        },
      ],
    }).compile();

    service = module.get(TaskService);
  });

  afterEach(() => jest.clearAllMocks());

  it("① spy Facade 的 getExecutionReport ⇒ 协作者实现**不被调用**（spy 拦截面仍在）", async () => {
    // Facade 上的同名 public 方法必须存在（否则 spy 装不上/装到了别处）。
    expect(typeof (service as any).getExecutionReport).toBe("function");

    const payload = { execution: {}, timeline: [], report: null };
    const spy = jest
      .spyOn(service, "getExecutionReport")
      .mockResolvedValue(payload as never);

    // 让协作者实现一旦被调用就会炸（用 execRepo 的 findOne 作为探针）。
    execRepo.findOne.mockRejectedValue(new Error("collaborator was called"));

    const result = await service.getExecutionReport("exec-1", "task-1");

    // spy 拦住了 ⇒ 协作者实现**没有**被调用（execRepo.findOne 未被触发）
    expect(result).toBe(payload);
    expect(execRepo.findOne).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("①b 协作者内部不得 self-call 自己的 public 方法（否则 Facade 的 spy 会静默失效）", () => {
    // 判据形态：协作者源码里，对**自身 public 方法**的直接调用必须为 0。
    // （`scripts/check-collaborator-self-call.mjs` 是全仓守卫；这里是本刀的
    // 就地钉子——防止将来有人把某个 private 改成 public 就悄悄破了不变量。）
    const src = readFileSync(
      join(__dirname, "..", "execution-read.collaborator.ts"),
      "utf-8",
    ) as string;
    const publicMethods = [
      "getExecutions",
      "getAllExecutions",
      "streamExecutionsCsv",
      "getExecutionStats",
      "getExecution",
      "getExecutionReport",
    ];
    for (const name of publicMethods) {
      const selfCalls = src.match(new RegExp(`this\\.${name}\\s*\\(`, "g"));
      // 允许 0 次；若出现则必须不是「public 方法被本类 public 方法调用」
      expect(selfCalls ?? []).toHaveLength(0);
    }
    // 反证：private 互调是**允许**的（`findExecution` 等）
    expect(src).toContain("this.findExecution(");
  });

  it("② Facade 转发层**零预检**（execRepo 的调用次数与顺序与搬迁前一致）", async () => {
    // `streamExecutionsCsv` 既有 spec 用 `mock.results[0]` 做索引型断言 ⇒
    // Facade 转发前若「预检一次」execRepo，`results[0]` 就会指向**预检那次**
    // 而不是导出那次 ⇒ 断言**假过**（不是变红）。
    //
    // 这里钉住：转发一次 ⇒ execRepo.createQueryBuilder **恰好被调 1 次**
    // （转发层自己一次都不调）。
    // 投影 helper 需要 `repo.metadata.columns`（真实仓储的实体元数据）。
    (execRepo as unknown as { metadata: { columns: unknown[] } }).metadata = {
      columns: [{ propertyName: "id" }, { propertyName: "taskId" }],
    };
    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
      getCount: jest.fn().mockResolvedValue(0),
    };
    execRepo.createQueryBuilder.mockReturnValue(qb);

    const chunks: string[] = [];
    await service.streamExecutionsCsv({}, async (chunk: string) => {
      chunks.push(chunk);
    });

    // 一次转发 ⇒ createQueryBuilder 恰好一次（Facade 零预检）
    expect(execRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    // 且 `results[0]` 就是那一次（索引型断言仍指向正确对象）
    const first = execRepo.createQueryBuilder.mock.results[0].value;
    expect(first).toBe(qb);
    expect(first.skip).not.toHaveBeenCalled();

    // ── 同一不变量在「单条读」路径上也要成立 ──
    // `getExecutionReport` 是唯一被 spy 的方法 ⇒ Facade 若在转发前碰 execRepo
    // （哪怕是 count 预检），`mock.results[0]` 这类索引型断言就会指向**预检那次**
    // ⇒ 断言**假过**（不是变红）。这里钉住：转发前 Facade 对 execRepo **零调用**。
    execRepo.createQueryBuilder.mockClear();
    execRepo.findOne.mockClear();
    execRepo.count.mockClear();
    execRepo.find.mockClear();
    execRepo.findAndCount.mockClear();
    await service.getExecutionReport("exec-1", "task-1").catch(() => undefined);
    // Facade 自己一次都没碰 execRepo（实现调用全部发生在协作者内部）
    expect(execRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(execRepo.findAndCount).not.toHaveBeenCalled();
    expect(execRepo.count).not.toHaveBeenCalled();
    expect(execRepo.find).not.toHaveBeenCalled();
    // findOne 是协作者内部**唯一**的一次调用（实现所需）⇒ 恰好 1 次
    expect(execRepo.findOne).toHaveBeenCalledTimes(1);
  });

  it("③ 实现**只在协作者**（Facade 侧不得残留实现体）", () => {
    const facadeSrc = readFileSync(
      join(__dirname, "..", "task.service.ts"),
      "utf-8",
    );
    const collaboratorSrc = readFileSync(
      join(__dirname, "..", "execution-read.collaborator.ts"),
      "utf-8",
    );
    // Facade 侧只应出现**转发调用**，不应出现实现特征（如 findAndCount /
    // createQueryBuilder("e") / executionListSelectMap 的调用）。
    expect(facadeSrc).toContain("this.executionRead.getExecutions(");
    expect(facadeSrc).toContain("this.executionRead.getExecutionReport(");
    expect(facadeSrc).not.toContain("executionListSelectMap(this.execRepo)");
    expect(facadeSrc).not.toContain('createQueryBuilder("e")');
    // 协作者侧才有实现
    expect(collaboratorSrc).toContain(
      "executionListSelectMap(this.deps.execRepo)",
    );
    expect(collaboratorSrc).toContain('createQueryBuilder("e")');
  });

  it("④ Facade 保留同名 public 方法（既有 spec 直接调它们 ⇒ 转发面不能窄化）", () => {
    for (const name of [
      "getExecutions",
      "getAllExecutions",
      "streamExecutionsCsv",
      "getExecutionStats",
      "getExecution",
      "getExecutionReport",
    ]) {
      expect(typeof (service as any)[name]).toBe("function");
    }
  });

  it("⑤ 协作者是**懒构造单例**（转发多次不新建实例）", () => {
    const first = (service as any).executionRead;
    const second = (service as any).executionRead;
    expect(first).toBeInstanceOf(ExecutionRead);
    expect(second).toBe(first);
  });
});

/**
 * R281 · 「失败」深链的多值 status 过滤。
 *
 * 缺陷原形（真机可复现）：超时风暴时（10 条 timeout、0 条 failed）汇总卡片与
 * 通知铃铛显示「10 条失败」，点进去 `/executions?status=failed` 得到 **0 条**。
 * 根因是读面把 `status` 当**单值等值**下发，而「失败」口径早已是
 * `FAILED_EXECUTION_STATUSES = [failed, timeout]`。
 *
 * 本组用例钉两件事：
 *   ① 纯函数 `parseExecutionStatusFilter` 的解析语义（剥空白/去重/保序/白名单/
 *      全非法回落）；
 *   ② **SQL 形状**：单值必须仍是 `e.status = :status`（行为逐字节不变——执行页
 *      下拉里 `failed` 与 `timeout` 是两个独立选项，不能偷偷把 `failed` 扩成
 *      含 timeout），多值才是 `e.status IN (...)`。
 *   ③ 非法值不 400，且全部非法 ⇒ 等同未传（不加任何 status 谓词）。
 */
describe("R281 · status 多值过滤（parseExecutionStatusFilter + SQL 形状）", () => {
  let service: TaskService;
  let execRepo: ReturnType<typeof makeRepo>;
  let qb: Record<string, jest.Mock>;

  /** 只回 `.length` 等纯内存消费的假 QueryBuilder。 */
  const makeQb = () => {
    const builder: Record<string, jest.Mock> = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      getMany: jest.fn().mockResolvedValue([]),
      getCount: jest.fn().mockResolvedValue(0),
      getRawAndEntities: jest.fn().mockResolvedValue({ entities: [] }),
    };
    return builder;
  };

  /** 下发过的 status 谓词（只收集带 status/statuses 参数的那些）。 */
  const statusPredicates = () =>
    qb.andWhere.mock.calls.filter(([, params]) => {
      if (!params) return false;
      return Object.keys(params).some(
        (k) => k === "status" || k === "statuses",
      );
    }) as Array<[string, Record<string, unknown>]>;

  beforeEach(async () => {
    execRepo = makeRepo();
    qb = makeQb();
    execRepo.createQueryBuilder.mockReturnValue(qb);
    (execRepo as unknown as { metadata: { columns: unknown[] } }).metadata = {
      columns: [{ propertyName: "id" }, { propertyName: "status" }],
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TaskService,
        { provide: getRepositoryToken(Task), useValue: makeRepo() },
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
        { provide: getRepositoryToken(ExecutionLogLine), useValue: makeRepo() },
        { provide: getRepositoryToken(TaskVersion), useValue: makeRepo() },
        { provide: getRepositoryToken(ExecutionReport), useValue: makeRepo() },
        { provide: getQueueToken("task-queue"), useValue: { add: jest.fn() } },
        { provide: DataSource, useValue: { transaction: jest.fn() } },
        {
          provide: SchedulerService,
          useValue: {
            stop: jest.fn(),
            scheduleOne: jest.fn(),
            getStats: jest.fn(),
          },
        },
        { provide: AiService, useValue: { analyzeFailure: jest.fn() } },
        { provide: AiAnalysisService, useValue: { analyzeFailure: jest.fn() } },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue("") },
        },
        {
          provide: ExecutorService,
          useValue: {
            getExecutorUrl: jest.fn(),
            getSharedToken: jest.fn().mockResolvedValue(""),
            notifyExecutorKill: jest.fn(),
            scheduleRetryAfterRecovery: jest.fn(),
            hasRetryBudget: jest.fn().mockReturnValue(true),
          },
        },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: DomainEventBus, useValue: { emit: jest.fn() } },
        {
          provide: SecretsCryptoService,
          useValue: new SecretsCryptoService({ get: () => "" } as never),
        },
      ],
    }).compile();

    service = module.get(TaskService);
  });

  afterEach(() => jest.clearAllMocks());

  describe("① 纯函数 parseExecutionStatusFilter（已导出，可直接单测）", () => {
    it("单值 'failed' ⇒ ['failed']（执行页下拉语义的来源）", () => {
      expect(parseExecutionStatusFilter("failed")).toEqual(["failed"]);
    });

    it("多值 'failed,timeout' ⇒ 两值且保序", () => {
      expect(parseExecutionStatusFilter("failed,timeout")).toEqual([
        "failed",
        "timeout",
      ]);
      // 顺序按首次出现，不被枚举定义顺序重排
      expect(parseExecutionStatusFilter("timeout,failed")).toEqual([
        "timeout",
        "failed",
      ]);
    });

    it("非法值 'foo' ⇒ []（= 未传，不是 400）", () => {
      expect(parseExecutionStatusFilter("foo")).toEqual([]);
    });

    it("混合 'failed,foo' ⇒ 只留合法项（逐条丢弃，不连坐）", () => {
      expect(parseExecutionStatusFilter("failed,foo")).toEqual(["failed"]);
      expect(parseExecutionStatusFilter("foo,timeout,bar")).toEqual([
        "timeout",
      ]);
    });

    it("'' 与 undefined ⇒ []", () => {
      expect(parseExecutionStatusFilter("")).toEqual([]);
      expect(parseExecutionStatusFilter(undefined)).toEqual([]);
    });

    it("重复 'failed,failed' ⇒ 去重", () => {
      expect(parseExecutionStatusFilter("failed,failed")).toEqual(["failed"]);
      expect(parseExecutionStatusFilter("failed,timeout,failed")).toEqual([
        "failed",
        "timeout",
      ]);
    });

    it("含空白 'failed, timeout' ⇒ 剥空白", () => {
      expect(parseExecutionStatusFilter("failed, timeout")).toEqual([
        "failed",
        "timeout",
      ]);
      expect(parseExecutionStatusFilter("  timeout  ")).toEqual(["timeout"]);
    });

    it("空片段与注入片段都被丢弃（不产生非法谓词值）", () => {
      expect(parseExecutionStatusFilter("failed,")).toEqual(["failed"]);
      expect(parseExecutionStatusFilter(",,")).toEqual([]);
      expect(parseExecutionStatusFilter("' OR 1=1--")).toEqual([]);
      // 大小写不匹配枚举值 ⇒ 丢弃（枚举值是精确小写）
      expect(parseExecutionStatusFilter("FAILED")).toEqual([]);
    });

    it("返回值只可能落在 ExecutionStatus 枚举内（白名单闭合）", () => {
      const all = Object.values(ExecutionStatus).join(",");
      expect(parseExecutionStatusFilter(all)).toEqual([
        ...new Set(Object.values(ExecutionStatus)),
      ]);
    });
  });

  describe("② SQL 形状：单值仍 '='，多值才是 IN", () => {
    it("单值 status ⇒ andWhere('e.status = :status', { status })（逐字节不变）", async () => {
      await service.getAllExecutions({
        page: 1,
        pageSize: 20,
        status: "failed",
      });
      const preds = statusPredicates();
      expect(preds).toHaveLength(1);
      expect(preds[0]).toEqual(["e.status = :status", { status: "failed" }]);
      // 断言**没有**退化成 IN 单元素
      expect(qb.andWhere.mock.calls.map(([sql]) => sql)).not.toContain(
        "e.status IN (:...statuses)",
      );
    });

    it("多值 status ⇒ andWhere('e.status IN (:...statuses)', { statuses })", async () => {
      await service.getAllExecutions({
        page: 1,
        pageSize: 20,
        status: "failed,timeout",
      });
      const preds = statusPredicates();
      expect(preds).toHaveLength(1);
      expect(preds[0]).toEqual([
        "e.status IN (:...statuses)",
        { statuses: ["failed", "timeout"] },
      ]);
    });

    it("含空格的多值同样生成 IN（剥空白在解析层完成）", async () => {
      await service.getAllExecutions({
        page: 1,
        pageSize: 20,
        status: "failed, timeout",
      });
      expect(statusPredicates()[0]).toEqual([
        "e.status IN (:...statuses)",
        { statuses: ["failed", "timeout"] },
      ]);
    });

    it("全非法 status ⇒ **不下发任何** status 谓词（等同未传，不 400）", async () => {
      await expect(
        service.getAllExecutions({ page: 1, pageSize: 20, status: "foo" }),
      ).resolves.toBeDefined();
      expect(statusPredicates()).toHaveLength(0);
      // 同时确认其它过滤器照常工作（不是整体短路）
      await service.getAllExecutions({
        page: 1,
        pageSize: 20,
        status: "foo",
        taskId: "t-1",
      });
      expect(qb.andWhere).toHaveBeenCalledWith("e.taskId = :taskId", {
        taskId: "t-1",
      });
    });

    it("未传 status ⇒ 同样没有 status 谓词（与全非法等价）", async () => {
      await service.getAllExecutions({ page: 1, pageSize: 20 });
      expect(statusPredicates()).toHaveLength(0);
    });

    it("keyset 分支（导出/翻页共用装配）也走同一形态：单值 '='", async () => {
      await service.getAllExecutions({
        page: 1,
        pageSize: 20,
        status: "failed",
        cursor: "",
      });
      const preds = statusPredicates();
      expect(preds).toHaveLength(1);
      expect(preds[0]).toEqual(["e.status = :status", { status: "failed" }]);
    });

    it("keyset 分支多值同样生成 IN", async () => {
      await service.getAllExecutions({
        page: 1,
        pageSize: 20,
        status: "failed,timeout",
        cursor: "",
      });
      expect(statusPredicates()[0]).toEqual([
        "e.status IN (:...statuses)",
        { statuses: ["failed", "timeout"] },
      ]);
    });
  });
});

/**
 * R281 · **四条 status 过滤路径**都必须接受多值。
 *
 * 缺陷面不止 `getAllExecutions` 一处：`p.status` 在本协作者里有 4 个独立的
 * 消费点（本轮侦察 A① 逐行核实）——
 *
 * | 位置 | 形态 | 影响入口 |
 * |---|---|---|
 * | `applyAllExecutionsFilters`（被 3 条路径共用） | `andWhere('e.status = :status')` | `GET /tasks/executions/all`（OFFSET + keyset）、**CSV 导出** |
 * | `getExecutions` OFFSET 分支 | `where['status']` 对象 | `GET /tasks/:id/executions`（默认路径） |
 * | `getExecutionsByKeyset` 页查询 | `andWhere('e.status = :status')` | `GET /tasks/:id/executions?cursor=…` |
 * | `getExecutionsByKeyset` 的 `count` | `where['status']` 对象 | 同上（`total`） |
 *
 * 只改第一处会让「导出 CSV」与「单任务历史」继续出现「点了看不到」。本组
 * 按**入口**各钉一条，确保 4 处同口径。
 *
 * 单值必须仍是等值形态（不是 `IN` 单元素）——这是既有 spec 的形状钉子，也是
 * 「执行页下拉里 failed / timeout 是独立选项」的语义保证。
 */
describe("R281 · 四条 status 路径的多值覆盖", () => {
  let service: TaskService;
  let execRepo: ReturnType<typeof makeRepo>;
  let qb: Record<string, jest.Mock>;

  const makeQb = () => {
    const builder: Record<string, jest.Mock> = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      getMany: jest.fn().mockResolvedValue([]),
      getCount: jest.fn().mockResolvedValue(0),
    };
    return builder;
  };

  /** QB 上带 status/statuses 参数的谓词。 */
  const statusPredicates = () =>
    qb.andWhere.mock.calls.filter(([, params]) => {
      if (!params) return false;
      return Object.keys(params).some(
        (k) => k === "status" || k === "statuses",
      );
    }) as Array<[string, Record<string, unknown>]>;

  beforeEach(async () => {
    execRepo = makeRepo();
    qb = makeQb();
    execRepo.createQueryBuilder.mockReturnValue(qb);
    execRepo.findAndCount.mockResolvedValue([[], 0]);
    (execRepo as unknown as { metadata: { columns: unknown[] } }).metadata = {
      columns: [{ propertyName: "id" }, { propertyName: "status" }],
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TaskService,
        { provide: getRepositoryToken(Task), useValue: makeRepo() },
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
        { provide: getRepositoryToken(ExecutionLogLine), useValue: makeRepo() },
        { provide: getRepositoryToken(TaskVersion), useValue: makeRepo() },
        { provide: getRepositoryToken(ExecutionReport), useValue: makeRepo() },
        { provide: getQueueToken("task-queue"), useValue: { add: jest.fn() } },
        { provide: DataSource, useValue: { transaction: jest.fn() } },
        {
          provide: SchedulerService,
          useValue: {
            stop: jest.fn(),
            scheduleOne: jest.fn(),
            getStats: jest.fn(),
          },
        },
        { provide: AiService, useValue: { analyzeFailure: jest.fn() } },
        { provide: AiAnalysisService, useValue: { analyzeFailure: jest.fn() } },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue("") },
        },
        {
          provide: ExecutorService,
          useValue: {
            getExecutorUrl: jest.fn(),
            getSharedToken: jest.fn().mockResolvedValue(""),
            notifyExecutorKill: jest.fn(),
            scheduleRetryAfterRecovery: jest.fn(),
            hasRetryBudget: jest.fn().mockReturnValue(true),
          },
        },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: DomainEventBus, useValue: { emit: jest.fn() } },
        {
          provide: SecretsCryptoService,
          useValue: new SecretsCryptoService({ get: () => "" } as never),
        },
      ],
    }).compile();

    service = module.get(TaskService);
  });

  afterEach(() => jest.clearAllMocks());

  /** `where.status` 是 TypeORM `In(...)` 时取出它的值集合，标量则原样返回。 */
  const statusValueOf = (where: Record<string, unknown>) => {
    const raw = where?.status as
      { type?: string; value?: unknown } | string | undefined;
    if (raw && typeof raw === "object" && "type" in raw) {
      return { op: raw.type, values: raw.value };
    }
    return { op: "eq", values: raw };
  };

  it("① getExecutions（单任务 OFFSET）：多值 ⇒ where.status 为 In([...])", async () => {
    await service.getExecutions("task-1", {
      page: 1,
      pageSize: 20,
      status: "failed,timeout",
    });
    const opts = execRepo.findAndCount.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(statusValueOf(opts.where)).toEqual({
      op: "in",
      values: ["failed", "timeout"],
    });
    // taskId 仍在（没有被 status 的展开覆盖掉）
    expect(opts.where.taskId).toBe("task-1");
  });

  it("①b getExecutions（单任务 OFFSET）：单值仍是标量（逐字节不变）", async () => {
    await service.getExecutions("task-1", {
      page: 1,
      pageSize: 20,
      status: "failed",
    });
    const opts = execRepo.findAndCount.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(statusValueOf(opts.where)).toEqual({ op: "eq", values: "failed" });
  });

  it("①c getExecutions OFFSET：全非法 ⇒ where 里连 status 键都没有（= 未传）", async () => {
    await service.getExecutions("task-1", {
      page: 1,
      pageSize: 20,
      status: "foo",
    });
    const opts = execRepo.findAndCount.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect("status" in opts.where).toBe(false);
    expect(opts.where).toEqual({ taskId: "task-1" });
  });

  it("② getExecutionsByKeyset 页查询：多值 ⇒ 生成 IN 谓词", async () => {
    await service.getExecutions("task-1", {
      page: 1,
      pageSize: 20,
      status: "failed,timeout",
      cursor: "",
    });
    expect(statusPredicates()[0]).toEqual([
      "e.status IN (:...statuses)",
      { statuses: ["failed", "timeout"] },
    ]);
  });

  it("②b getExecutionsByKeyset 页查询：单值仍生成 '='", async () => {
    await service.getExecutions("task-1", {
      page: 1,
      pageSize: 20,
      status: "timeout",
      cursor: "",
    });
    expect(statusPredicates()[0]).toEqual([
      "e.status = :status",
      { status: "timeout" },
    ]);
  });

  it("③ getExecutionsByKeyset 的 count：多值 ⇒ where 为 In([...])（total 与 items 同口径）", async () => {
    await service.getExecutions("task-1", {
      page: 1,
      pageSize: 20,
      status: "failed,timeout",
      cursor: "",
    });
    const countOpts = execRepo.count.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    // 页查询与 count **必须同口径**：一处 IN 一处漏改会让 total 与 items 打架
    // （本页 10 行、total 0 行），而这在响应里完全不报错。
    expect(statusValueOf(countOpts.where)).toEqual({
      op: "in",
      values: ["failed", "timeout"],
    });
    expect(countOpts.where.taskId).toBe("task-1");
  });

  it("③b getExecutionsByKeyset 的 count：单值仍是标量", async () => {
    await service.getExecutions("task-1", {
      page: 1,
      pageSize: 20,
      status: "failed",
      cursor: "",
    });
    const countOpts = execRepo.count.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(statusValueOf(countOpts.where)).toEqual({
      op: "eq",
      values: "failed",
    });
  });

  it("④ CSV 导出（streamExecutionsCsv → 共用装配）：多值 ⇒ IN 谓词", async () => {
    const chunks: string[] = [];
    await service.streamExecutionsCsv(
      { status: "failed,timeout" },
      async (chunk: string) => {
        chunks.push(chunk);
      },
    );
    // 导出与 getAllExecutions 共用 applyAllExecutionsFilters ⇒ 形态必须一致；
    // 这里**单独**钉一条，因为导出是独立入口（运维点「导出」时同样会
    // 「点了看不到」）。
    expect(statusPredicates()[0]).toEqual([
      "e.status IN (:...statuses)",
      { statuses: ["failed", "timeout"] },
    ]);
    // 表头照常写出（没有因为过滤条件变化而中断）
    expect(chunks.join("")).toContain(",");
  });

  it("④b CSV 导出：单值仍生成 '='（既有形态钉子）", async () => {
    await service.streamExecutionsCsv(
      { status: "failed" },
      async () => undefined,
    );
    expect(statusPredicates()[0]).toEqual([
      "e.status = :status",
      { status: "failed" },
    ]);
  });

  it("⑤ getAllExecutions（跨任务 OFFSET，深链入口）多值 ⇒ IN", async () => {
    await service.getAllExecutions({
      page: 1,
      pageSize: 20,
      status: "failed,timeout",
    });
    expect(statusPredicates()[0]).toEqual([
      "e.status IN (:...statuses)",
      { statuses: ["failed", "timeout"] },
    ]);
  });
});
