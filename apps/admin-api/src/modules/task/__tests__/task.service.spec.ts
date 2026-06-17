import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { getQueueToken } from "@nestjs/bull";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { TaskService } from "../task.service";
import { Task, TaskStatus } from "../entities/task.entity";
import {
  TaskExecution,
  ExecutionStatus,
} from "../entities/task-execution.entity";
import { ExecutionLogLine } from "../entities/execution-log-line.entity";
import { TaskVersion } from "../entities/task-version.entity";
import { SchedulerService } from "../../scheduler/scheduler.service";
import { AiService } from "../../ai/ai.service";

const makeRepo = (overrides: Record<string, jest.Mock> = {}) => ({
  create: jest.fn((d) => d),
  save: jest.fn((e) => Promise.resolve(e)),
  findOne: jest.fn(),
  findAndCount: jest.fn().mockResolvedValue([[], 0]),
  find: jest.fn().mockResolvedValue([]),
  count: jest.fn().mockResolvedValue(0),
  delete: jest.fn().mockResolvedValue({ affected: 1 }),
  createQueryBuilder: jest.fn(() => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
    getRawOne: jest.fn().mockResolvedValue({ maxNum: 0 }),
  })),
  ...overrides,
});

describe("TaskService (__tests__)", () => {
  let service: TaskService;
  let taskRepo: ReturnType<typeof makeRepo>;
  let execRepo: ReturnType<typeof makeRepo>;
  let logLineRepo: ReturnType<typeof makeRepo>;
  let versionRepo: ReturnType<typeof makeRepo>;
  let taskQueue: { add: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let schedulerService: {
    stop: jest.Mock;
    scheduleOne: jest.Mock;
    getStats: jest.Mock;
  };

  beforeEach(async () => {
    taskRepo = makeRepo();
    execRepo = makeRepo();
    logLineRepo = makeRepo();
    versionRepo = makeRepo();
    taskQueue = { add: jest.fn().mockResolvedValue({}) };
    dataSource = { transaction: jest.fn() };
    schedulerService = {
      stop: jest.fn(),
      scheduleOne: jest.fn().mockResolvedValue(undefined),
      getStats: jest.fn().mockReturnValue({}),
    };

    const aiService = {
      analyzeFailure: jest.fn().mockResolvedValue(""),
      chat: jest.fn().mockResolvedValue(""),
    };

    const module = await Test.createTestingModule({
      providers: [
        TaskService,
        { provide: getRepositoryToken(Task), useValue: taskRepo },
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
        {
          provide: getRepositoryToken(ExecutionLogLine),
          useValue: logLineRepo,
        },
        { provide: getRepositoryToken(TaskVersion), useValue: versionRepo },
        { provide: getQueueToken("task-queue"), useValue: taskQueue },
        { provide: DataSource, useValue: dataSource },
        { provide: SchedulerService, useValue: schedulerService },
        { provide: AiService, useValue: aiService },
      ],
    }).compile();

    service = module.get(TaskService);
  });

  describe("create", () => {
    it("creates and saves a task with no dependencies", async () => {
      const dto = { name: "test-task" } as any;
      taskRepo.save.mockResolvedValue({ id: "1", ...dto });
      const result = await service.create(dto);
      expect(taskRepo.create).toHaveBeenCalledWith(dto);
      expect(taskRepo.save).toHaveBeenCalled();
      expect(result).toHaveProperty("id", "1");
    });

    it("throws on circular self-dependency", async () => {
      const dto = {
        id: "task-a",
        name: "cycle",
        dependencies: { dep1: "task-a" },
      } as any;
      await expect(service.create(dto)).rejects.toThrow("Circular dependency");
    });
  });

  describe("findOne", () => {
    it("returns task when found", async () => {
      const task = { id: "1", name: "test" };
      taskRepo.findOne.mockResolvedValue(task);
      await expect(service.findOne("1")).resolves.toEqual(task);
    });

    it("throws NotFoundException when not found", async () => {
      taskRepo.findOne.mockResolvedValue(null);
      await expect(service.findOne("missing")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("findAll", () => {
    it("returns paginated list", async () => {
      const tasks = [{ id: "1" }, { id: "2" }];
      taskRepo.findAndCount.mockResolvedValue([tasks, 2]);
      const result = await service.findAll({ page: 1, pageSize: 10 });
      expect(result).toHaveProperty("total", 2);
      expect(result.list).toHaveLength(2);
    });

    it("passes name ILike filter when name param is provided", async () => {
      taskRepo.findAndCount.mockResolvedValue([[{ id: "1", name: "my-job" }], 1]);
      await service.findAll({ page: 1, pageSize: 10, name: "job" } as any);
      const callArgs = taskRepo.findAndCount.mock.calls[0][0];
      expect(callArgs.where.name).toEqual(expect.objectContaining({ _value: "%job%" }));
    });

    it("passes runtime filter when runtime param is provided", async () => {
      taskRepo.findAndCount.mockResolvedValue([[{ id: "1" }], 1]);
      await service.findAll({ page: 1, pageSize: 10, runtime: "python" } as any);
      const callArgs = taskRepo.findAndCount.mock.calls[0][0];
      expect(callArgs.where.runtime).toBe("python");
    });

    it("excludes DELETED tasks by default", async () => {
      taskRepo.findAndCount.mockResolvedValue([[], 0]);
      await service.findAll({ page: 1, pageSize: 10 });
      const callArgs = taskRepo.findAndCount.mock.calls[0][0];
      // where.status should be a Not() wrapper, not a plain string
      expect(typeof callArgs.where.status).toBe("object");
    });
  });

  describe("update", () => {
    it("saves updated task and re-schedules active tasks", async () => {
      const task = { id: "1", name: "old", status: TaskStatus.ACTIVE };
      taskRepo.findOne.mockResolvedValue(task);
      taskRepo.save.mockResolvedValue({
        ...task,
        name: "new",
        status: TaskStatus.ACTIVE,
      });
      await service.update("1", { name: "new" } as any);
      expect(schedulerService.stop).toHaveBeenCalledWith("1");
      expect(schedulerService.scheduleOne).toHaveBeenCalled();
    });

    it("stops scheduling for non-active tasks after update", async () => {
      const task = { id: "1", name: "old", status: TaskStatus.PAUSED };
      taskRepo.findOne.mockResolvedValue(task);
      taskRepo.save.mockResolvedValue({ ...task, status: TaskStatus.PAUSED });
      await service.update("1", {} as any);
      expect(schedulerService.stop).toHaveBeenCalledWith("1");
      expect(schedulerService.scheduleOne).not.toHaveBeenCalled();
    });
  });

  describe("updateGlue", () => {
    it("updates glueSource and saves", async () => {
      const task = { id: "1", glueSource: "old", glueLanguage: "js" };
      taskRepo.findOne.mockResolvedValue(task);
      taskRepo.save.mockImplementation((t: any) => Promise.resolve(t));
      await service.updateGlue("1", "new-source", "python");
      expect(task.glueSource).toBe("new-source");
      expect(task.glueLanguage).toBe("python");
      expect(taskRepo.save).toHaveBeenCalled();
    });

    it("skips language update when language is not provided", async () => {
      const task = { id: "1", glueSource: "old", glueLanguage: "js" };
      taskRepo.findOne.mockResolvedValue(task);
      taskRepo.save.mockImplementation((t: any) => Promise.resolve(t));
      await service.updateGlue("1", "new-source");
      expect(task.glueLanguage).toBe("js");
    });
  });

  describe("pause", () => {
    it("marks task as paused and stops scheduler", async () => {
      const task = { id: "1", status: TaskStatus.ACTIVE };
      taskRepo.findOne.mockResolvedValue(task);
      taskRepo.save.mockResolvedValue({ ...task, status: TaskStatus.PAUSED });
      const result = await service.pause("1");
      expect(schedulerService.stop).toHaveBeenCalledWith("1");
      expect(result.status).toBe(TaskStatus.PAUSED);
    });

    it("throws if task is already paused", async () => {
      const task = { id: "1", status: TaskStatus.PAUSED };
      taskRepo.findOne.mockResolvedValue(task);
      await expect(service.pause("1")).rejects.toThrow(BadRequestException);
      expect(schedulerService.stop).not.toHaveBeenCalled();
    });
  });

  describe("resume", () => {
    it("marks task as active and re-schedules", async () => {
      const task = { id: "1", status: TaskStatus.PAUSED };
      taskRepo.findOne.mockResolvedValue(task);
      taskRepo.save.mockResolvedValue({ ...task, status: TaskStatus.ACTIVE });
      const result = await service.resume("1");
      expect(schedulerService.scheduleOne).toHaveBeenCalled();
      expect(result.status).toBe(TaskStatus.ACTIVE);
    });

    it("throws if task is not paused", async () => {
      const task = { id: "1", status: TaskStatus.ACTIVE };
      taskRepo.findOne.mockResolvedValue(task);
      await expect(service.resume("1")).rejects.toThrow(BadRequestException);
      expect(schedulerService.scheduleOne).not.toHaveBeenCalled();
    });
  });

  describe("remove", () => {
    it("soft-deletes task and stops scheduler", async () => {
      const task = { id: "1", status: TaskStatus.ACTIVE };
      taskRepo.findOne.mockResolvedValue(task);
      taskRepo.save.mockResolvedValue({ ...task, status: TaskStatus.DELETED });
      const result = await service.remove("1");
      expect(schedulerService.stop).toHaveBeenCalledWith("1");
      expect(result).toEqual({ deleted: true });
    });
  });

  describe("trigger", () => {
    it("creates execution record and enqueues job", async () => {
      const task = {
        id: "1",
        name: "test",
        params: {},
        maxRetry: 3,
        currentVersion: "v1",
        status: TaskStatus.ACTIVE,
      };
      const exec = { id: "exec-1", status: ExecutionStatus.PENDING };
      taskRepo.findOne.mockResolvedValue(task);
      dataSource.transaction.mockImplementation((fn: any) =>
        fn({
          create: jest.fn().mockReturnValue(exec),
          save: jest.fn().mockResolvedValue(exec),
        }),
      );
      const result = await service.trigger("1", {});
      expect(taskQueue.add).toHaveBeenCalledWith(
        "execute",
        { executionId: "exec-1" },
        { attempts: 3, backoff: { type: 'exponential', delay: 10_000 } },
      );
      expect(result).toEqual(exec);
    });

    it("uses dto.params when provided", async () => {
      const task = {
        id: "1",
        name: "test",
        params: { default: true },
        maxRetry: 1,
        currentVersion: "v1",
        status: TaskStatus.ACTIVE,
      };
      const exec = { id: "exec-2", status: ExecutionStatus.PENDING, params: { override: true } };
      taskRepo.findOne.mockResolvedValue(task);
      dataSource.transaction.mockImplementation((fn: any) =>
        fn({
          create: jest.fn().mockReturnValue(exec),
          save: jest.fn().mockResolvedValue(exec),
        }),
      );
      await service.trigger("1", { params: { override: true } });
      expect(taskQueue.add).toHaveBeenCalled();
    });
  });

  describe("getExecution", () => {
    it("returns execution when found", async () => {
      const exec = { id: "exec-1", status: ExecutionStatus.SUCCESS };
      execRepo.findOne.mockResolvedValue(exec);
      await expect(service.getExecution("exec-1")).resolves.toEqual(exec);
    });

    it("throws NotFoundException when not found", async () => {
      execRepo.findOne.mockResolvedValue(null);
      await expect(service.getExecution("missing")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("getAllExecutions", () => {
    it("returns paginated executions without filters", async () => {
      const execs = [{ id: "e1", taskId: "t1" }, { id: "e2", taskId: "t1" }];
      const qbMock = {
        leftJoin: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawAndEntities: jest.fn().mockResolvedValue({ entities: execs, raw: [] }),
        getCount: jest.fn().mockResolvedValue(2),
      };
      execRepo.createQueryBuilder.mockReturnValue(qbMock as any);
      const result = await service.getAllExecutions({ page: 1, pageSize: 10 });
      expect(result).toHaveProperty("total", 2);
      expect(result.list).toHaveLength(2);
    });

    it("applies status and taskId filters", async () => {
      const qbMock = {
        leftJoin: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawAndEntities: jest.fn().mockResolvedValue({ entities: [{ id: "e1", taskId: "task-1" }], raw: [] }),
        getCount: jest.fn().mockResolvedValue(1),
      };
      execRepo.createQueryBuilder.mockReturnValue(qbMock as any);
      const result = await service.getAllExecutions({
        page: 1,
        pageSize: 10,
        status: "success",
        taskId: "task-1",
      });
      expect(result.total).toBe(1);
      // andWhere should have been called for status and taskId filters
      expect(qbMock.andWhere).toHaveBeenCalledWith(expect.stringContaining("status"), expect.objectContaining({ status: "success" }));
      expect(qbMock.andWhere).toHaveBeenCalledWith(expect.stringContaining("taskId"), expect.objectContaining({ taskId: "task-1" }));
    });
  });

  describe("getExecutionLogs", () => {
    it("throws NotFoundException when execution does not exist", async () => {
      execRepo.findOne.mockResolvedValue(null);
      await expect(service.getExecutionLogs("missing-exec")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("returns lines, totalLines and hasMore", async () => {
      execRepo.findOne.mockResolvedValue({ id: "exec-1" });
      logLineRepo.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          { lineNumber: 0, content: "line0" },
          { lineNumber: 1, content: "line1" },
        ]),
        getRawOne: jest.fn().mockResolvedValue({ maxNum: 0 }),
      } as any);
      logLineRepo.count.mockResolvedValue(5);
      const result = await service.getExecutionLogs("exec-1", 0);
      expect(result.lines).toEqual(["line0", "line1"]);
      expect(result.totalLines).toBe(5);
      expect(result.hasMore).toBe(true);
    });

    it("hasMore is false when all lines are returned", async () => {
      execRepo.findOne.mockResolvedValue({ id: "exec-1" });
      logLineRepo.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          { lineNumber: 0, content: "only-line" },
        ]),
        getRawOne: jest.fn().mockResolvedValue({ maxNum: 0 }),
      } as any);
      logLineRepo.count.mockResolvedValue(1);
      const result = await service.getExecutionLogs("exec-1", 0);
      expect(result.hasMore).toBe(false);
    });
  });

  describe("rollback", () => {
    it("updates gitCommit and enqueues rollback execution", async () => {
      const task = {
        id: "1",
        name: "test",
        gitCommit: "old-sha",
        params: {},
        maxRetry: 2,
        status: TaskStatus.ACTIVE,
      };
      const exec = { id: "rb-exec", status: ExecutionStatus.PENDING };
      taskRepo.findOne.mockResolvedValue(task);
      dataSource.transaction.mockImplementation((fn: any) =>
        fn({
          save: jest.fn()
            .mockResolvedValueOnce(task)   // first save: update task.gitCommit
            .mockResolvedValueOnce(exec),  // second save: persist execution
          create: jest.fn().mockReturnValue(exec),
        }),
      );
      const result = await service.rollback("1", { gitCommit: "new-sha" });
      expect(result.rolledBackFrom).toBe("old-sha");
      expect(result.rolledBackTo).toBe("new-sha");
      expect(taskQueue.add).toHaveBeenCalledWith(
        "execute",
        { executionId: "rb-exec" },
        { attempts: 2, backoff: { type: 'exponential', delay: 10_000 } },
      );
    });

    it("re-schedules active task after rollback", async () => {
      const task = {
        id: "1",
        name: "test",
        gitCommit: "old-sha",
        params: {},
        maxRetry: 1,
        status: TaskStatus.ACTIVE,
      };
      const exec = { id: "rb-exec" };
      taskRepo.findOne.mockResolvedValue(task);
      dataSource.transaction.mockImplementation((fn: any) =>
        fn({
          save: jest.fn()
            .mockResolvedValueOnce(task)
            .mockResolvedValueOnce(exec),
          create: jest.fn().mockReturnValue(exec),
        }),
      );
      await service.rollback("1", { gitCommit: "new-sha" });
      expect(schedulerService.scheduleOne).toHaveBeenCalled();
    });
  });

  describe("handleCallback", () => {
    it("marks execution as SUCCESS and saves", async () => {
      const exec = { id: "e1", status: ExecutionStatus.RUNNING, logs: "" };
      execRepo.findOne.mockResolvedValue(exec);
      execRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      const result = await service.handleCallback([
        { executionId: "e1", status: "success", durationMs: 100 },
      ]);
      expect(exec.status).toBe(ExecutionStatus.SUCCESS);
      expect(result[0].success).toBe(true);
    });

    it("marks execution as FAILED and stores errorMessage", async () => {
      const exec = { id: "e1", status: ExecutionStatus.RUNNING, logs: "" };
      execRepo.findOne.mockResolvedValue(exec);
      execRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      const result = await service.handleCallback([
        { executionId: "e1", status: "failed", errorMessage: "OOM" },
      ]);
      expect(exec.status).toBe(ExecutionStatus.FAILED);
      expect((exec as any).errorMessage).toBe("OOM");
      expect(result[0].success).toBe(true);
    });

    it("saves log lines when logs are provided", async () => {
      const exec = { id: "e1", status: ExecutionStatus.RUNNING, logs: "" };
      execRepo.findOne.mockResolvedValue(exec);
      execRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      logLineRepo.save.mockResolvedValue({});
      await service.handleCallback([
        { executionId: "e1", status: "success", logs: "line0\nline1" },
      ]);
      expect(logLineRepo.save).toHaveBeenCalledTimes(1);
    });

    it("records error for unknown executionId without throwing", async () => {
      execRepo.findOne.mockResolvedValue(null);
      const result = await service.handleCallback([
        { executionId: "ghost", status: "success" },
      ]);
      expect(result[0].success).toBe(false);
      expect(result[0].error).toMatch(/not found/i);
    });
  });

  describe("saveVersion", () => {
    it("creates a new version snapshot", async () => {
      const task = { id: "t1", name: "task", gitCommit: "sha1" };
      taskRepo.findOne.mockResolvedValue(task);
      versionRepo.find.mockResolvedValue([]);
      versionRepo.save.mockImplementation((v: any) => Promise.resolve({ id: "v1", ...v }));
      const result = await service.saveVersion("t1", "user", "initial");
      expect(result.version).toBe("v1");
      expect(versionRepo.create).toHaveBeenCalled();
    });

    it("throws NotFoundException when task not found", async () => {
      taskRepo.findOne.mockResolvedValue(null);
      await expect(service.saveVersion("missing")).rejects.toThrow(NotFoundException);
    });
  });

  describe("rollbackToVersion", () => {
    it("applies version snapshot to task", async () => {
      const version = {
        id: "v1",
        taskId: "t1",
        version: "v1",
        snapshot: { name: "snapshot-name", timeout: 60 },
      };
      const task = { id: "t1", name: "current", timeout: 30 };
      versionRepo.findOne.mockResolvedValue(version);
      taskRepo.findOne.mockResolvedValue(task);
      taskRepo.save.mockImplementation((t: any) => Promise.resolve(t));
      const result = await service.rollbackToVersion("t1", "v1");
      expect(result.name).toBe("snapshot-name");
      expect(result.timeout).toBe(60);
    });

    it("throws NotFoundException when version not found", async () => {
      versionRepo.findOne.mockResolvedValue(null);
      await expect(service.rollbackToVersion("t1", "missing-v")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("compareVersions", () => {
    it("returns diff for changed fields only", async () => {
      const v1 = { id: "v1", taskId: "t1", version: "v1", snapshot: { name: "old", timeout: 30 } };
      const v2 = { id: "v2", taskId: "t1", version: "v2", snapshot: { name: "new", timeout: 30 } };
      versionRepo.findOne
        .mockResolvedValueOnce(v1)
        .mockResolvedValueOnce(v2);
      const diff = await service.compareVersions("t1", "v1", "v2");
      expect(diff).toHaveProperty("name");
      expect(diff.name).toEqual({ old: "old", new: "new" });
      expect(diff).not.toHaveProperty("timeout");
    });

    it("returns empty diff when snapshots are identical", async () => {
      const snap = { name: "same", timeout: 60 };
      const v1 = { id: "v1", taskId: "t1", version: "v1", snapshot: snap };
      const v2 = { id: "v2", taskId: "t1", version: "v2", snapshot: { ...snap } };
      versionRepo.findOne
        .mockResolvedValueOnce(v1)
        .mockResolvedValueOnce(v2);
      const diff = await service.compareVersions("t1", "v1", "v2");
      expect(Object.keys(diff)).toHaveLength(0);
    });
  });

  describe("getSchedulerStats", () => {
    it("delegates to schedulerService.getStats()", () => {
      schedulerService.getStats.mockReturnValue({ active: 3 });
      expect(service.getSchedulerStats()).toEqual({ active: 3 });
    });
  });

  describe("killExecution", () => {
    it("marks a RUNNING execution as KILLED and saves", async () => {
      const exec = { id: "e1", status: ExecutionStatus.RUNNING, startTime: new Date(Date.now() - 5000) };
      execRepo.findOne.mockResolvedValue(exec);
      execRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      const result = await service.killExecution("e1");
      expect(exec.status).toBe(ExecutionStatus.KILLED);
      expect(exec).toHaveProperty("endTime");
      expect(result.success).toBe(true);
    });

    it("marks a PENDING execution as KILLED", async () => {
      const exec = { id: "e2", status: ExecutionStatus.PENDING };
      execRepo.findOne.mockResolvedValue(exec);
      execRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      const result = await service.killExecution("e2");
      expect(exec.status).toBe(ExecutionStatus.KILLED);
      expect(result.success).toBe(true);
    });

    it("throws NotFoundException when execution does not exist", async () => {
      execRepo.findOne.mockResolvedValue(null);
      await expect(service.killExecution("ghost")).rejects.toThrow(NotFoundException);
    });

    it("throws BadRequestException when execution is already in terminal state", async () => {
      const exec = { id: "e3", status: ExecutionStatus.SUCCESS };
      execRepo.findOne.mockResolvedValue(exec);
      await expect(service.killExecution("e3")).rejects.toThrow(BadRequestException);
    });
  });

  describe("getExecutionStats", () => {
    it("computes successRate and avgDuration from recent executions", async () => {
      const executions = [
        { status: ExecutionStatus.SUCCESS, duration: 200 },
        { status: ExecutionStatus.SUCCESS, duration: 400 },
        { status: ExecutionStatus.FAILED, duration: null },
      ];
      execRepo.find.mockResolvedValue(executions);
      execRepo.count.mockResolvedValue(10);
      const result = await service.getExecutionStats("t1");
      expect(result.successRate).toBeCloseTo(66.7, 0);
      expect(result.avgDuration).toBe(300);
      expect(result.totalRuns).toBe(10);
    });

    it("returns zero successRate and avgDuration when no recent executions", async () => {
      execRepo.find.mockResolvedValue([]);
      execRepo.count.mockResolvedValue(0);
      const result = await service.getExecutionStats("t1");
      expect(result.successRate).toBe(0);
      expect(result.avgDuration).toBe(0);
    });
  });

  describe("getVersions", () => {
    it("returns versions for a task ordered by createdAt DESC", async () => {
      const versions = [{ id: "v2", taskId: "t1" }, { id: "v1", taskId: "t1" }];
      versionRepo.find.mockResolvedValue(versions);
      const result = await service.getVersions("t1");
      expect(result).toEqual(versions);
      expect(versionRepo.find).toHaveBeenCalledWith({
        where: { taskId: "t1" },
        order: { createdAt: "DESC" },
      });
    });
  });

  describe("getVersion", () => {
    it("returns the version when found", async () => {
      const version = { id: "v1", taskId: "t1" };
      versionRepo.findOne.mockResolvedValue(version);
      await expect(service.getVersion("t1", "v1")).resolves.toEqual(version);
    });

    it("throws NotFoundException when version is not found", async () => {
      versionRepo.findOne.mockResolvedValue(null);
      await expect(service.getVersion("t1", "missing")).rejects.toThrow(NotFoundException);
    });
  });

  describe("deleteVersion", () => {
    it("deletes a version by id", async () => {
      const version = { id: "v1", taskId: "t1" };
      versionRepo.findOne.mockResolvedValue(version);
      versionRepo.delete.mockResolvedValue({ affected: 1 });
      await service.deleteVersion("t1", "v1");
      expect(versionRepo.delete).toHaveBeenCalledWith("v1");
    });

    it("throws NotFoundException when version does not exist", async () => {
      versionRepo.findOne.mockResolvedValue(null);
      await expect(service.deleteVersion("t1", "ghost")).rejects.toThrow(NotFoundException);
    });
  });
});
