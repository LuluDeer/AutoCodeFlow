/**
 * OBS-04: 执行报告/时间线端点读侧专项测试。
 *
 * 覆盖三件事：
 * 1. execution-timeline.util 纯映射——与 DB 时间戳一致性契约（created/
 *    started/finished 三段、缺省段 at=null、非法日期不抛错落 null）；
 * 2. TaskService.getExecutionReport——时间线并入响应、report 行命中与
 *    缺失（null）两条路径、task 域校验复用 getExecution；
 * 3. TaskController.executionReport——路由到 service 并透传 task 域参数。
 */
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { getQueueToken } from "@nestjs/bullmq";
import { ConfigService } from "@nestjs/config";
import { TaskService } from "../task.service";
import { TaskController } from "../task.controller";
import { Task } from "../entities/task.entity";
import { TaskExecution } from "../entities/task-execution.entity";
import { ExecutionLogLine } from "../entities/execution-log-line.entity";
import { TaskVersion } from "../entities/task-version.entity";
import { ExecutionReport } from "../../metrics/entities/execution-report.entity";
import { SchedulerService } from "../../scheduler/scheduler.service";
import { AiService } from "../../ai/ai.service";
import { ExecutorService } from "../../executor/executor.service";
import { NotificationService } from "../../notification/notification.service";
import { AuditService } from "../../audit/audit.service";
import { SecretsCryptoService } from "../../../common/utils/secret-crypto.util.service";
import {
  buildExecutionTimeline,
  ExecutionTimelineSource,
} from "../execution-timeline.util";

jest.mock("axios");

/** 最小可运行仓储替身（getExecutionReport 只用 findOne） */
const makeRepo = () => ({
  create: jest.fn((d) => d),
  save: jest.fn((e) => Promise.resolve(e)),
  findOne: jest.fn(),
  find: jest.fn().mockResolvedValue([]),
  findAndCount: jest.fn().mockResolvedValue([[], 0]),
  count: jest.fn().mockResolvedValue(0),
  delete: jest.fn().mockResolvedValue({ affected: 1 }),
  softDelete: jest.fn().mockResolvedValue({ affected: 1 }),
  createQueryBuilder: jest.fn(),
});

describe("OBS-04 execution report/timeline", () => {
  let service: TaskService;
  let controller: TaskController;
  let execRepo: ReturnType<typeof makeRepo>;
  let reportRepo: ReturnType<typeof makeRepo>;

  beforeEach(async () => {
    execRepo = makeRepo();
    reportRepo = makeRepo();

    const module = await Test.createTestingModule({
      controllers: [TaskController],
      providers: [
        TaskService,
        { provide: getRepositoryToken(Task), useValue: makeRepo() },
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
        {
          provide: getRepositoryToken(ExecutionLogLine),
          useValue: makeRepo(),
        },
        { provide: getRepositoryToken(TaskVersion), useValue: makeRepo() },
        // OBS-04: execution_reports 读侧
        { provide: getRepositoryToken(ExecutionReport), useValue: reportRepo },
        { provide: getQueueToken("task-queue"), useValue: { add: jest.fn() } },
        { provide: DataSource, useValue: { transaction: jest.fn() } },
        {
          provide: SchedulerService,
          useValue: { stop: jest.fn(), scheduleOne: jest.fn(), getStats: jest.fn() },
        },
        { provide: AiService, useValue: { analyzeFailure: jest.fn() } },
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
        {
          provide: NotificationService,
          useValue: {
            notifyFailureWithConfig: jest.fn(),
            notifyFailure: jest.fn(),
            sendAll: jest.fn(),
          },
        },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: SecretsCryptoService,
          useValue: new SecretsCryptoService({ get: () => "" } as any),
        },
      ],
    }).compile();

    service = module.get(TaskService);
    controller = module.get(TaskController);
  });

  describe("buildExecutionTimeline（纯映射）", () => {
    const BASE: ExecutionTimelineSource = {
      status: "failed",
      triggerType: "cron",
      executorAddress: "http://executor-a:3001",
      createdAt: "2026-09-07T01:00:00.000Z",
      startTime: "2026-09-07T01:00:05.000Z",
      endTime: "2026-09-07T01:05:00.000Z",
    };

    it("maps created/started/finished to the exact DB timestamps", () => {
      const tl = buildExecutionTimeline(BASE);
      expect(tl.map((t) => t.phase)).toEqual([
        "created",
        "started",
        "finished",
      ]);
      expect(tl[0]).toMatchObject({
        at: "2026-09-07T01:00:00.000Z",
        detail: "trigger=cron",
      });
      expect(tl[1]).toMatchObject({
        at: "2026-09-07T01:00:05.000Z",
        detail: "executor=http://executor-a:3001",
      });
      expect(tl[2]).toMatchObject({
        at: "2026-09-07T01:05:00.000Z",
        detail: "status=failed",
      });
    });

    it("keeps DB timestamp identity for Date inputs (no re-computation)", () => {
      const tl = buildExecutionTimeline({
        ...BASE,
        createdAt: new Date("2026-09-07T01:00:00.000Z"),
        endTime: new Date("2026-09-07T01:05:00.000Z"),
      });
      // ISO 串与 DB 值逐字符一致——时间线可视化与 DB 时间戳一致的验收契约
      expect(tl[0].at).toBe("2026-09-07T01:00:00.000Z");
      expect(tl[2].at).toBe("2026-09-07T01:05:00.000Z");
    });

    it("renders missing phases as null (pending execution: only created)", () => {
      const tl = buildExecutionTimeline({
        status: "pending",
        triggerType: "manual",
        createdAt: "2026-09-07T08:00:00.000Z",
        startTime: null,
        endTime: null,
      });
      expect(tl[0].at).toBe("2026-09-07T08:00:00.000Z");
      expect(tl[1]).toEqual({ phase: "started", at: null, detail: undefined });
      expect(tl[2]).toEqual({
        phase: "finished",
        at: null,
        detail: "status=pending",
      });
    });

    it("never throws on invalid/absent dates — degrades every phase to null", () => {
      const tl = buildExecutionTimeline({
        createdAt: "not-a-date",
        startTime: undefined,
        endTime: "1970-01-01T99:99:99Z",
      });
      expect(tl.every((t) => t.at === null)).toBe(true);
    });
  });

  describe("getExecutionReport", () => {
    const EXEC = {
      id: "exec-1",
      taskId: "task-1",
      status: "failed",
      triggerType: "cron",
      executorAddress: "http://executor-a:3001",
      createdAt: new Date("2026-09-07T01:00:00.000Z"),
      startTime: new Date("2026-09-07T01:00:05.000Z"),
      endTime: new Date("2026-09-07T01:05:00.000Z"),
      duration: 295000,
      aiAnalysis: "根因：依赖安装超时。",
    };

    it("merges execution + timeline + report row into one payload", async () => {
      execRepo.findOne.mockResolvedValue(EXEC);
      const reportRow = { id: 7, triggerDay: "2026-09-07", failCount: 3 };
      reportRepo.findOne.mockResolvedValue(reportRow);

      const result = await service.getExecutionReport("exec-1", "task-1");
      expect(result.execution).toBe(EXEC);
      expect(result.report).toBe(reportRow);
      expect(result.timeline.map((t) => t.phase)).toEqual([
        "created",
        "started",
        "finished",
      ]);
      expect(result.timeline[2].at).toBe("2026-09-07T01:05:00.000Z");
    });

    it("returns report:null when no execution_reports row exists for the day", async () => {
      execRepo.findOne.mockResolvedValue(EXEC);
      reportRepo.findOne.mockResolvedValue(null);

      const result = await service.getExecutionReport("exec-1", "task-1");
      expect(result.report).toBeNull();
      // 时间线不受报告缺失影响——前端降级渲染骨架
      expect(result.timeline).toHaveLength(3);
    });

    it("matches the report row by execution-day midnight (DATE equality)", async () => {
      execRepo.findOne.mockResolvedValue(EXEC);
      reportRepo.findOne.mockResolvedValue(null);

      await service.getExecutionReport("exec-1", "task-1");
      const where = reportRepo.findOne.mock.calls[0][0].where;
      // 服务实现用本地时区零点（setHours(0,0,0,0)）对齐 DATE 列；断言不绑定
      // CI 的 TZ——只验证"时间成分归零"且落在执行时刻（2026-09-07T01:00Z）
      // 之前的当日零点窗口内。
      expect(where.triggerDay.getHours()).toBe(0);
      expect(where.triggerDay.getMinutes()).toBe(0);
      expect(where.triggerDay.getSeconds()).toBe(0);
      expect(where.triggerDay.getMilliseconds()).toBe(0);
      expect(where.triggerDay.getTime()).toBeLessThanOrEqual(
        new Date("2026-09-07T01:00:00.000Z").getTime(),
      );
      expect(where.triggerDay.getTime()).toBeGreaterThan(
        new Date("2026-09-07T01:00:00.000Z").getTime() - 24 * 3600 * 1000,
      );
    });

    it("propagates 404 for unknown execution / wrong task scope", async () => {
      execRepo.findOne.mockResolvedValue(null);
      await expect(
        service.getExecutionReport("missing", "task-1"),
      ).rejects.toThrow(NotFoundException);
      expect(reportRepo.findOne).not.toHaveBeenCalled();
    });
  });

  describe("TaskController.executionReport", () => {
    it("routes to service with task-scoped params", async () => {
      const payload = { execution: {}, timeline: [], report: null };
      const spy = jest
        .spyOn(service, "getExecutionReport")
        .mockResolvedValue(payload as any);
      await expect(controller.executionReport("task-1", "exec-1")).resolves.toBe(
        payload,
      );
      expect(spy).toHaveBeenCalledWith("exec-1", "task-1");
    });
  });
});
