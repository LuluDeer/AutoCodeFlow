import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { MetricsService } from "../metrics.service";
import { SchedulerService } from "../../scheduler/scheduler.service";
import { Task } from "../../task/entities/task.entity";
import {
  TaskExecution,
  ExecutionStatus,
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
      ],
    }).compile();

    service = module.get<MetricsService>(MetricsService);
    taskRepo = module.get(getRepositoryToken(Task));
    execRepo = module.get(getRepositoryToken(TaskExecution));
    executorRepo = module.get(getRepositoryToken(Executor));
    reportRepo = module.get(getRepositoryToken(ExecutionReport));
    schedulerService = module.get(SchedulerService);
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

    it("should return empty array when no executors", async () => {
      executorRepo.find.mockResolvedValue([]);
      const result = await service.getExecutorStats();
      expect(result).toEqual([]);
    });
  });

  describe("getRecentFailures", () => {
    it("should return top 10 failed executions", async () => {
      const failures = Array.from({ length: 10 }, (_, i) => ({
        id: `e${i}`,
      })) as TaskExecution[];
      execRepo.find.mockResolvedValue(failures);
      const result = await service.getRecentFailures();
      expect(result).toHaveLength(10);
      expect(execRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: ExecutionStatus.FAILED },
          take: 10,
        }),
      );
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
  });
});
