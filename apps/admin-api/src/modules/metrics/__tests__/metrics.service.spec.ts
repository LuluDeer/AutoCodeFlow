import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { getRepositoryToken } from "@nestjs/typeorm";
import { MetricsService } from "../metrics.service";
import { EventLoopLagService } from "../../../common/metrics/event-loop-lag.service";
import { SchedulerService } from "../../scheduler/scheduler.service";
import { Task } from "../../task/entities/task.entity";
import {
  TaskExecution,
  ExecutionStatus,
  FAILED_EXECUTION_STATUSES,
} from "../../task/entities/task-execution.entity";
import {
  Executor,
  ExecutorStatus,
} from "../../executor/entities/executor.entity";
import { ExecutionReport } from "../entities/execution-report.entity";

const makeQb = (overrides: Record<string, jest.Mock> = {}) => ({
  select: jest.fn().mockReturnThis(),
  addSelect: jest.fn().mockReturnThis(),
  groupBy: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  andWhere: jest.fn().mockReturnThis(),
  getRawMany: jest.fn().mockResolvedValue([]),
  getRawOne: jest.fn().mockResolvedValue({ avg: "0" }),
  ...overrides,
});

const mockRepo = () => ({
  count: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
  save: jest.fn(),
  create: jest.fn(),
  createQueryBuilder: jest.fn(),
});

describe("MetricsService", () => {
  let service: MetricsService;
  let taskRepo: ReturnType<typeof mockRepo>;
  let execRepo: ReturnType<typeof mockRepo>;
  let executorRepo: ReturnType<typeof mockRepo>;
  let reportRepo: ReturnType<typeof mockRepo>;
  let schedulerService: {
    getSchedulerMetrics: jest.Mock;
    getStats: jest.Mock;
  };
  // ARCH-27: ConfigService 桩（app.hostname）
  let metricsConfig: { get: jest.Mock };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MetricsService,
        { provide: getRepositoryToken(Task), useFactory: mockRepo },
        { provide: getRepositoryToken(TaskExecution), useFactory: mockRepo },
        { provide: getRepositoryToken(Executor), useFactory: mockRepo },
        { provide: getRepositoryToken(ExecutionReport), useFactory: mockRepo },
        {
          provide: SchedulerService,
          useValue: {
            getSchedulerMetrics: jest.fn(),
            getStats: jest.fn(),
          },
        },
        // ARCH-27: instance.hostname 经 ConfigService 读 app.hostname ——
        // spec 注入桩值。
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue("test-hostname") },
        },
        // INCIDENT-2026-10-28（P1-2）：getSchedulerMetrics 现在也带
        // eventLoop 快照。这里只桩 getSnapshot——事件循环的真实采样在
        // 本 spec 的职责之外（由 event-loop-lag.service.spec.ts 覆盖）。
        {
          provide: EventLoopLagService,
          useValue: {
            getSnapshot: jest.fn().mockReturnValue({
              lastSampleMaxMs: 0,
              lastSampleP99Ms: 0,
              worstMaxMs: 0,
              warnCount: 0,
              lastSampleAt: null,
              thresholdMs: 1000,
            }),
          },
        },
      ],
    }).compile();

    service = module.get<MetricsService>(MetricsService);
    taskRepo = module.get(getRepositoryToken(Task));
    execRepo = module.get(getRepositoryToken(TaskExecution));
    executorRepo = module.get(getRepositoryToken(Executor));
    reportRepo = module.get(getRepositoryToken(ExecutionReport));
    schedulerService = module.get(SchedulerService);
    metricsConfig = module.get(ConfigService);
  });

  describe("getSummary", () => {
    it("should return summary with correct successRate calculation", async () => {
      taskRepo.count.mockResolvedValue(5);
      executorRepo.count
        .mockResolvedValueOnce(3) // totalExecutors
        .mockResolvedValueOnce(2); // onlineExecutors

      const qb = makeQb({
        getRawMany: jest.fn().mockResolvedValue([
          { status: ExecutionStatus.SUCCESS, count: "8" },
          { status: ExecutionStatus.FAILED, count: "2" },
        ]),
        getRawOne: jest.fn().mockResolvedValue({ avg: "1500" }),
      });
      execRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.getSummary();
      expect(result.totalTasks).toBe(5);
      expect(result.totalExecutors).toBe(3);
      expect(result.onlineExecutors).toBe(2);
      expect(result.executions.success).toBe(8);
      expect(result.executions.failed).toBe(2);
      expect(result.executions.total).toBe(10);
      expect(result.successRate).toBe(80);
      expect(result.avgDurationMs).toBe(1500);
    });

    // ③R280：成功率卡的失败数 = FAILED 桶 + TIMEOUT 桶。
    // 同一个 timeout 语义分叉落两个桶（回调 → TIMEOUT；stale sweep →
    // FAILED + failureReason=TIMEOUT），只数一个桶必然少算。
    it("R280: executions.failed = FAILED 桶 + TIMEOUT 桶（timeout 分叉落两桶）", async () => {
      taskRepo.count.mockResolvedValue(0);
      executorRepo.count.mockResolvedValue(0);
      const qb = makeQb({
        getRawMany: jest.fn().mockResolvedValue([
          { status: ExecutionStatus.SUCCESS, count: "10" },
          { status: ExecutionStatus.FAILED, count: "2" }, // 含 sweep 的超时
          { status: ExecutionStatus.TIMEOUT, count: "3" }, // 回调上报的超时
          { status: ExecutionStatus.KILLED, count: "4" },
          { status: ExecutionStatus.CANCELLED, count: "1" },
        ]),
        getRawOne: jest.fn().mockResolvedValue({ avg: "0" }),
      });
      execRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.getSummary();

      expect(result.executions.failed).toBe(5); // 2 + 3
      expect(result.executions.failed).toBeGreaterThan(3); // 只数 TIMEOUT 也不够
      expect(result.executions.failed).toBeGreaterThan(2); // 只数 FAILED 也不够
      expect(result.executions.total).toBe(20); // total 不受口径影响
    });

    it("R280: 无 TIMEOUT 行时 failed 退化为 FAILED 桶（不改既有语义）", async () => {
      taskRepo.count.mockResolvedValue(0);
      executorRepo.count.mockResolvedValue(0);
      const qb = makeQb({
        getRawMany: jest.fn().mockResolvedValue([
          { status: ExecutionStatus.SUCCESS, count: "8" },
          { status: ExecutionStatus.FAILED, count: "2" },
        ]),
        getRawOne: jest.fn().mockResolvedValue({ avg: "0" }),
      });
      execRepo.createQueryBuilder.mockReturnValue(qb);
      const result = await service.getSummary();
      expect(result.executions.failed).toBe(2);
      expect(result.successRate).toBe(80);
    });

    it("should return successRate 0 when no executions", async () => {
      taskRepo.count.mockResolvedValue(0);
      executorRepo.count.mockResolvedValue(0);
      const qb = makeQb({
        getRawMany: jest.fn().mockResolvedValue([]),
        getRawOne: jest.fn().mockResolvedValue({ avg: null }),
      });
      execRepo.createQueryBuilder.mockReturnValue(qb);
      const result = await service.getSummary();
      expect(result.successRate).toBe(0);
      expect(result.avgDurationMs).toBe(0);
    });

    // NETOPT-1④: 两处执行聚合都带「近 30 天」时间界——task_executions 峰值
    // 行数下全表 GROUP BY / AVG 随历史线性变慢（dashboard 首屏高频路径）。
    it("NETOPT-1④: bounds both aggregations to the 30-day window via parameter binding", async () => {
      const qb = makeQb({
        getRawMany: jest.fn().mockResolvedValue([]),
        getRawOne: jest.fn().mockResolvedValue({ avg: null }),
      });
      execRepo.createQueryBuilder.mockReturnValue(qb);
      await service.getSummary();

      // 状态计数聚合：where 带 createdAt >= :windowStart，参数为 Date
      const whereCalls = qb.where.mock.calls.map((c: any[]) => c[0]);
      expect(whereCalls).toContain("e.createdAt >= :windowStart");
      // AVG 聚合：andWhere 同样带时间界
      const andWhereCalls = qb.andWhere.mock.calls.map((c: any[]) => c[0]);
      expect(andWhereCalls).toContain("e.createdAt >= :windowStart");
      // 窗口 ≈ 30 天前（允许秒级时钟误差），且以参数绑定（Date）而非内联字面量
      const windowArg = qb.where.mock.calls.find(
        (c: any[]) => c[0] === "e.createdAt >= :windowStart",
      )?.[1] as { windowStart: Date };
      expect(windowArg.windowStart).toBeInstanceOf(Date);
      const ageMs = Date.now() - windowArg.windowStart.getTime();
      expect(ageMs).toBeGreaterThanOrEqual(30 * 86_400_000 - 60_000);
      expect(ageMs).toBeLessThan(31 * 86_400_000);
    });
  });

  describe("getDailyTrend", () => {
    it("should aggregate rows into date buckets", async () => {
      const day = new Date("2024-01-15T00:00:00.000Z");
      const qb = makeQb({
        getRawMany: jest.fn().mockResolvedValue([
          { day, status: ExecutionStatus.SUCCESS, count: "3" },
          { day, status: ExecutionStatus.FAILED, count: "1" },
        ]),
      });
      execRepo.createQueryBuilder.mockReturnValue(qb);
      const result = await service.getDailyTrend(7);
      expect(result).toHaveLength(1);
      expect(result[0].success).toBe(3);
      expect(result[0].failed).toBe(1);
    });

    // A-10（审计趋势口径）：TIMEOUT 必须透出——告警口径为 failed|timeout
    // （alerts.yml AUTOFLOW_EXECUTION_FAILURE_RATE_HIGH/_STORM 的
    // status=~"failed|timeout"），趋势响应缺 timeout 键会让前端失败曲线
    // 系统性低于告警口径。CANCELLED/KILLED 不在告警口径内，维持不透出。
    it("exposes TIMEOUT counts per bucket (alert semantic failed|timeout, A-10)", async () => {
      const day = new Date("2024-01-15T00:00:00.000Z");
      const qb = makeQb({
        getRawMany: jest.fn().mockResolvedValue([
          { day, status: ExecutionStatus.SUCCESS, count: "3" },
          { day, status: ExecutionStatus.FAILED, count: "1" },
          { day, status: ExecutionStatus.TIMEOUT, count: "2" },
          { day, status: ExecutionStatus.CANCELLED, count: "5" },
          { day, status: ExecutionStatus.KILLED, count: "7" },
        ]),
      });
      execRepo.createQueryBuilder.mockReturnValue(qb);
      const result = await service.getDailyTrend(7);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        date: "2024-01-15",
        success: 3,
        failed: 1,
        timeout: 2,
      });
    });

    it("should return empty array when no data", async () => {
      const qb = makeQb({ getRawMany: jest.fn().mockResolvedValue([]) });
      execRepo.createQueryBuilder.mockReturnValue(qb);
      const result = await service.getDailyTrend();
      expect(result).toEqual([]);
    });
  });

  describe("getExecutorStats", () => {
    it("should map executor fields correctly", async () => {
      const executors = [
        {
          id: "e1",
          appName: "worker",
          address: "127.0.0.1:9000",
          status: ExecutorStatus.ONLINE,
          cpuUsage: 20,
          memUsage: 512,
          runningTaskCount: 2,
          lastHeartbeat: new Date(),
        },
      ] as Executor[];
      executorRepo.find.mockResolvedValue(executors);
      const result = await service.getExecutorStats();
      expect(result).toHaveLength(1);
      expect(result[0].appName).toBe("worker");
      expect(result[0].cpuUsage).toBe(20);
    });

    it("rt-4: 只投影消费的 8 列（不物化 tokenHash 等凭据列）", async () => {
      executorRepo.find.mockResolvedValue([]);
      await service.getExecutorStats();
      expect(executorRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            id: true,
            appName: true,
            address: true,
            status: true,
            cpuUsage: true,
            memUsage: true,
            runningTaskCount: true,
            lastHeartbeat: true,
          }),
        }),
      );
      const select = (executorRepo.find.mock.calls[0][0] as { select: object })
        .select;
      expect(Object.keys(select).sort()).toEqual(
        [
          "address",
          "appName",
          "cpuUsage",
          "id",
          "lastHeartbeat",
          "memUsage",
          "runningTaskCount",
          "status",
        ].sort(),
      );
    });

    it("should return empty array when no executors", async () => {
      executorRepo.find.mockResolvedValue([]);
      const result = await service.getExecutorStats();
      expect(result).toEqual([]);
    });
  });

  describe("getRecentFailures", () => {
    // R280（失败口径统一）：两条分支都必须查 FAILED ∪ TIMEOUT。
    //
    // 下面的替身**真的**按 status 过滤（从 where 里取出状态集合再筛行），
    // 所以把代码改回 `status = FAILED` 时 TIMEOUT 行会直接从结果里消失 ⇒
    // 用例变红。这是反证点，不是形状断言。
    const oneRowPerStatus = (): TaskExecution[] =>
      [
        { id: "timeout-1", status: ExecutionStatus.TIMEOUT },
        { id: "failed-1", status: ExecutionStatus.FAILED },
        { id: "killed-1", status: ExecutionStatus.KILLED },
        { id: "cancelled-1", status: ExecutionStatus.CANCELLED },
      ] as unknown as TaskExecution[];

    // repo.find 替身：In(...) → 集合成员判定；裸值 → 等值判定。
    const findHonouringWhere = (all: TaskExecution[]) =>
      jest.fn(async (opts: any) => {
        const status = opts?.where?.status;
        const allowed: string[] = Array.isArray(status?.value)
          ? status.value
          : [status?.value ?? status];
        const take = opts?.take ?? all.length;
        return all
          .filter((r) => allowed.includes(r.status as string))
          .slice(0, take);
      });

    // QueryBuilder 替身：只实现 getRecentFailures 用到的链式方法，where 的
    // (sql, params) 被记录并在 getMany 时真正用于筛选。
    const qbHonouringWhere = (all: TaskExecution[]) => {
      const whereCalls: Array<[string, Record<string, unknown> | undefined]> =
        [];
      const qb: any = {
        select: jest.fn(() => qb),
        leftJoin: jest.fn(() => qb),
        where: jest.fn((sql: string, params?: Record<string, unknown>) => {
          whereCalls.push([sql, params]);
          return qb;
        }),
        andWhere: jest.fn(() => qb),
        orderBy: jest.fn(() => qb),
        take: jest.fn(() => qb),
        getMany: jest.fn(async () => {
          const [, params] = whereCalls[0] ?? [];
          const allowed: string[] = Array.isArray(params?.failedStatuses)
            ? (params!.failedStatuses as string[])
            : params?.status
              ? [params.status as string]
              : [];
          return all.filter((r) => allowed.includes(r.status as string));
        }),
      };
      return qb;
    };

    it("常量是唯一事实源：恰好 [failed, timeout]——KILLED/CANCELLED 永不混入", () => {
      expect([...FAILED_EXECUTION_STATUSES]).toEqual([
        ExecutionStatus.FAILED,
        ExecutionStatus.TIMEOUT,
      ]);
    });

    it("should return top 10 failed executions (保持 take/排序/投影不变)", async () => {
      const failures = Array.from({ length: 10 }, (_, i) => ({
        id: `e${i}`,
        status: ExecutionStatus.FAILED,
      })) as unknown as TaskExecution[];
      execRepo.find.mockResolvedValue(failures);
      const result = await service.getRecentFailures();
      expect(result).toHaveLength(10);
      const findOpts = execRepo.find.mock.calls[0][0] as any;
      expect((findOpts.where.status as any).value).toEqual([
        ExecutionStatus.FAILED,
        ExecutionStatus.TIMEOUT,
      ]);
      expect(findOpts.take).toBe(10);
      expect(findOpts.order).toEqual({ createdAt: "DESC" });
      expect(Object.keys(findOpts.select).sort()).toEqual(
        [
          "createdAt",
          "duration",
          "errorMessage",
          "exitCode",
          "failureReason",
          "id",
          "taskId",
          "taskName",
        ].sort(),
      );
    });

    // ①反证点：回调上报的超时落 status=TIMEOUT（不是 FAILED），
    // `status = FAILED` 的旧口径会让它在「最近失败」里彻底消失。
    it("R280: 无 projectId 分支返回 status=TIMEOUT 的行（反证点）", async () => {
      execRepo.find.mockImplementation(
        findHonouringWhere(oneRowPerStatus()) as never,
      );
      const result = await service.getRecentFailures();
      expect(result.map((r) => r.id)).toEqual(
        expect.arrayContaining(["timeout-1", "failed-1"]),
      );
    });

    it("R280: 有 projectId 分支同样返回 status=TIMEOUT 的行（反证点）", async () => {
      const qb = qbHonouringWhere(oneRowPerStatus());
      execRepo.createQueryBuilder.mockReturnValue(qb);
      const result = await service.getRecentFailures("p1");
      expect(result.map((r) => r.id)).toEqual(
        expect.arrayContaining(["timeout-1", "failed-1"]),
      );
      // 口径来源必须是唯一事实源，且投影/排序/上限原样保留。
      expect(qb.where).toHaveBeenCalledWith(
        "e.status IN (:...failedStatuses)",
        { failedStatuses: [...FAILED_EXECUTION_STATUSES] },
      );
      expect(qb.take).toHaveBeenCalledWith(10);
      expect(qb.orderBy).toHaveBeenCalledWith("e.createdAt", "DESC");
    });

    // ②KILLED / CANCELLED 是人主动停的，不算失败。
    it("R280: KILLED/CANCELLED 不出现（两个分支都排除）", async () => {
      execRepo.find.mockImplementation(
        findHonouringWhere(oneRowPerStatus()) as never,
      );
      const noProject = await service.getRecentFailures();
      expect(noProject.map((r) => r.id)).not.toContain("killed-1");
      expect(noProject.map((r) => r.id)).not.toContain("cancelled-1");

      execRepo.createQueryBuilder.mockReturnValue(
        qbHonouringWhere(oneRowPerStatus()),
      );
      const withProject = await service.getRecentFailures("p1");
      expect(withProject.map((r) => r.id)).not.toContain("killed-1");
      expect(withProject.map((r) => r.id)).not.toContain("cancelled-1");
    });
  });

  describe("generateReport", () => {
    it("should create and save a report for the given date", async () => {
      const qb = makeQb({
        getRawMany: jest.fn().mockResolvedValue([
          { status: ExecutionStatus.SUCCESS, count: "5" },
          { status: ExecutionStatus.FAILED, count: "1" },
        ]),
        getRawOne: jest
          .fn()
          .mockResolvedValue({ avg: "1000", max: "2000", min: "500" }),
      });
      execRepo.createQueryBuilder.mockReturnValue(qb);
      const report = {
        id: "r1",
        successCount: 5,
      } as unknown as ExecutionReport;
      reportRepo.create.mockReturnValue(report);
      reportRepo.save.mockResolvedValue(report);

      const result = await service.generateReport(new Date("2024-01-15"));
      expect(reportRepo.save).toHaveBeenCalledWith(report);
      expect(result).toEqual(report);
    });

    // S8（迁移 1790000000091）：合成行 = G2 为「因上游失败而没跑」的下游补的
    // 可见性记录，**从未执行**。它若进了日报，cancelledCount 会把「没跑」记成
    // 「跑过一次又取消了」，读上去像调度器在频繁覆盖，而真实原因在上游失败。
    it("S8: cancelledCount 只数真实尝试——合成行（synthetic=true）不计入", async () => {
      // 当日三行：1 条合成 cancelled（从未运行）、1 条真实 cancelled、1 条成功
      const rows = [
        { status: ExecutionStatus.CANCELLED, synthetic: true },
        { status: ExecutionStatus.CANCELLED, synthetic: false },
        { status: ExecutionStatus.SUCCESS, synthetic: false },
      ];
      const conds: string[] = [];
      const statsQb: Record<string, jest.Mock> = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn((sql: string) => (conds.push(sql), statsQb)) as never,
        andWhere: jest.fn((sql: string) => (conds.push(sql), statsQb)) as never,
        groupBy: jest.fn().mockReturnThis(),
        // 替身按生产代码拼进来的谓词**真的**过滤：删掉 `e.synthetic = false`
        // 这条 andWhere，合成行就会重新出现在计数里 ⇒ 用例变红。
        getRawMany: jest.fn(async () => {
          const honour = conds.includes("e.synthetic = false");
          const map = new Map<string, number>();
          for (const r of rows) {
            if (honour && r.synthetic) continue;
            map.set(r.status, (map.get(r.status) ?? 0) + 1);
          }
          return [...map].map(([status, count]) => ({
            status,
            count: String(count),
          }));
        }),
      };
      const durationQb = makeQb({
        getRawOne: jest
          .fn()
          .mockResolvedValue({ avg: "0", max: "0", min: "0" }),
      });
      execRepo.createQueryBuilder
        .mockReturnValueOnce(statsQb)
        .mockReturnValueOnce(durationQb);
      reportRepo.create.mockImplementation((v: unknown) => v);
      reportRepo.save.mockImplementation(async (v: unknown) => v);

      const report = await service.generateReport(new Date("2024-01-15"));

      expect(report.cancelledCount).toBe(1); // 不是 2（合成行被排除）
      expect(report.successCount).toBe(1);
      expect(conds).toContain("e.synthetic = false");
    });
  });

  describe("getReports", () => {
    it("should query reports within date range", async () => {
      const reports = [{ id: "r1" }] as unknown as ExecutionReport[];
      reportRepo.find.mockResolvedValue(reports);
      const start = new Date("2024-01-01");
      const end = new Date("2024-01-31");
      const result = await service.getReports(start, end);
      expect(result).toEqual(reports);
      expect(reportRepo.find).toHaveBeenCalled();
    });
  });

  describe("getTodayReport", () => {
    it("should return existing report when found", async () => {
      const report = { id: "r1" } as unknown as ExecutionReport;
      reportRepo.findOne.mockResolvedValue(report);
      const result = await service.getTodayReport();
      expect(result).toEqual(report);
    });

    it("should generate report when not found", async () => {
      reportRepo.findOne.mockResolvedValue(null);
      const qb = makeQb({
        getRawMany: jest.fn().mockResolvedValue([]),
        getRawOne: jest
          .fn()
          .mockResolvedValue({ avg: "0", max: "0", min: "0" }),
      });
      execRepo.createQueryBuilder.mockReturnValue(qb);
      const generated = { id: "r2" } as unknown as ExecutionReport;
      reportRepo.create.mockReturnValue(generated);
      reportRepo.save.mockResolvedValue(generated);
      const result = await service.getTodayReport();
      expect(result).toEqual(generated);
    });

    // NETOPT-1⑤: 并发首访竞态——findOne 落空后两请求各自 generateReport，
    // 败者撞 triggerDay 唯一索引（23505）应重读返回赢家写入的行，而非 500。
    it("NETOPT-1⑤: on unique-violation (23505) re-reads the winner's report instead of 500", async () => {
      reportRepo.findOne
        .mockResolvedValueOnce(null) // 首次读：不存在
        .mockResolvedValueOnce({ id: "r-winner" }); // 冲突后重读：赢家已写入
      const qb = makeQb({
        getRawMany: jest.fn().mockResolvedValue([]),
        getRawOne: jest
          .fn()
          .mockResolvedValue({ avg: "0", max: "0", min: "0" }),
      });
      execRepo.createQueryBuilder.mockReturnValue(qb);
      reportRepo.create.mockReturnValue({ id: "r-loser" });
      // save 抛出带 PG code 的唯一冲突（模拟 TypeORM QueryFailedError 包装形态）
      const dupErr = Object.assign(new Error("duplicate key"), {
        code: "23505",
      });
      reportRepo.save.mockRejectedValueOnce(dupErr);

      const result = await service.getTodayReport();
      expect(result).toEqual({ id: "r-winner" });
      expect(reportRepo.findOne).toHaveBeenCalledTimes(2);
    });

    it("NETOPT-1⑤: non-unique-violation errors still propagate", async () => {
      reportRepo.findOne.mockResolvedValue(null);
      const qb = makeQb({
        getRawMany: jest.fn().mockResolvedValue([]),
        getRawOne: jest
          .fn()
          .mockResolvedValue({ avg: "0", max: "0", min: "0" }),
      });
      execRepo.createQueryBuilder.mockReturnValue(qb);
      reportRepo.create.mockReturnValue({ id: "r-x" });
      reportRepo.save.mockRejectedValueOnce(new Error("connection refused"));

      await expect(service.getTodayReport()).rejects.toThrow(
        "connection refused",
      );
    });
  });

  describe("getRecentReports", () => {
    it("should delegate to getReports with correct date range", async () => {
      const reports = [{ id: "r1" }] as unknown as ExecutionReport[];
      reportRepo.find.mockResolvedValue(reports);
      const result = await service.getRecentReports(7);
      expect(result).toEqual(reports);
    });
  });

  describe("getSchedulerMetrics (R4-§5.5 observability)", () => {
    it("aggregates scheduler counters, derived rates, queue depth and runtime stats", async () => {
      schedulerService.getSchedulerMetrics.mockResolvedValue({
        counters: {
          ticks: 5,
          tickDurationMsTotal: 120,
          lastTickDurationMs: 20,
          lastTickAt: "2026-09-02T00:00:00.000Z",
          triggersClaimed: 3,
          triggersSkippedLockHeld: 1,
          triggersSkippedDbClaim: 0,
          triggersSkippedInactive: 0,
          triggersSkippedBlockStrategy: 2,
          triggersFailed: 1,
          dependencyTriggersClaimed: 2,
          dependencyTriggersSkipped: 1,
          startedAt: "2026-09-01T00:00:00.000Z",
        },
        derived: {
          avgTickDurationMs: 24,
          tickRatePerSec: 0.016,
          triggerClaimRatePerSec: 0.01,
        },
        queue: { waiting: 2, active: 1, delayed: 4, failed: 0, completed: 10 },
      });
      schedulerService.getStats.mockReturnValue({
        healthy: true,
        isLeader: true,
        activeTimers: 2,
        activeCronTasks: 1,
      });

      const result = await service.getSchedulerMetrics();

      expect(result.counters.triggersClaimed).toBe(3);
      expect(result.counters.ticks).toBe(5);
      expect(result.counters.dependencyTriggersClaimed).toBe(2);
      expect(result.derived.avgTickDurationMs).toBe(24);
      expect(result.queue).toEqual({
        waiting: 2,
        active: 1,
        delayed: 4,
        failed: 0,
        completed: 10,
      });
      expect(result.scheduler.isLeader).toBe(true);
      expect(result.scheduler.activeTimers).toBe(2);
      expect(result.instance.pid).toBe(process.pid);
      // ARCH-27: hostname 来自 ConfigService（app.hostname），不再直读 env。
      expect(result.instance.hostname).toBe("test-hostname");
      expect(schedulerService.getSchedulerMetrics).toHaveBeenCalledTimes(1);
    });

    it("exposes the raw service without mutating the scheduler payload", async () => {
      schedulerService.getSchedulerMetrics.mockResolvedValue({
        counters: { ticks: 1 },
        derived: {},
        queue: { waiting: null, active: null, delayed: null },
      });
      schedulerService.getStats.mockReturnValue({ isLeader: false });

      const result = await service.getSchedulerMetrics();

      expect(result.counters).toEqual({ ticks: 1 });
      expect(result.scheduler).toEqual({ isLeader: false });
    });

    // ARCH-27: OS/容器注入的 hostname 未配置（get 返回 undefined）时回退空串。
    it("falls back to an empty instance.hostname when app.hostname is unset", async () => {
      schedulerService.getSchedulerMetrics.mockResolvedValue({
        counters: {},
        derived: {},
        queue: {},
      });
      schedulerService.getStats.mockReturnValue({});
      metricsConfig.get.mockReturnValue(undefined);

      const result = await service.getSchedulerMetrics();

      expect(result.instance.hostname).toBe("");
    });
  });
});
