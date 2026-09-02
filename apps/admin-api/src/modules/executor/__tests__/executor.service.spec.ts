import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { getRepositoryToken } from "@nestjs/typeorm";
import { NotFoundException } from "@nestjs/common";
import { ExecutorService } from "../executor.service";
import { Executor, ExecutorStatus } from "../entities/executor.entity";
import { Task } from "../../task/entities/task.entity";
import {
  TaskExecution,
  ExecutionFailureReason,
  ExecutionStatus,
} from "../../task/entities/task-execution.entity";
import axios from "axios";
import { ConfigService } from "@nestjs/config";
import * as bcrypt from "bcrypt";
import { NotificationService } from "../../notification/notification.service";
import { SystemConfigService } from "../../config/config.service";

jest.mock("axios");
// F-3: dispatch now consults the SSRF layer before every outbound POST. These
// specs exercise selection/rollback logic with fixture addresses (127.0.0.1,
// host1:3002) — stub the guard so they don't perform real DNS lookups.
jest.mock("../../../common/utils/safe-http.util", () => ({
  ...jest.requireActual("../../../common/utils/safe-http.util"),
  assertSafeExecutorUrl: jest
    .fn()
    .mockResolvedValue(new URL("http://fixture:3002/")),
}));
const mockedAxios = axios as jest.Mocked<typeof axios>;

const makeRepo = (overrides: Partial<Record<string, jest.Mock>> = {}) => ({
  findOne: jest.fn(),
  find: jest.fn().mockResolvedValue([]),
  findBy: jest.fn().mockResolvedValue([]),
  create: jest.fn((d) => d),
  save: jest.fn((e) => Promise.resolve(e)),
  update: jest.fn().mockResolvedValue({ affected: 1 }),
  increment: jest.fn().mockResolvedValue(undefined),
  decrement: jest.fn().mockResolvedValue(undefined),
  delete: jest.fn().mockResolvedValue({ affected: 1 }),
  count: jest.fn().mockResolvedValue(0),
  findAndCount: jest.fn().mockResolvedValue([[], 0]),
  createQueryBuilder: jest.fn(() => ({
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
    getOne: jest.fn().mockResolvedValue(null),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
    getRawOne: jest.fn().mockResolvedValue(null),
    getCount: jest.fn().mockResolvedValue(0),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  })),
  ...overrides,
});

describe("ExecutorService (__tests__)", () => {
  let service: ExecutorService;
  let executorRepo: ReturnType<typeof makeRepo>;
  let execRepo: ReturnType<typeof makeRepo>;
  let taskRepo: ReturnType<typeof makeRepo>;
  let taskQueue: { add: jest.Mock };
  let configService: jest.Mocked<Pick<ConfigService, "get">>;

  /** N4: build a service instance wired to a specific executor repo mock. */
  const makeServiceWithRepo = async (repo: ReturnType<typeof makeRepo>) => {
    const module = await Test.createTestingModule({
      providers: [
        ExecutorService,
        { provide: getRepositoryToken(Executor), useValue: repo },
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
        { provide: getRepositoryToken(Task), useValue: taskRepo },
        { provide: getQueueToken("task-queue"), useValue: taskQueue },
        { provide: ConfigService, useValue: configService },
        {
          provide: NotificationService,
          useValue: {
            notifyFailure: jest.fn(),
            notifyFailureWithConfig: jest.fn(),
            notifyExecutorOnline: jest.fn().mockResolvedValue(undefined),
            notifyExecutorOffline: jest.fn().mockResolvedValue(undefined),
            sendAll: jest.fn(),
          },
        },
        {
          provide: SystemConfigService,
          useValue: { findOne: jest.fn().mockRejectedValue(new Error("not found")) },
        },
      ],
    }).compile();
    return module.get(ExecutorService);
  };

  beforeEach(async () => {
    executorRepo = makeRepo();
    execRepo = makeRepo();
    taskRepo = makeRepo();
    taskQueue = { add: jest.fn().mockResolvedValue(undefined) };
    configService = { get: jest.fn().mockReturnValue("http") };
    const module = await Test.createTestingModule({
      providers: [
        ExecutorService,
        { provide: getRepositoryToken(Executor), useValue: executorRepo },
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
        { provide: getRepositoryToken(Task), useValue: taskRepo },
        { provide: getQueueToken("task-queue"), useValue: taskQueue },
        { provide: ConfigService, useValue: configService },
        { provide: NotificationService, useValue: { notifyFailure: jest.fn(), notifyFailureWithConfig: jest.fn(), notifyExecutorOnline: jest.fn().mockResolvedValue(undefined), notifyExecutorOffline: jest.fn().mockResolvedValue(undefined), sendAll: jest.fn() } },
        { provide: SystemConfigService, useValue: { findOne: jest.fn().mockRejectedValue(new Error("not found")) } },
      ],
    }).compile();
    service = module.get(ExecutorService);
    jest.clearAllMocks();
  });

  describe("register", () => {
    it("creates a new executor when address is not registered", async () => {
      executorRepo.findOne.mockResolvedValue(null);
      executorRepo.save.mockResolvedValue({
        id: "e1",
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
      });
      const result = await service.register({
        appName: "e1",
        address: "127.0.0.1:3105",
      });
      expect(executorRepo.save).toHaveBeenCalled();
      expect(result.status).toBe(ExecutorStatus.ONLINE);
    });

    it("updates existing executor to ONLINE on re-register", async () => {
      const existing = {
        appName: "e1",
        address: "127.0.0.1:3105",
        status: ExecutorStatus.OFFLINE,
      };
      executorRepo.findOne.mockResolvedValue(existing);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      await service.register({ appName: "e1", address: "127.0.0.1:3105" });
      expect(existing.status).toBe(ExecutorStatus.ONLINE);
    });

    it("marks running executions failed when an executor re-registers after restart", async () => {
      const existing = {
        appName: "e1",
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
        executorStartupId: "startup-old",
        executorStartedAt: new Date("2026-01-01T00:00:00.000Z"),
      };
      const runningExecution: any = {
        id: "exec-1",
        executorAddress: existing.address,
        status: ExecutionStatus.RUNNING,
        logs: "before",
      };
      executorRepo.findOne.mockResolvedValue(existing);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      execRepo.find.mockResolvedValue([runningExecution]);
      execRepo.save.mockImplementation((e: any) => Promise.resolve(e));

      await service.register({
        appName: "e1",
        address: existing.address,
        restartedAt: "2026-01-01T00:01:00.000Z",
        startupId: "startup-new",
      });

      expect(runningExecution.status).toBe(ExecutionStatus.FAILED);
      expect(runningExecution.failureReason).toBe(
        ExecutionFailureReason.EXECUTOR_RESTART,
      );
      expect(runningExecution.errorMessage).toContain("Executor restarted");
      expect(execRepo.save).toHaveBeenCalledWith(runningExecution);
      expect(taskQueue.add).not.toHaveBeenCalled();
    });

    it("schedules a retry for restart-failed executions when attempts remain", async () => {
      const existing = {
        appName: "e1",
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
        executorStartupId: "startup-old",
      };
      const task = {
        id: "task-1",
        name: "Task 1",
        params: { fromTask: true },
        currentVersion: "v1",
        maxRetry: 3,
        retryDelay: 5,
      };
      const runningExecution: any = {
        id: "exec-1",
        taskId: task.id,
        taskName: task.name,
        executorAddress: existing.address,
        status: ExecutionStatus.RUNNING,
        params: { fromExecution: true },
        triggerType: "manual",
        taskVersion: "v1",
        retryCount: 0,
        logs: "before",
      };
      executorRepo.findOne.mockResolvedValue(existing);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      execRepo.find.mockResolvedValue([runningExecution]);
      taskRepo.findBy.mockResolvedValue([task]);
      execRepo.save.mockImplementation((e: any) =>
        Promise.resolve(e.id ? e : { ...e, id: "retry-exec" }),
      );

      await service.register({
        appName: "e1",
        address: existing.address,
        startupId: "startup-new",
      });

      expect(execRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: task.id,
          taskName: task.name,
          status: ExecutionStatus.PENDING,
          params: runningExecution.params,
          triggerType: runningExecution.triggerType,
          taskVersion: runningExecution.taskVersion,
          retryCount: 1,
        }),
      );
      expect(taskQueue.add).toHaveBeenCalledWith(
        "execute",
        { executionId: "retry-exec" },
        { attempts: 2, backoff: { type: "exponential", delay: 5_000 } },
      );
    });

    it("recovers running executions predating startup when old executors lack startup baseline", async () => {
      const existing = {
        appName: "e1",
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
        executorStartupId: null,
        executorStartedAt: null,
      };
      const runningExecution: any = {
        id: "exec-1",
        executorAddress: existing.address,
        status: ExecutionStatus.RUNNING,
        startTime: new Date("2026-01-01T00:00:00.000Z"),
        logs: "before",
      };
      executorRepo.findOne.mockResolvedValue(existing);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      execRepo.find.mockResolvedValue([runningExecution]);
      execRepo.save.mockImplementation((e: any) => Promise.resolve(e));

      await service.register({
        appName: "e1",
        address: existing.address,
        restartedAt: "2026-01-01T00:01:00.000Z",
        startupId: "startup-new",
      });

      expect(runningExecution.status).toBe(ExecutionStatus.FAILED);
      expect(runningExecution.failureReason).toBe(
        ExecutionFailureReason.EXECUTOR_RESTART,
      );
      expect(existing.executorStartupId).toBe("startup-new");
    });

    it("does not fail newer running executions when initializing missing startup baseline", async () => {
      const existing = {
        appName: "e1",
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
        executorStartupId: null,
        executorStartedAt: null,
      };
      const runningExecution: any = {
        id: "exec-1",
        executorAddress: existing.address,
        status: ExecutionStatus.RUNNING,
        startTime: new Date("2026-01-01T00:02:00.000Z"),
        logs: "before",
      };
      executorRepo.findOne.mockResolvedValue(existing);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      execRepo.find.mockResolvedValue([runningExecution]);

      await service.register({
        appName: "e1",
        address: existing.address,
        restartedAt: "2026-01-01T00:01:00.000Z",
        startupId: "startup-new",
      });

      expect(runningExecution.status).toBe(ExecutionStatus.RUNNING);
      expect(execRepo.save).not.toHaveBeenCalledWith(runningExecution);
      expect(existing.executorStartupId).toBe("startup-new");
    });

    it("does not abort restart recovery when retry enqueue fails", async () => {
      const existing = {
        appName: "e1",
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
        executorStartupId: "startup-old",
      };
      const task = {
        id: "task-1",
        name: "Task 1",
        params: {},
        currentVersion: "v1",
        maxRetry: 3,
        retryDelay: 5,
      };
      const runningExecution: any = {
        id: "exec-1",
        taskId: task.id,
        taskName: task.name,
        executorAddress: existing.address,
        status: ExecutionStatus.RUNNING,
        retryCount: 0,
        logs: "before",
      };
      executorRepo.findOne.mockResolvedValue(existing);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      execRepo.find.mockResolvedValue([runningExecution]);
      taskRepo.findBy.mockResolvedValue([task]);
      execRepo.save.mockImplementation((e: any) =>
        Promise.resolve(e.id ? e : { ...e, id: "retry-exec" }),
      );
      taskQueue.add.mockRejectedValue(new Error("redis down"));

      await service.register({
        appName: "e1",
        address: existing.address,
        startupId: "startup-new",
      });

      expect(runningExecution.status).toBe(ExecutionStatus.FAILED);
      expect(execRepo.delete).toHaveBeenCalledWith("retry-exec");
      expect(existing.executorStartupId).toBe("startup-new");
      expect(executorRepo.save).toHaveBeenCalledWith(existing);
    });

    it("maps runtime and maxConcurrent aliases during registration", async () => {
      executorRepo.findOne.mockResolvedValue(null);
      executorRepo.create.mockImplementation((e: any) => e);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));

      const result = await service.register({
        appName: "python-executor",
        address: "127.0.0.1:3106",
        type: "python",
        runtime: ["python", "shell"],
        maxConcurrent: 4,
      });

      expect(result.capabilities).toEqual(["python", "shell"]);
      expect(result.maxConcurrentTasks).toBe(4);
      expect(result.status).toBe(ExecutorStatus.ONLINE);
    });

    it("updates mutable metadata and maxConcurrentTasks on re-register", async () => {
      const existing: any = {
        appName: "old",
        address: "127.0.0.1:3105",
        status: ExecutorStatus.OFFLINE,
        capabilities: ["shell"],
        maxConcurrentTasks: 1,
      };
      executorRepo.findOne.mockResolvedValue(existing);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));

      await service.register({
        appName: "node-executor",
        address: "127.0.0.1:3105",
        type: "node",
        capabilities: ["node", "shell"],
        maxConcurrentTasks: 10,
        groupName: "prod",
        tags: ["nodejs"],
        description: "Production executor",
      });

      expect(existing.appName).toBe("node-executor");
      expect(existing.type).toBe("node");
      expect(existing.capabilities).toEqual(["node", "shell"]);
      expect(existing.maxConcurrentTasks).toBe(10);
      expect(existing.groupName).toBe("prod");
      expect(existing.tags).toEqual(["nodejs"]);
      expect(existing.description).toBe("Production executor");
      expect(existing.status).toBe(ExecutorStatus.ONLINE);
    });
  });

  describe("registerExecutor — N4 idempotent token issuance", () => {
    const makeQbRepo = (prior: any) =>
      makeRepo({
        createQueryBuilder: jest.fn(() => ({
          addSelect: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockResolvedValue(prior),
        })),
      });

    it("issues a token on first registration (no prior row)", async () => {
      const repo = makeQbRepo(null);
      const saved = {
        id: "e1",
        appName: "node",
        address: "10.0.0.9:3002",
        status: ExecutorStatus.ONLINE,
      };
      repo.findOne.mockResolvedValue(saved);
      repo.save.mockImplementation((e: any) => Promise.resolve({ ...e, id: "e1" }));
      const svc = await makeServiceWithRepo(repo);
      jest
        .spyOn(svc, "rotateToken")
        .mockResolvedValue({ token: "issued-token" });

      const { executor, perExecutorToken } = await svc.registerExecutor({
        appName: "node",
        address: "10.0.0.9:3002",
        startupId: "startup-1",
      });

      expect(executor.id).toBe("e1");
      expect(perExecutorToken).toBe("issued-token");
    });

    it("returns perExecutorToken=null for a duplicate register with the same address+startupId (rotation storm fix)", async () => {
      const prior = {
        id: "e1",
        address: "10.0.0.9:3002",
        executorStartupId: "startup-1",
        executorStartedAt: new Date("2026-01-01T00:00:00Z"),
        tokenHash: "$2b$12$existinghash",
      };
      const repo = makeQbRepo(prior);
      repo.findOne.mockResolvedValue({ ...prior, status: ExecutorStatus.ONLINE });
      repo.save.mockImplementation((e: any) => Promise.resolve(e));
      const svc = await makeServiceWithRepo(repo);
      const rotateSpy = jest.spyOn(svc, "rotateToken");

      const { perExecutorToken } = await svc.registerExecutor({
        appName: "node",
        address: "10.0.0.9:3002",
        startupId: "startup-1",
      });

      expect(perExecutorToken).toBeNull();
      expect(rotateSpy).not.toHaveBeenCalled();
    });

    it("rotates when the startupId changed (genuine restart)", async () => {
      const prior = {
        id: "e1",
        address: "10.0.0.9:3002",
        executorStartupId: "startup-1",
        executorStartedAt: new Date("2026-01-01T00:00:00Z"),
        tokenHash: "$2b$12$existinghash",
      };
      const repo = makeQbRepo(prior);
      repo.findOne.mockResolvedValue({ ...prior });
      repo.save.mockImplementation((e: any) => Promise.resolve(e));
      const svc = await makeServiceWithRepo(repo);
      const rotateSpy = jest
        .spyOn(svc, "rotateToken")
        .mockResolvedValue({ token: "new-token" });

      const { perExecutorToken } = await svc.registerExecutor({
        appName: "node",
        address: "10.0.0.9:3002",
        startupId: "startup-2",
      });

      expect(perExecutorToken).toBe("new-token");
      expect(rotateSpy).toHaveBeenCalledWith("e1");
    });

    it("rotates when no startupId is reported (legacy executor)", async () => {
      const prior = {
        id: "e1",
        address: "10.0.0.9:3002",
        executorStartupId: "startup-1",
        executorStartedAt: new Date("2026-01-01T00:00:00Z"),
        tokenHash: "$2b$12$existinghash",
      };
      const repo = makeQbRepo(prior);
      repo.findOne.mockResolvedValue({ ...prior });
      repo.save.mockImplementation((e: any) => Promise.resolve(e));
      const svc = await makeServiceWithRepo(repo);
      const rotateSpy = jest
        .spyOn(svc, "rotateToken")
        .mockResolvedValue({ token: "legacy-token" });

      const { perExecutorToken } = await svc.registerExecutor({
        appName: "node",
        address: "10.0.0.9:3002",
      });

      expect(perExecutorToken).toBe("legacy-token");
      expect(rotateSpy).toHaveBeenCalled();
    });

    it("rotates when the address has no per-executor token yet", async () => {
      const prior = {
        id: "e1",
        address: "10.0.0.9:3002",
        executorStartupId: "startup-1",
        executorStartedAt: new Date("2026-01-01T00:00:00Z"),
        tokenHash: null,
      };
      const repo = makeQbRepo(prior);
      repo.findOne.mockResolvedValue({ ...prior });
      repo.save.mockImplementation((e: any) => Promise.resolve(e));
      const svc = await makeServiceWithRepo(repo);
      const rotateSpy = jest
        .spyOn(svc, "rotateToken")
        .mockResolvedValue({ token: "first-token" });

      const { perExecutorToken } = await svc.registerExecutor({
        appName: "node",
        address: "10.0.0.9:3002",
        startupId: "startup-1",
      });

      expect(perExecutorToken).toBe("first-token");
      expect(rotateSpy).toHaveBeenCalled();
    });
  });

  describe("heartbeat", () => {
    it("updates lastHeartbeat and metrics on heartbeat", async () => {
      const executor = {
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
      };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      await service.heartbeat("127.0.0.1:3105", {
        cpuUsage: 30,
        memUsage: 50,
        runningTaskCount: 1,
      });
      expect(executorRepo.save).toHaveBeenCalled();
    });

    it("revives an OFFLINE executor on heartbeat", async () => {
      const executor = {
        address: "127.0.0.1:3105",
        status: ExecutorStatus.OFFLINE,
      };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      await service.heartbeat("127.0.0.1:3105", {});
      expect(executor.status).toBe(ExecutorStatus.ONLINE);
    });

    it("throws NotFoundException when executor address not found", async () => {
      executorRepo.findOne.mockResolvedValue(null);
      await expect(
        service.heartbeat("unknown:9999", {}),
      ).rejects.toThrow(NotFoundException);
    });

    it("recovers running executions predating heartbeat startup when executor lacks startup baseline", async () => {
      const executor = {
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
        executorStartupId: null,
        executorStartedAt: null,
      };
      const oldExecution: any = {
        id: "exec-old",
        executorAddress: executor.address,
        status: ExecutionStatus.RUNNING,
        startTime: new Date("2026-01-01T00:00:00.000Z"),
        logs: "old",
      };
      const newExecution: any = {
        id: "exec-new",
        executorAddress: executor.address,
        status: ExecutionStatus.RUNNING,
        startTime: new Date("2026-01-01T00:02:00.000Z"),
        logs: "new",
      };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      execRepo.find.mockResolvedValue([oldExecution, newExecution]);
      execRepo.save.mockImplementation((e: any) => Promise.resolve(e));

      await service.heartbeat(executor.address, {
        restartedAt: "2026-01-01T00:01:00.000Z",
        startupId: "startup-new",
      });

      expect(oldExecution.status).toBe(ExecutionStatus.FAILED);
      expect(oldExecution.failureReason).toBe(
        ExecutionFailureReason.EXECUTOR_RESTART,
      );
      expect(newExecution.status).toBe(ExecutionStatus.RUNNING);
      expect(execRepo.save).toHaveBeenCalledWith(oldExecution);
      expect(execRepo.save).not.toHaveBeenCalledWith(newExecution);
      expect(executor.executorStartupId).toBe("startup-new");
    });

    it("continues heartbeat restart recovery when one retry enqueue fails", async () => {
      const executor = {
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
        executorStartupId: "startup-old",
      };
      const task = {
        id: "task-1",
        name: "Task 1",
        params: {},
        currentVersion: "v1",
        maxRetry: 3,
        retryDelay: 0,
      };
      const firstExecution: any = {
        id: "exec-1",
        taskId: task.id,
        taskName: task.name,
        executorAddress: executor.address,
        status: ExecutionStatus.RUNNING,
        retryCount: 0,
        logs: "first",
      };
      const secondExecution: any = {
        id: "exec-2",
        taskId: task.id,
        taskName: task.name,
        executorAddress: executor.address,
        status: ExecutionStatus.RUNNING,
        retryCount: 0,
        logs: "second",
      };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      execRepo.find.mockResolvedValue([firstExecution, secondExecution]);
      taskRepo.findBy.mockResolvedValue([task]);
      execRepo.save.mockImplementation((e: any) =>
        Promise.resolve(e.id ? e : { ...e, id: `retry-${execRepo.save.mock.calls.length}` }),
      );
      taskQueue.add
        .mockRejectedValueOnce(new Error("redis down"))
        .mockResolvedValueOnce(undefined);

      await service.heartbeat(executor.address, { startupId: "startup-new" });

      expect(firstExecution.status).toBe(ExecutionStatus.FAILED);
      expect(secondExecution.status).toBe(ExecutionStatus.FAILED);
      expect(execRepo.delete).toHaveBeenCalledWith("retry-2");
      expect(taskQueue.add).toHaveBeenCalledTimes(2);
      expect(executor.executorStartupId).toBe("startup-new");
      expect(executorRepo.save).toHaveBeenCalledWith(executor);
    });
  });

  describe("findAll", () => {
    it("returns all executors", async () => {
      const list = [{ id: "e1" }, { id: "e2" }];
      executorRepo.find.mockResolvedValue(list);
      const result = await service.findAll();
      expect(result).toHaveLength(2);
    });
  });

  describe("findOne", () => {
    it("returns executor when found", async () => {
      const ex = { id: "e1", address: "127.0.0.1" };
      executorRepo.findOne.mockResolvedValue(ex);
      await expect(service.findOne("e1")).resolves.toEqual(ex);
    });

    it("throws NotFoundException when not found", async () => {
      executorRepo.findOne.mockResolvedValue(null);
      await expect(service.findOne("missing")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("update", () => {
    it("merges data into executor and saves", async () => {
      const executor = { id: "e1", groupName: "old", tags: [] };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      const result = await service.update("e1", {
        groupName: "production",
        tags: ["nodejs"],
      });
      expect(result.groupName).toBe("production");
      expect(result.tags).toEqual(["nodejs"]);
    });

    it("throws NotFoundException when executor not found", async () => {
      executorRepo.findOne.mockResolvedValue(null);
      await expect(
        service.update("missing", { groupName: "x" }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("getGroups", () => {
    it("returns distinct groupNames", async () => {
      const qb = executorRepo.createQueryBuilder();
      qb.getRawMany.mockResolvedValue([
        { groupName: "prod" },
        { groupName: "staging" },
      ]);
      executorRepo.createQueryBuilder.mockReturnValue(qb);
      const result = await service.getGroups();
      expect(result).toEqual(["prod", "staging"]);
    });

    it("filters out null groupNames", async () => {
      const qb = executorRepo.createQueryBuilder();
      qb.getRawMany.mockResolvedValue([{ groupName: null }, { groupName: "prod" }]);
      executorRepo.createQueryBuilder.mockReturnValue(qb);
      const result = await service.getGroups();
      expect(result).toEqual(["prod"]);
    });
  });

  describe("getTags", () => {
    it("returns sorted unique tags across all executors", async () => {
      executorRepo.find.mockResolvedValue([
        { tags: ["nodejs", "prod"] },
        { tags: ["python", "nodejs"] },
      ]);
      const result = await service.getTags();
      expect(result).toEqual(["nodejs", "prod", "python"]);
    });

    it("returns empty array when no executors have tags", async () => {
      executorRepo.find.mockResolvedValue([{ tags: null }, { tags: [] }]);
      const result = await service.getTags();
      expect(result).toEqual([]);
    });
  });

  describe("dispatch", () => {
    const executor = {
      id: "e1",
      address: "127.0.0.1:3105",
      status: ExecutorStatus.ONLINE,
      runningTaskCount: 0,
      capabilities: ["node"],
      token: "tok",
    };
    const execution = { id: "exec-1", params: {} } as TaskExecution;
    const task = {
      id: "task-1",
      name: "test",
      runtime: "node",
      timeout: 10,
      status: "active",
      triggerType: "manual",
    } as unknown as Task;

    it("dispatches to an online executor and returns response data", async () => {
      executorRepo.find.mockResolvedValue([executor]);
      mockedAxios.post.mockResolvedValue({
        data: { success: true, logs: "done" },
      });
      const result = await service.dispatch(task, execution);
      expect(result.success).toBe(true);
      expect(executorRepo.createQueryBuilder).toHaveBeenCalled();
    });

    it("decrements running count when dispatch HTTP call fails", async () => {
      executorRepo.find.mockResolvedValue([executor]);
      mockedAxios.post.mockRejectedValue(new Error("connection refused"));
      await expect(service.dispatch(task, execution)).rejects.toThrow(
        "connection refused",
      );
      expect(executorRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
    });

    it("throws when no executor is available", async () => {
      executorRepo.find.mockResolvedValue([]);
      await expect(service.dispatch(task, execution)).rejects.toThrow(
        "No online executors match the requested group/tags/runtime",
      );
    });

    it("skips offline executors when selecting", async () => {
      const offline = { ...executor, status: ExecutorStatus.OFFLINE };
      executorRepo.find.mockResolvedValue([offline]);
      await expect(service.dispatch(task, execution)).rejects.toThrow();
    });

    it("filters by executorGroup when specified", async () => {
      const taskWithGroup = { ...task, executorGroup: "production" } as unknown as Task;
      const wrongGroup = { ...executor, id: "e2", groupName: "staging" };
      const rightGroup = { ...executor, id: "e3", groupName: "production" };
      executorRepo.find.mockResolvedValue([wrongGroup, rightGroup]);
      mockedAxios.post.mockResolvedValue({ data: { success: true } });
      await service.dispatch(taskWithGroup, execution);
      const postCall = mockedAxios.post.mock.calls[0][0] as string;
      expect(postCall).toContain(rightGroup.address);
    });
  });

  describe("dispatchBroadcast", () => {
    const execution = { id: "exec-1", params: {} } as TaskExecution;
    const task = {
      id: "task-1",
      name: "broadcast-task",
      timeout: 10,
    } as unknown as Task;

    it("sends to all online executors and returns successes", async () => {
      executorRepo.find.mockResolvedValue([
        { id: "e1", address: "host1:3002", status: ExecutorStatus.ONLINE },
        { id: "e2", address: "host2:3002", status: ExecutorStatus.ONLINE },
      ]);
      mockedAxios.post.mockResolvedValue({ data: { ok: true } });
      const results = await service.dispatchBroadcast(task, execution);
      expect(results).toHaveLength(2);
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    });

    it("throws when all executors fail", async () => {
      executorRepo.find.mockResolvedValue([
        { id: "e1", address: "host1:3002", status: ExecutorStatus.ONLINE },
      ]);
      mockedAxios.post.mockRejectedValue(new Error("timeout"));
      await expect(service.dispatchBroadcast(task, execution)).rejects.toThrow(
        "Broadcast failed",
      );
    });

    it("throws when no executors are available", async () => {
      executorRepo.find.mockResolvedValue([]);
      await expect(service.dispatchBroadcast(task, execution)).rejects.toThrow(
        "No online executors match the requested group/tags/runtime",
      );
    });

    it("returns partial successes when some executors fail", async () => {
      executorRepo.find.mockResolvedValue([
        { id: "e1", address: "host1:3002", status: ExecutorStatus.ONLINE },
        { id: "e2", address: "host2:3002", status: ExecutorStatus.ONLINE },
      ]);
      mockedAxios.post
        .mockResolvedValueOnce({ data: { ok: true } })
        .mockRejectedValueOnce(new Error("host2 down"));
      const results = await service.dispatchBroadcast(task, execution);
      expect(results).toHaveLength(1);
    });
  });

  describe("markOffline", () => {
    it("sets executor status to OFFLINE", async () => {
      executorRepo.update.mockResolvedValue({ affected: 1 });
      await service.markOffline("127.0.0.1:3105");
      expect(executorRepo.update).toHaveBeenCalledWith(
        { address: "127.0.0.1:3105" },
        expect.objectContaining({ status: ExecutorStatus.OFFLINE }),
      );
    });
  });

  describe("rotateToken", () => {
    it("generates a new token, hashes and saves it", async () => {
      const executor = { id: "e1", address: "127.0.0.1", tokenHash: null };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      const result = await service.rotateToken("e1");
      expect(result).toHaveProperty("token");
      expect(typeof result.token).toBe("string");
      expect(result.token.length).toBeGreaterThan(0);
      expect(executor.tokenHash).toBeTruthy();
    });

    it("throws NotFoundException when executor not found", async () => {
      executorRepo.findOne.mockResolvedValue(null);
      await expect(service.rotateToken("missing")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("validateTokenByAddress", () => {
    it("returns true for valid per-executor token", async () => {
      const rawToken = "raw-secret";
      const hash = await bcrypt.hash(rawToken, 1);
      const qb = executorRepo.createQueryBuilder();
      qb.getOne.mockResolvedValue({ address: "host:3002", tokenHash: hash });
      executorRepo.createQueryBuilder.mockReturnValue(qb);
      const result = await service.validateTokenByAddress("host:3002", rawToken);
      expect(result).toBe(true);
    });

    it("falls back to shared token when no per-executor hash", async () => {
      const qb = executorRepo.createQueryBuilder();
      qb.getOne.mockResolvedValue({ address: "host:3002", tokenHash: null });
      executorRepo.createQueryBuilder.mockReturnValue(qb);
      configService.get.mockReturnValue("shared-secret");
      const result = await service.validateTokenByAddress("host:3002", "shared-secret");
      expect(result).toBe(true);
    });

    it("returns false for invalid token", async () => {
      const qb = executorRepo.createQueryBuilder();
      qb.getOne.mockResolvedValue({ address: "host:3002", tokenHash: null });
      executorRepo.createQueryBuilder.mockReturnValue(qb);
      configService.get.mockReturnValue("");
      const result = await service.validateTokenByAddress("host:3002", "wrong");
      expect(result).toBe(false);
    });
  });

  describe("getExecutorExecutions", () => {
    it("returns paginated executions for executor", async () => {
      const executor = { id: "e1", address: "host:3002" };
      executorRepo.findOne.mockResolvedValue(executor);
      execRepo.findAndCount.mockResolvedValue([[{ id: "ex1" }], 1]);
      const result = await service.getExecutorExecutions("e1", {
        page: 1,
        pageSize: 10,
      });
      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
    });

    it("throws when executor not found", async () => {
      executorRepo.findOne.mockResolvedValue(null);
      await expect(
        service.getExecutorExecutions("missing", { page: 1, pageSize: 10 }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("getExecutorMetrics", () => {
    it("returns stats for a given executor", async () => {
      const executor = {
        id: "e1",
        address: "host:3002",
        status: ExecutorStatus.ONLINE,
        runningTaskCount: 2,
        cpuUsage: 40,
        memUsage: 60,
      };
      executorRepo.findOne.mockResolvedValue(executor);
      const qb = execRepo.createQueryBuilder();
      qb.getRawOne.mockResolvedValue({ total: '100', successful: '95', failed: '5', avgDuration: '1200' });
      execRepo.createQueryBuilder.mockReturnValue(qb);
      const result = await service.getExecutorMetrics("e1");
      expect(result.sevenDayStats.totalExecutions).toBe(100);
      expect(result.sevenDayStats.successful).toBe(95);
      expect(result.current.runningTaskCount).toBe(2);
    });
  });

  describe("cleanupOldRecords", () => {
    it("deletes executions older than 90 days", async () => {
      execRepo.delete.mockResolvedValue({ affected: 5 });
      await service.cleanupOldRecords();
      expect(execRepo.delete).toHaveBeenCalledWith(
        expect.objectContaining({ createdAt: expect.anything() }),
      );
    });
  });

  describe("markStaleOffline", () => {
    it("marks heartbeat-timeout executors as OFFLINE", async () => {
      configService.get
        .mockReturnValueOnce(30000)  // heartbeatInterval
        .mockReturnValueOnce(3);     // timeoutMultiplier
      // find() must return stale executors so the early-return guard is skipped
      executorRepo.find.mockResolvedValue([{ id: "exec-1", appName: "app", address: "http://host" }]);
      executorRepo.update.mockResolvedValue({ affected: 1 });
      await service.markStaleOffline();
      expect(executorRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: ExecutorStatus.ONLINE }),
        { status: ExecutorStatus.OFFLINE },
      );
    });
  });

  describe("setOfflineById", () => {
    it("sets status OFFLINE and refreshes heartbeat", async () => {
      const executor: any = {
        id: "exec-9",
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
      };
      executorRepo.findOne.mockResolvedValue(executor);
      const saved = await service.setOfflineById("exec-9");
      expect(executorRepo.findOne).toHaveBeenCalledWith({
        where: { id: "exec-9" },
      });
      expect(executorRepo.save).toHaveBeenCalledWith(executor);
      expect(saved.status).toBe(ExecutorStatus.OFFLINE);
      expect(saved.lastHeartbeat).toBeInstanceOf(Date);
    });

    it("throws NotFoundException when executor does not exist", async () => {
      executorRepo.findOne.mockResolvedValue(null);
      await expect(service.setOfflineById("missing")).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
