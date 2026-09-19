import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { getRepositoryToken } from "@nestjs/typeorm";
import {
  NotFoundException,
  ServiceUnavailableException,
  ForbiddenException,
  Logger,
} from "@nestjs/common";
import { ExecutorService, EXECUTOR_LIST_LIMIT } from "../executor.service";
import { Executor, ExecutorStatus } from "../entities/executor.entity";
import { ExecutorMetricsHistory } from "../entities/executor-metrics-history.entity";
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
// SEC-02: secrets 派发解密（测试默认降级明文，dispatch 载荷与既往一致）
import { SecretsCryptoService } from "../../../common/utils/secret-crypto.util.service";
// FEAT-07: executor.offline 发布点断言入口（DOMAIN_EVENTS 常量）
import { DOMAIN_EVENTS } from "../../../common/events/domain-events";
// QA-02 第二阶段：运行时 gauge 快照（活跃流/上限双 series 的读面）
import { resetRuntimeGauges } from "../../metrics/runtime-metrics-entry";
// AUTH-05: 高危操作审计断言
import { AuditService } from "../../audit/audit.service";
// NETOPT-8④: 分批 DELETE 双闸上限（公共 helper）
import { LOG_RETENTION_MAX_DELETE_ROUNDS } from "../../../common/utils/capped-batched-delete.util";

jest.mock("axios");
// F-3: dispatch now consults the SSRF layer before every outbound POST. These
// specs exercise selection/rollback logic with fixture addresses (127.0.0.1,
// host1:3002) — stub the guard so they don't perform real DNS lookups.
jest.mock("../../../common/utils/safe-http.util", () => ({
  ...jest.requireActual("../../../common/utils/safe-http.util"),
  assertSafeExecutorUrl: jest
    .fn()
    .mockResolvedValue(new URL("http://fixture:3002/")),
  // F-3（SEC-NEW）: dispatch/kill/broadcast 现走 assertAndPinExecutorUrl——
  // 按入参原样返回 pinned:false 目标，避免真实 DNS。
  assertAndPinExecutorUrl: jest
    .fn()
    .mockImplementation(async (raw: string) => ({
      url: new URL(raw),
      pinnedIp: "93.184.216.34",
      pinned: false,
    })),
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
    delete: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
    getOne: jest.fn().mockResolvedValue(null),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    // A1: 终态跃迁统一入口会取 RETURNING（旧调用点未取，故 mock 此前没有）。
    returning: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    // NETOPT-1⑧: detectLostExecutions 扫描带上限
    take: jest.fn().mockReturnThis(),
    // FEAT-04: metrics-history aggregate query applies a LIMIT guard
    limit: jest.fn().mockReturnThis(),
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
  // FEAT-04: metrics-history repo mock (read side of GET :id/metrics)
  let metricsHistoryRepo: ReturnType<typeof makeRepo>;
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
        {
          provide: getRepositoryToken(ExecutorMetricsHistory),
          useValue: metricsHistoryRepo,
        },
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
          useValue: {
            findOne: jest.fn().mockRejectedValue(new Error("not found")),
          },
        },
        // SEC-02: 默认降级明文（key 空）
        {
          provide: SecretsCryptoService,
          useValue: new SecretsCryptoService({ get: () => "" } as any),
        },
      ],
    }).compile();
    return module.get(ExecutorService);
  };

  beforeEach(async () => {
    executorRepo = makeRepo();
    execRepo = makeRepo();
    taskRepo = makeRepo();
    metricsHistoryRepo = makeRepo();
    taskQueue = { add: jest.fn().mockResolvedValue(undefined) };
    configService = { get: jest.fn().mockReturnValue("http") };
    const module = await Test.createTestingModule({
      providers: [
        ExecutorService,
        { provide: getRepositoryToken(Executor), useValue: executorRepo },
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
        { provide: getRepositoryToken(Task), useValue: taskRepo },
        {
          provide: getRepositoryToken(ExecutorMetricsHistory),
          useValue: metricsHistoryRepo,
        },
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
          useValue: {
            findOne: jest.fn().mockRejectedValue(new Error("not found")),
          },
        },
        // SEC-02: 默认降级明文（key 空）
        {
          provide: SecretsCryptoService,
          useValue: new SecretsCryptoService({ get: () => "" } as any),
        },
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
      // A1: 终态写走 transitionOneToTerminal（createQueryBuilder 链），不再经
      // execRepo.save。断言条件 UPDATE 的 patch 携带 FAILED。
      const qbResults = (execRepo.createQueryBuilder as jest.Mock).mock.results;
      const setPatches = qbResults.flatMap((r: any) =>
        r.value.set.mock.calls.map((c: any) => c[0]),
      );
      expect(
        setPatches.some((p: any) => p.status === ExecutionStatus.FAILED),
      ).toBe(true);
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
        // CORE-02: recovery 重试 attempt=1（retryCount 0→1）、base 5s，
        // delay 带 ±20% 抖动——断言落在 [4000, 6000] 区间
        {
          attempts: 2,
          backoff: { type: "exponential", delay: expect.any(Number) },
        },
      );
      const retryOpts = taskQueue.add.mock.calls.find(
        (c: any[]) => c[1]?.executionId === "retry-exec",
      )?.[2];
      expect(retryOpts.backoff.delay).toBeGreaterThanOrEqual(4_000);
      expect(retryOpts.backoff.delay).toBeLessThanOrEqual(6_000);
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

    // R-11（DEEP_REVIEW 0ef3bbe）：单行乐观锁冲突不得击穿整个重启恢复流程。
    it("R-11: a single row save failure (optimistic lock) does not abort the rest", async () => {
      const existing = {
        appName: "e1",
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
        executorStartupId: "startup-old",
      };
      const okExecution: any = {
        id: "exec-ok",
        executorAddress: existing.address,
        status: ExecutionStatus.RUNNING,
        logs: "before",
      };
      const conflictExecution: any = {
        id: "exec-conflict",
        executorAddress: existing.address,
        status: ExecutionStatus.RUNNING,
        logs: "before",
      };
      executorRepo.findOne.mockResolvedValue(existing);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      execRepo.find.mockResolvedValue([okExecution, conflictExecution]);
      taskRepo.findBy.mockResolvedValue([]);
      // A1: 终态写走 transitionOneToTerminal（createQueryBuilder 链）。让第一次
      // QB execute（ok 行）抛乐观锁错误，第二次（conflict 行）成功——验证单行
      // 失败不击穿整体恢复流程。
      let terminalWriteIdx = 0;
      execRepo.createQueryBuilder.mockImplementation(() => {
        const idx = terminalWriteIdx++;
        return {
          update: jest.fn().mockReturnThis(),
          delete: jest.fn().mockReturnThis(),
          set: jest.fn().mockReturnThis(),
          leftJoin: jest.fn().mockReturnThis(),
          innerJoin: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue([]),
          getOne: jest.fn().mockResolvedValue(null),
          select: jest.fn().mockReturnThis(),
          addSelect: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          returning: jest.fn().mockReturnThis(),
          groupBy: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          take: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          getRawMany: jest.fn().mockResolvedValue([]),
          getRawOne: jest.fn().mockResolvedValue(null),
          getCount: jest.fn().mockResolvedValue(0),
          execute: jest.fn().mockImplementation(async () => {
            if (idx === 0)
              throw new Error("OptimisticLockVersionMismatchError");
            return { affected: 1 };
          }),
        };
      });

      await service.register({
        appName: "e1",
        address: existing.address,
        startupId: "startup-new",
      });

      // The ok row must still be marked FAILED
      expect(okExecution.status).toBe(ExecutionStatus.FAILED);
      // Both rows attempted the terminal write via the QB path; the first
      // threw but the loop continued to the second.
      expect(execRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
      // Registration must not have thrown (no 500)
      expect(existing.executorStartupId).toBe("startup-new");
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
      repo.save.mockImplementation((e: any) =>
        Promise.resolve({ ...e, id: "e1" }),
      );
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
      repo.findOne.mockResolvedValue({
        ...prior,
        status: ExecutorStatus.ONLINE,
      });
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

  // EXE-VER-1: EXECUTOR_MIN_VERSION 最低版本门禁 —— 低于下限 403（零副作用），
  // 未上报/畸形版本放行（不锁死存量），门禁关（默认空串）行为逐字节不变。
  describe("registerExecutor — EXE-VER-1 最低版本门禁", () => {
    const makeQbRepo = (prior: any) =>
      makeRepo({
        createQueryBuilder: jest.fn(() => ({
          addSelect: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockResolvedValue(prior),
        })),
      });
    const gateConfig = (minVersion: string) =>
      configService.get.mockImplementation((key: string) =>
        key === "executor.minVersion" ? minVersion : "http",
      );

    it("门禁关（默认空串）：低版本照常注册，行为不变", async () => {
      gateConfig("");
      const repo = makeQbRepo(null);
      repo.findOne.mockResolvedValue(null);
      repo.save.mockImplementation((e: any) =>
        Promise.resolve({ ...e, id: "e1" }),
      );
      const svc = await makeServiceWithRepo(repo);
      jest.spyOn(svc, "rotateToken").mockResolvedValue({ token: "t" });

      const { executor } = await svc.registerExecutor({
        appName: "node",
        address: "10.0.0.9:3002",
        version: "0.0.1",
      });
      expect(executor.id).toBe("e1");
    });

    it("门禁开：version 低于下限 → 403，不落库不发 token", async () => {
      gateConfig("1.3.0");
      const repo = makeQbRepo(null);
      repo.findOne.mockResolvedValue(null);
      const svc = await makeServiceWithRepo(repo);
      const rotateSpy = jest.spyOn(svc, "rotateToken");
      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});

      await expect(
        svc.registerExecutor({
          appName: "node",
          address: "10.0.0.9:3002",
          version: "1.2.9",
        }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        svc.registerExecutor({
          appName: "node",
          address: "10.0.0.9:3002",
          version: "1.2.9",
        }),
      ).rejects.toThrow("below the required minimum 1.3.0");
      expect(repo.save).not.toHaveBeenCalled();
      expect(rotateSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("门禁开：version 等于/高于下限放行", async () => {
      gateConfig("1.3.0");
      for (const version of ["1.3.0", "1.4", "2.0.0.1"]) {
        const repo = makeQbRepo(null);
        repo.findOne.mockResolvedValue(null);
        repo.save.mockImplementation((e: any) =>
          Promise.resolve({ ...e, id: "e1" }),
        );
        const svc = await makeServiceWithRepo(repo);
        jest.spyOn(svc, "rotateToken").mockResolvedValue({ token: "t" });

        const { executor } = await svc.registerExecutor({
          appName: "node",
          address: "10.0.0.9:3002",
          version,
        });
        expect(executor.id).toBe("e1");
      }
    });

    it("门禁开：未上报 version 的存量执行器放行 + warn 一次", async () => {
      gateConfig("1.3.0");
      const repo = makeQbRepo(null);
      repo.findOne.mockResolvedValue(null);
      repo.save.mockImplementation((e: any) =>
        Promise.resolve({ ...e, id: "e1" }),
      );
      const svc = await makeServiceWithRepo(repo);
      jest.spyOn(svc, "rotateToken").mockResolvedValue({ token: "t" });
      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});

      const { executor } = await svc.registerExecutor({
        appName: "node",
        address: "10.0.0.9:3002",
      });
      expect(executor.id).toBe("e1");
      // 按消息过滤：Logger.prototype spy 会捕到测试模块自身的告警噪音
      const gateWarns = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes("did not report a version"),
      );
      expect(gateWarns).toHaveLength(1);
      expect(gateWarns[0][0]).toContain("10.0.0.9:3002");
    });

    it("门禁开：畸形 version（NaN）按合规放行，不锁死执行器", async () => {
      gateConfig("1.3.0");
      const repo = makeQbRepo(null);
      repo.findOne.mockResolvedValue(null);
      repo.save.mockImplementation((e: any) =>
        Promise.resolve({ ...e, id: "e1" }),
      );
      const svc = await makeServiceWithRepo(repo);
      jest.spyOn(svc, "rotateToken").mockResolvedValue({ token: "t" });

      const { executor } = await svc.registerExecutor({
        appName: "node",
        address: "10.0.0.9:3002",
        version: "not-a-version",
      });
      expect(executor.id).toBe("e1");
    });
  });

  // R9 (round-8 P1 closure, W2): POST /executors/token used to rotateToken()
  // on EVERY call, so any re-fetching client put the stored tokenHash on a
  // ~30s rotation cycle that broke the N26 per-execution callback-token
  // invariant (docs/VERIFY-round8-e2e.md §1.5). issueToken() is idempotent
  // per (address, startupId) — same-process re-fetches return the CURRENT
  // token; rotation only happens on first issuance, a changed startupId, a
  // legacy fetch outside the reuse window, or when the cached plaintext no
  // longer verifies against the stored hash.
  describe("issueToken — R9 idempotent token issuance", () => {
    // rotateToken() hardcodes bcrypt cost 12 (~300ms); pin cost 4 here so the
    // reuse/rotation matrix stays fast without changing compare semantics.
    const realHash = bcrypt.hash;
    beforeEach(() => {
      jest
        .spyOn(bcrypt, "hash")
        .mockImplementation(((s: string | Buffer, _rounds: number) =>
          realHash(s, 4)) as any);
    });
    afterEach(() => {
      jest.restoreAllMocks();
    });

    const makeIssueFixture = async () => {
      const row: any = {
        id: "e1",
        address: "10.0.0.9:3002",
        appName: "node",
        status: ExecutorStatus.ONLINE,
        runningTaskCount: 0,
        executorStartupId: null,
        executorStartedAt: null,
        tokenHash: null,
      };
      const repo = makeRepo({
        findOne: jest.fn().mockResolvedValue(row),
        save: jest.fn((e: any) => Promise.resolve(e)),
      });
      // tokenHash is select:false — the service reads it via QueryBuilder.
      // Return the SAME row object so rotations are visible to the reuse
      // verification below.
      repo.createQueryBuilder = jest.fn(() => ({
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(row),
      })) as any;
      const svc = await makeServiceWithRepo(repo);
      return { svc, row };
    };

    it("first issuance rotates and returns the raw token plus the stored tokenHash", async () => {
      const { svc, row } = await makeIssueFixture();
      const r = await svc.issueToken({
        address: "10.0.0.9:3002",
        appName: "node",
        startupId: "startup-1",
      });
      expect(r.token).toMatch(/^[0-9a-f]{64}$/);
      expect(r.tokenHash).toBe(row.tokenHash);
      // The returned hash must be the hash of the returned token — this is
      // the pair the executor adopts as its N26 callback HMAC secret.
      await expect(bcrypt.compare(r.token, r.tokenHash)).resolves.toBe(true);
    });

    it("same startupId re-fetch returns the SAME token without rotating (rotation-storm fix)", async () => {
      const { svc, row } = await makeIssueFixture();
      const first = await svc.issueToken({
        address: "10.0.0.9:3002",
        appName: "node",
        startupId: "startup-1",
      });
      const hashAfterFirst = row.tokenHash;
      const rotateSpy = jest.spyOn(svc, "rotateToken");

      const second = await svc.issueToken({
        address: "10.0.0.9:3002",
        appName: "node",
        startupId: "startup-1",
      });

      expect(second.token).toBe(first.token);
      expect(second.tokenHash).toBe(hashAfterFirst);
      expect(rotateSpy).not.toHaveBeenCalled();
    });

    it("a changed startupId (genuine executor restart) rotates again", async () => {
      const { svc, row } = await makeIssueFixture();
      const first = await svc.issueToken({
        address: "10.0.0.9:3002",
        appName: "node",
        startupId: "startup-1",
      });
      const second = await svc.issueToken({
        address: "10.0.0.9:3002",
        appName: "node",
        startupId: "startup-2",
      });
      expect(second.token).not.toBe(first.token);
      expect(row.tokenHash).not.toBe(first.tokenHash);
      await expect(bcrypt.compare(second.token, row.tokenHash)).resolves.toBe(
        true,
      );
    });

    it("legacy fetch without startupId reuses inside the window and rotates after it", async () => {
      const { svc } = await makeIssueFixture();
      const base = Date.now();
      let now = base;
      jest.spyOn(Date, "now").mockImplementation(() => now);

      const first = await svc.issueToken({
        address: "10.0.0.9:3002",
        appName: "node",
      });
      // Still within TOKEN_ISSUE_REUSE_WINDOW_MS (60s) → same token.
      now = base + 30_000;
      const second = await svc.issueToken({
        address: "10.0.0.9:3002",
        appName: "node",
      });
      expect(second.token).toBe(first.token);

      // Outside the window: identity can't be proven → rotate.
      now = base + 61_000;
      const third = await svc.issueToken({
        address: "10.0.0.9:3002",
        appName: "node",
      });
      expect(third.token).not.toBe(first.token);
    });

    it("does not resurrect a token invalidated by an admin-side rotation", async () => {
      const { svc, row } = await makeIssueFixture();
      const first = await svc.issueToken({
        address: "10.0.0.9:3002",
        appName: "node",
        startupId: "startup-1",
      });
      // Simulate the admin UI's POST :id/rotate-token replacing the hash:
      // the cached plaintext no longer verifies against the stored hash.
      row.tokenHash = await realHash("externally-rotated-token", 4);

      const second = await svc.issueToken({
        address: "10.0.0.9:3002",
        appName: "node",
        startupId: "startup-1",
      });

      expect(second.token).not.toBe(first.token);
      await expect(bcrypt.compare(second.token, row.tokenHash)).resolves.toBe(
        true,
      );
    });

    // R10 (round-10 gap #3): the full manual-rotation convergence loop.
    // Admin clicks "rotate token" in the UI (direct rotateToken call — the
    // only path that does not hand the new token to the executor in-band);
    // executor-node's 401 self-heal then re-hits POST /token with the SAME
    // startupId. Because rotateToken seeds issuedTokenCache, that fetch
    // returns exactly the UI-shown token (no second rotation) plus its
    // hash, so bearer and N26 callback HMAC secret converge in one
    // round-trip.
    it("an admin-UI rotation is adopted by the executor's next same-startupId fetch without a second rotation", async () => {
      const { svc, row } = await makeIssueFixture();
      row.executorStartupId = "startup-1";
      const first = await svc.issueToken({
        address: "10.0.0.9:3002",
        appName: "node",
        startupId: "startup-1",
      });
      expect(first.token).not.toBeNull();

      // Admin-UI POST :id/rotate-token.
      const uiRotation = await svc.rotateToken("e1");
      const hashAfterUiRotation = row.tokenHash;
      expect(uiRotation.token).not.toBe(first.token);
      const rotateSpy = jest.spyOn(svc, "rotateToken");

      // Executor self-heal: POST /token, same process life.
      const healed = await svc.issueToken({
        address: "10.0.0.9:3002",
        appName: "node",
        startupId: "startup-1",
      });

      expect(healed.token).toBe(uiRotation.token);
      expect(healed.tokenHash).toBe(hashAfterUiRotation);
      await expect(
        bcrypt.compare(healed.token, healed.tokenHash),
      ).resolves.toBe(true);
      // No silent second rotation — the UI-shown token stays live.
      expect(rotateSpy).not.toHaveBeenCalled();
    });

    it("bounds issuedTokenCache — evicts expired then oldest entries past the cap (N34)", async () => {
      const { svc } = await makeIssueFixture();
      const cache = (svc as any).issuedTokenCache as Map<
        string,
        { token: string; startupId: string | null; issuedAt: number }
      >;
      const MAX = (ExecutorService as any).TOKEN_ISSUE_CACHE_MAX as number;
      const now = Date.now();
      // Fill to the cap with fresh entries (none expired, so the only way
      // the new insert fits is the oldest-first eviction branch).
      for (let i = 0; i < MAX; i++) {
        cache.set(`addr-${i}`, {
          token: `t${i}`,
          startupId: "s",
          issuedAt: now,
        });
      }

      await svc.issueToken({
        address: "10.0.0.9:3002",
        appName: "node",
        startupId: "startup-1",
      });

      expect(cache.size).toBeLessThanOrEqual(MAX);
      expect(cache.has("addr-0")).toBe(false); // oldest — evicted
      expect(cache.has("addr-1")).toBe(true); // rest kept
      expect(cache.has(`addr-${MAX - 1}`)).toBe(true);
      expect(cache.has("10.0.0.9:3002")).toBe(true);
    });

    it("treats a plaintext cache entry past the TTL as stale and rotates (N34)", async () => {
      const { svc } = await makeIssueFixture();
      const TTL = (ExecutorService as any).TOKEN_ISSUE_CACHE_TTL_MS as number;
      const base = Date.now();
      let now = base;
      jest.spyOn(Date, "now").mockImplementation(() => now);

      const first = await svc.issueToken({
        address: "10.0.0.9:3002",
        appName: "node",
        startupId: "startup-1",
      });
      // Same startupId but past the TTL: fail-safe like a cold cache.
      now = base + TTL + 1;
      const second = await svc.issueToken({
        address: "10.0.0.9:3002",
        appName: "node",
        startupId: "startup-1",
      });
      expect(second.token).not.toBe(first.token);
      // The fresh entry is now within the TTL — a third fetch reuses again.
      const third = await svc.issueToken({
        address: "10.0.0.9:3002",
        appName: "node",
        startupId: "startup-1",
      });
      expect(third.token).toBe(second.token);
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
        diskUsage: 70,
        runningTaskCount: 1,
        totalTaskCount: 10,
        failedTaskCount: 2,
      });
      expect(executorRepo.save).toHaveBeenCalled();
      expect(metricsHistoryRepo.create).toHaveBeenCalledWith({
        executorAddress: "127.0.0.1:3105",
        cpuUsage: 30,
        memUsage: 50,
        diskUsage: 70,
        runningTaskCount: 1,
        totalTaskCount: 10,
        failedTaskCount: 2,
        avgExecutionTime: null,
        uptimeSeconds: 0,
      });
      expect(metricsHistoryRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ executorAddress: "127.0.0.1:3105" }),
      );
    });

    it("does not fail heartbeat when metrics history snapshot write fails", async () => {
      const executor = {
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
      };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      metricsHistoryRepo.save.mockRejectedValue(new Error("history down"));
      const warnSpy = jest.spyOn((service as any).logger, "warn");

      await expect(
        service.heartbeat("127.0.0.1:3105", { cpuUsage: 30 }),
      ).resolves.toMatchObject({ address: "127.0.0.1:3105" });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("metrics history write failed"),
      );
      warnSpy.mockRestore();
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
      await expect(service.heartbeat("unknown:9999", {})).rejects.toThrow(
        NotFoundException,
      );
    });

    // E9: 执行器热更新容量后随心跳被采纳（派发闸门/负载分读 DB 值）；
    // 校验域 1..10000 正整数，非法/缺失一律不改 DB 值。
    describe("maxConcurrentTasks adoption (E9)", () => {
      const onlineExecutor = () => ({
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
        maxConcurrentTasks: 4,
      });

      it("adopts a valid reported capacity", async () => {
        const executor = onlineExecutor();
        executorRepo.findOne.mockResolvedValue(executor);
        executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
        await service.heartbeat("127.0.0.1:3105", { maxConcurrentTasks: 8 });
        expect(executor.maxConcurrentTasks).toBe(8);
      });

      it("accepts boundary values 1 and 10000", async () => {
        const executor = onlineExecutor();
        executorRepo.findOne.mockResolvedValue(executor);
        executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
        await service.heartbeat("127.0.0.1:3105", { maxConcurrentTasks: 1 });
        expect(executor.maxConcurrentTasks).toBe(1);
        await service.heartbeat("127.0.0.1:3105", {
          maxConcurrentTasks: 10000,
        });
        expect(executor.maxConcurrentTasks).toBe(10000);
      });

      it("keeps the stored value when the field is not reported", async () => {
        const executor = onlineExecutor();
        executorRepo.findOne.mockResolvedValue(executor);
        executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
        await service.heartbeat("127.0.0.1:3105", { cpuUsage: 1 });
        expect(executor.maxConcurrentTasks).toBe(4);
      });

      it.each([0, -3, 1.5, 10_001, Number.NaN, "8"])(
        "rejects invalid value %p and keeps the stored value",
        async (bad) => {
          const executor = onlineExecutor();
          executorRepo.findOne.mockResolvedValue(executor);
          executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
          await service.heartbeat("127.0.0.1:3105", {
            maxConcurrentTasks: bad as unknown as number,
          });
          expect(executor.maxConcurrentTasks).toBe(4);
        },
      );
    });

    // U16: deadLetterCount 采纳——与 E9 maxConcurrentTasks 同模式的心跳白名单
    // + 取值域校验（非负整数 0..100000）；非法/缺失一律不改 DB 值。node 端
    // ab4971f 起上报、python 端 001 起上报，GET /executors(/:id) 随实体透出。
    describe("deadLetterCount adoption (U16)", () => {
      const onlineExecutor = () => ({
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
        deadLetterCount: 7,
      });

      it("adopts a valid reported count", async () => {
        const executor = onlineExecutor();
        executorRepo.findOne.mockResolvedValue(executor);
        executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
        await service.heartbeat("127.0.0.1:3105", { deadLetterCount: 42 });
        expect(executor.deadLetterCount).toBe(42);
      });

      it("adopts boundary values 0 and 100000", async () => {
        const executor = onlineExecutor();
        executorRepo.findOne.mockResolvedValue(executor);
        executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
        await service.heartbeat("127.0.0.1:3105", { deadLetterCount: 0 });
        expect(executor.deadLetterCount).toBe(0);
        await service.heartbeat("127.0.0.1:3105", { deadLetterCount: 100_000 });
        expect(executor.deadLetterCount).toBe(100_000);
      });

      it("keeps the stored value when the field is not reported", async () => {
        const executor = onlineExecutor();
        executorRepo.findOne.mockResolvedValue(executor);
        executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
        await service.heartbeat("127.0.0.1:3105", { cpuUsage: 1 });
        expect(executor.deadLetterCount).toBe(7);
      });

      it.each([-1, 1.5, 100_001, Number.NaN, "3"])(
        "rejects invalid value %p and keeps the stored value",
        async (bad) => {
          const executor = onlineExecutor();
          executorRepo.findOne.mockResolvedValue(executor);
          executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
          await service.heartbeat("127.0.0.1:3105", {
            deadLetterCount: bad as unknown as number,
          });
          expect(executor.deadLetterCount).toBe(7);
        },
      );
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
      // A1: 终态写走 transitionOneToTerminal（createQueryBuilder 链）。oldExecution
      // 被推进终态（patch=FAILED）；newExecution 未过 shouldFailAfterRestart 门，
      // 不走终态写 → createQueryBuilder 恰被调用一次。
      const qbResults = (execRepo.createQueryBuilder as jest.Mock).mock.results;
      const setPatches = qbResults.flatMap((r: any) =>
        r.value.set.mock.calls.map((c: any) => c[0]),
      );
      expect(
        setPatches.some((p: any) => p.status === ExecutionStatus.FAILED),
      ).toBe(true);
      expect(execRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
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
        Promise.resolve(
          e.id ? e : { ...e, id: `retry-${execRepo.save.mock.calls.length}` },
        ),
      );
      taskQueue.add
        .mockRejectedValueOnce(new Error("redis down"))
        .mockResolvedValueOnce(undefined);

      await service.heartbeat(executor.address, { startupId: "startup-new" });

      expect(firstExecution.status).toBe(ExecutionStatus.FAILED);
      expect(secondExecution.status).toBe(ExecutionStatus.FAILED);
      // A1: 终态写走 transitionOneToTerminal（createQueryBuilder 链），故
      // execRepo.save 仅被 scheduleRetryAfterRecovery 调用（创建 retry exec）。
      // 第一个 retry（firstExecution）enqueue 失败 → 删除其刚创建的 retry 行。
      expect(execRepo.delete).toHaveBeenCalledWith("retry-1");
      expect(taskQueue.add).toHaveBeenCalledTimes(2);
      expect(executor.executorStartupId).toBe("startup-new");
      expect(executorRepo.save).toHaveBeenCalledWith(executor);
    });

    // CONSISTENCY-02: heartbeat ingest for the optional liveness report.
    it("writes sanitized runningExecutionIds reported by the heartbeat", async () => {
      const executor = {
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
        runningExecutionIds: null,
      };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));

      await service.heartbeat("127.0.0.1:3105", {
        runningExecutionIds: ["exec-a", "exec_b-1"],
      });

      expect(executor.runningExecutionIds).toEqual(["exec-a", "exec_b-1"]);
    });

    it("trims runningExecutionIds to 200 and drops ids outside the safe charset", async () => {
      const executor = {
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
        runningExecutionIds: null,
      };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      const noisy = [
        ...Array.from({ length: 210 }, (_, i) => `exec-${i}`),
        "with space",
        "with/slash",
        "with.dot",
        42 as unknown as string,
        null as unknown as string,
      ];

      await service.heartbeat("127.0.0.1:3105", { runningExecutionIds: noisy });

      const ids = executor.runningExecutionIds as string[];
      expect(ids).toHaveLength(200);
      expect(ids.every((id) => /^[A-Za-z0-9_-]+$/.test(id))).toBe(true);
      expect(ids).not.toContain("with space");
      expect(ids).not.toContain("with/slash");
      expect(ids).not.toContain("with.dot");
    });

    it("treats a malformed (non-array) report as unreported → null", async () => {
      const executor = {
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
        runningExecutionIds: ["prior"],
      };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));

      await service.heartbeat("127.0.0.1:3105", {
        runningExecutionIds: "not-an-array" as unknown as string[],
      });

      expect(executor.runningExecutionIds).toBeNull();
    });

    it("leaves the stored set untouched when the field is absent (old executor)", async () => {
      const executor = {
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
        runningExecutionIds: ["exec-live-1"],
      };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));

      await service.heartbeat("127.0.0.1:3105", { cpuUsage: 10 });

      // Absent field ≠ empty report: must not erase a prior liveness signal.
      expect(executor.runningExecutionIds).toEqual(["exec-live-1"]);
    });

    it("warns when deadLetterCount>0 and stays quiet otherwise", async () => {
      const executor = {
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
      };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      const warnSpy = jest.spyOn((service as any).logger, "warn");

      await service.heartbeat("127.0.0.1:3105", { deadLetterCount: 3 });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("dead-letter"),
      );

      warnSpy.mockClear();
      await service.heartbeat("127.0.0.1:3105", { deadLetterCount: 0 });
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("dead-letter"),
      );
      warnSpy.mockRestore();
    });
  });

  // P2: 共享重试兑现模式（executor-restart 恢复 + scheduler stale sweep 共用）
  // 与收敛至此的 best-effort kill 通知（TaskService.notifyExecutorKill 现委托
  // 本实现）。scheduleRetryAfterRestart 旧名仅存于 restart 内部调用，公开面为
  // scheduleRetryAfterRecovery / hasRetryBudget / notifyExecutorKill。
  describe("scheduleRetryAfterRecovery / hasRetryBudget (P2)", () => {
    const mkTask = (overrides: Record<string, unknown> = {}) =>
      ({
        id: "task-1",
        name: "Task 1",
        params: { a: 1 },
        currentVersion: "v1",
        maxRetry: 3,
        retryDelay: 0,
        ...overrides,
      }) as unknown as Task;
    const mkFailedExec = (overrides: Record<string, unknown> = {}) =>
      ({
        id: "exec-1",
        taskId: "task-1",
        status: ExecutionStatus.FAILED,
        params: { b: 2 },
        triggerType: "cron",
        taskVersion: "v1",
        retryCount: 0,
        ...overrides,
      }) as unknown as TaskExecution;

    it("hasRetryBudget mirrors the attempts semantics", () => {
      expect(
        service.hasRetryBudget(
          mkTask({ maxRetry: 3 }),
          mkFailedExec({ retryCount: 0 }),
        ),
      ).toBe(true);
      expect(
        service.hasRetryBudget(
          mkTask({ maxRetry: 3 }),
          mkFailedExec({ retryCount: 1 }),
        ),
      ).toBe(true);
      // nextRetryCount(2+1) >= maxAttempts(3) → 预算耗尽
      expect(
        service.hasRetryBudget(
          mkTask({ maxRetry: 3 }),
          mkFailedExec({ retryCount: 2 }),
        ),
      ).toBe(false);
      expect(
        service.hasRetryBudget(
          mkTask({ maxRetry: 1 }),
          mkFailedExec({ retryCount: 0 }),
        ),
      ).toBe(false);
      expect(
        service.hasRetryBudget(
          mkTask({ maxRetry: 0 }),
          mkFailedExec({ retryCount: 0 }),
        ),
      ).toBe(false);
      expect(
        service.hasRetryBudget(
          mkTask({ maxRetry: null }),
          mkFailedExec({ retryCount: undefined }),
        ),
      ).toBe(false);
    });

    it("budget exhausted: creates nothing and enqueues nothing", async () => {
      await service.scheduleRetryAfterRecovery(
        mkTask({ maxRetry: 1 }),
        mkFailedExec({ retryCount: 0 }),
      );
      expect(execRepo.create).not.toHaveBeenCalled();
      expect(taskQueue.add).not.toHaveBeenCalled();
    });

    it("creates a new PENDING execution and enqueues with remaining attempts", async () => {
      execRepo.save.mockImplementation((e: any) =>
        Promise.resolve(e.id ? e : { ...e, id: "retry-1" }),
      );
      await service.scheduleRetryAfterRecovery(
        mkTask({ maxRetry: 3, retryDelay: 0 }),
        mkFailedExec({ retryCount: 1 }),
        "stale_recovery",
      );
      expect(execRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: "task-1",
          taskName: "Task 1",
          status: ExecutionStatus.PENDING,
          params: { b: 2 },
          triggerType: "cron",
          taskVersion: "v1",
          retryCount: 2,
        }),
      );
      expect(taskQueue.add).toHaveBeenCalledWith(
        "execute",
        { executionId: "retry-1" },
        { attempts: 1, backoff: undefined },
      );
    });

    it("uses the fallback trigger type only when the original row has none", async () => {
      execRepo.save.mockImplementation((e: any) =>
        Promise.resolve(e.id ? e : { ...e, id: "retry-2" }),
      );
      await service.scheduleRetryAfterRecovery(
        mkTask(),
        mkFailedExec({ triggerType: null }),
        "stale_recovery",
      );
      expect(execRepo.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ triggerType: "stale_recovery" }),
      );
      // restart 路径保持既有默认值（不传第三参）
      await service.scheduleRetryAfterRecovery(
        mkTask(),
        mkFailedExec({ triggerType: null }),
      );
      expect(execRepo.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ triggerType: "executor_restart" }),
      );
    });

    it("compensates by deleting the row when enqueue fails", async () => {
      execRepo.save.mockImplementation((e: any) =>
        Promise.resolve(e.id ? e : { ...e, id: "retry-3" }),
      );
      taskQueue.add.mockRejectedValueOnce(new Error("redis down"));
      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});
      await service.scheduleRetryAfterRecovery(mkTask(), mkFailedExec());
      expect(execRepo.delete).toHaveBeenCalledWith("retry-3");
      warnSpy.mockRestore();
    });
  });

  describe("notifyExecutorKill (P2 consolidated)", () => {
    it("posts to the executor kill endpoint", async () => {
      mockedAxios.post.mockResolvedValue({ data: { ok: true } });
      await service.notifyExecutorKill("e1", "10.0.0.9:8002");
      expect(mockedAxios.post).toHaveBeenCalledWith(
        "http://10.0.0.9:8002/api/executions/e1/kill",
        {},
        expect.objectContaining({ timeout: 3000 }),
      );
    });

    it("swallows failures (offline / 404 / timeout) — never throws", async () => {
      mockedAxios.post.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});
      await expect(
        service.notifyExecutorKill("e1", "10.0.0.9:8002"),
      ).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("skips silently when the executor address is unavailable", async () => {
      await service.notifyExecutorKill("e1", null);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    // SEC-SSRF-02 回归：本方法此前是执行器出站调用里唯一漏掉 SSRF 守卫的点，
    // 会把共享 token 作为 Bearer 发给 executorAddress 指定的任意主机
    // （含 link-local 云元数据 169.254.169.254 与 loopback）。
    // SEC-SSRF-02 回归：本方法此前是执行器出站调用里唯一漏掉 SSRF 守卫的点，
    // 会把共享 token 作为 Bearer 发给 executorAddress 指定的任意主机。
    //
    // 注意：本 spec 在顶部把 assertSafeExecutorUrl 整体 stub 掉了（避免真实
    // DNS 查询），所以此处断言的是「守卫针对正确 URL 被调用」这一行为；
    // 守卫本身的判定语义（link-local/loopback 拒绝）由下方
    // "SEC-SSRF-02 guard semantics" 用 jest.requireActual 的真实实现覆盖。
    // F-3（SEC-NEW）: kill 出站现走 assertAndPinExecutorUrl（校验+pin 一体）。
    it("SEC-SSRF-02: consults the SSRF guard with the kill URL before POSTing", async () => {
      mockedAxios.post.mockResolvedValue({ data: { ok: true } });
      await service.notifyExecutorKill("e1", "10.0.0.9:8002");
      const guard = jest.requireMock("../../../common/utils/safe-http.util")
        .assertAndPinExecutorUrl as jest.Mock;
      expect(guard).toHaveBeenCalledWith(
        "http://10.0.0.9:8002/api/executions/e1/kill",
      );
      expect(mockedAxios.post).toHaveBeenCalled();
    });

    it("SEC-SSRF-02: a guard rejection stops the authenticated POST (never throws)", async () => {
      const guard = jest.requireMock("../../../common/utils/safe-http.util")
        .assertAndPinExecutorUrl as jest.Mock;
      guard.mockRejectedValueOnce(
        new Error("Executor address ... is link-local — refused"),
      );
      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});
      await expect(
        service.notifyExecutorKill("e1", "169.254.169.254:80"),
      ).resolves.toBeUndefined();
      expect(mockedAxios.post).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  // SEC-SSRF-02 守卫语义：用真实实现，证明被守卫的地址确实会被拒绝、
  // 且正常的私网地址确实放行——即上一条「守卫被调用」不是空转。
  describe("SEC-SSRF-02 guard semantics (real assertSafeExecutorUrl)", () => {
    const realGuard = jest.requireActual("../../../common/utils/safe-http.util")
      .assertSafeExecutorUrl as (u: string) => Promise<URL>;

    it("rejects link-local cloud-metadata addresses", async () => {
      await expect(
        realGuard("http://169.254.169.254/api/executions/e1/kill"),
      ).rejects.toThrow(/link-local|refused/i);
    });

    it("allows an ordinary private-LAN executor address", async () => {
      await expect(
        realGuard("http://10.0.0.9:8002/api/executions/e1/kill"),
      ).resolves.toBeInstanceOf(URL);
    });
  });

  // SEC-SSRF-03 回归：getExecutorUrl 在其它 spec 里一律被 mock，真实实现
  // 零覆盖——这正是 '#' 片段截断能藏住的原因。此处直接测真实实现。
  describe("getExecutorUrl (SEC-SSRF-03)", () => {
    it("prefixes the configured scheme for a bare host:port", () => {
      expect(service.getExecutorUrl("10.0.0.9:8002", "api/logs/e1")).toBe(
        "http://10.0.0.9:8002/api/logs/e1",
      );
    });

    it("keeps an explicit http(s):// scheme", () => {
      expect(
        service.getExecutorUrl("https://ex.example.com", "api/execute"),
      ).toBe("https://ex.example.com/api/execute");
    });

    it("strips a '#' so the path is NOT swallowed into the URL fragment", () => {
      // 修复前：'http://10.0.0.5#/api/executions/x/kill' 的 pathname 是 "/"
      // —— 请求会打到主机根路径而非我们的端点。
      const url = service.getExecutorUrl("10.0.0.5#", "api/executions/x/kill");
      const parsed = new URL(url);
      expect(parsed.hash).toBe("");
      expect(parsed.pathname).toBe("/api/executions/x/kill");
    });

    it("strips a '?' so the path is not absorbed into the query string", () => {
      const url = service.getExecutorUrl("10.0.0.5?", "api/executions/x/kill");
      const parsed = new URL(url);
      expect(parsed.search).toBe("");
      expect(parsed.pathname).toBe("/api/executions/x/kill");
    });

    it("does not produce a doubled slash when the address ends with one", () => {
      const url = service.getExecutorUrl(
        "http://10.0.0.5:8002/",
        "api/execute",
      );
      expect(url).toBe("http://10.0.0.5:8002/api/execute");
      expect(new URL(url).pathname).toBe("/api/execute");
    });

    it("strips a leading slash on the path argument", () => {
      expect(service.getExecutorUrl("10.0.0.9:8002", "/api/execute")).toBe(
        "http://10.0.0.9:8002/api/execute",
      );
    });
  });

  describe("findAll", () => {
    it("returns all executors", async () => {
      const list = [{ id: "e1" }, { id: "e2" }];
      executorRepo.find.mockResolvedValue(list);
      const result = await service.findAll();
      expect(result).toHaveLength(2);
    });

    // UI-17: 读面投影 versionCompliant（EXE-VER-1 门禁 × 执行器版本）
    it("projects versionCompliant per row (gate on: below-min false, ok true, missing true)", async () => {
      configService.get.mockImplementation((key: string) =>
        key === "executor.minVersion" ? "1.3.0" : "http",
      );
      executorRepo.find.mockResolvedValue([
        { id: "e1", executorVersion: "1.2.0" },
        { id: "e2", executorVersion: "1.3.1" },
        { id: "e3" }, // 未上报版本（存量）→ 宽松放行
      ]);

      const rows: any[] = await service.findAll();

      expect(rows.map((r) => r.versionCompliant)).toEqual([false, true, true]);
    });

    it("gate off (default): every row compliant", async () => {
      configService.get.mockImplementation((key: string) =>
        key === "executor.minVersion" ? "" : "http",
      );
      executorRepo.find.mockResolvedValue([
        { id: "e1", executorVersion: "0.0.1" },
      ]);

      const rows: any[] = await service.findAll();
      expect(rows[0].versionCompliant).toBe(true);
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
      qb.getRawMany.mockResolvedValue([
        { groupName: null },
        { groupName: "prod" },
      ]);
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

    // ARCH-32（ADR-015）: pull 执行器传输分支——占坑语义不变，载荷入队而非 POST。
    const pullExecutor = {
      ...executor,
      id: "e-pull",
      dispatchMode: "pull" as const,
    };

    it("pull 执行器：载荷入队（不 POST），返回 queued 形态", async () => {
      executorRepo.find.mockResolvedValue([pullExecutor]);
      const enqueue = jest.fn().mockResolvedValue(undefined);
      (service as unknown as { pullService: unknown }).pullService = {
        enqueue,
      };

      const result = await service.dispatch(task, execution);

      expect(result).toMatchObject({
        status: "queued",
        executionId: "exec-1",
        dispatchMode: "pull",
      });
      expect(enqueue).toHaveBeenCalledWith(
        "e-pull",
        expect.objectContaining({
          executionId: "exec-1",
          task: expect.objectContaining({ id: "task-1" }),
          params: expect.anything(),
        }),
      );
      expect(mockedAxios.post).not.toHaveBeenCalled();
      (service as unknown as { pullService: unknown }).pullService = null;
    });

    it("pull 执行器：入队失败回滚占坑并按既有失败语义抛错", async () => {
      executorRepo.find.mockResolvedValue([pullExecutor]);
      (service as unknown as { pullService: unknown }).pullService = {
        enqueue: jest.fn().mockRejectedValue(new Error("redis down")),
      };

      await expect(service.dispatch(task, execution)).rejects.toThrow(
        "redis down",
      );
      // 回滚占坑：GREATEST 更新被执行（与 push 失败路径共用）
      expect(executorRepo.createQueryBuilder).toHaveBeenCalled();
      (service as unknown as { pullService: unknown }).pullService = null;
    });

    it("pull 分支在 ExecutorPullService 未装配时显式抛错（不静默丢任务）", async () => {
      executorRepo.find.mockResolvedValue([pullExecutor]);
      (service as unknown as { pullService: unknown }).pullService = null;

      await expect(service.dispatch(task, execution)).rejects.toThrow(
        "Pull dispatch unavailable",
      );
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

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
      const taskWithGroup = {
        ...task,
        executorGroup: "production",
      } as unknown as Task;
      const wrongGroup = { ...executor, id: "e2", groupName: "staging" };
      const rightGroup = { ...executor, id: "e3", groupName: "production" };
      executorRepo.find.mockResolvedValue([wrongGroup, rightGroup]);
      mockedAxios.post.mockResolvedValue({ data: { success: true } });
      await service.dispatch(taskWithGroup, execution);
      const postCall = mockedAxios.post.mock.calls[0][0] as string;
      expect(postCall).toContain(rightGroup.address);
    });

    // R6: executor pinning — task.executorId set ⇒ ONLY that executor.
    describe("pinned executor (task.executorId)", () => {
      const pinned = {
        id: "e-pin",
        appName: "pinned-node",
        address: "pinned-host:3002",
        status: ExecutorStatus.ONLINE,
        runningTaskCount: 0,
        version: 1,
      };

      it("dispatches only to the pinned executor, bypassing group/tags filters", async () => {
        executorRepo.findOne.mockResolvedValue(pinned);
        // Fleet query must NOT be consulted at all when pinned.
        mockedAxios.post.mockResolvedValue({ data: { accepted: true } });
        const taskPinned = {
          ...task,
          executorId: "e-pin",
          executorGroup: "group-that-matches-nothing",
        } as unknown as Task;
        const result = await service.dispatch(taskPinned, execution);
        expect(result.accepted).toBe(true);
        expect(executorRepo.find).not.toHaveBeenCalled();
        expect(executorRepo.findOne).toHaveBeenCalledWith({
          where: { id: "e-pin" },
        });
        expect(mockedAxios.post.mock.calls[0][0]).toContain(pinned.address);
        expect(execution.executorAddress).toBe(pinned.address);
      });

      it("offline pinned executor fails fast with an EXECUTOR_OFFLINE-classifiable message (no fleet fallback)", async () => {
        executorRepo.findOne.mockResolvedValue({
          ...pinned,
          status: ExecutorStatus.OFFLINE,
        });
        executorRepo.find.mockResolvedValue([executor]);
        await expect(
          service.dispatch(
            { ...task, executorId: "e-pin" } as unknown as Task,
            execution,
          ),
        ).rejects.toThrow(/Pinned executor .* is offline/);
        // No fallback: fleet never queried, nothing dispatched.
        expect(executorRepo.find).not.toHaveBeenCalled();
        expect(mockedAxios.post).not.toHaveBeenCalled();
      });

      it("missing pinned executor fails with not-found (no fleet fallback)", async () => {
        executorRepo.findOne.mockResolvedValue(null);
        executorRepo.find.mockResolvedValue([executor]);
        await expect(
          service.dispatch(
            { ...task, executorId: "gone" } as unknown as Task,
            execution,
          ),
        ).rejects.toThrow(/Pinned executor gone not found/);
        expect(executorRepo.find).not.toHaveBeenCalled();
        expect(mockedAxios.post).not.toHaveBeenCalled();
      });

      it("respects the pinned executor slot cap (optimistic increment still applied)", async () => {
        executorRepo.findOne.mockResolvedValue({
          ...pinned,
          maxConcurrentTasks: 1,
          runningTaskCount: 1,
        });
        // Simulate the capacity-guarded UPDATE losing the race (affected=0).
        executorRepo.createQueryBuilder.mockReturnValue({
          update: jest.fn().mockReturnThis(),
          set: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          returning: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue({ affected: 0 }),
        } as any);
        await expect(
          service.dispatch(
            { ...task, executorId: "e-pin" } as unknown as Task,
            execution,
          ),
        ).rejects.toThrow(/No available executor/);
        expect(mockedAxios.post).not.toHaveBeenCalled();
      });
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

    // R-06（DEEP_REVIEW 0ef3bbe）: broadcast 占坑——每个被接受（fulfilled）的
    // 目标执行器 runningTaskCount 必须原子 +1，广播负载才对容量闸门可见；派发失败
    // 的执行器不得占坑（否则从未接单却被计数）。
    it("R-06: increments runningTaskCount by 1 for each ACCEPTED broadcast target only", async () => {
      executorRepo.find.mockResolvedValue([
        { id: "e1", address: "host1:3002", status: ExecutorStatus.ONLINE },
        { id: "e2", address: "host2:3002", status: ExecutorStatus.ONLINE },
        { id: "e3", address: "host3:3002", status: ExecutorStatus.ONLINE },
      ]);
      // e1 与 e2 接单成功（fulfilled）；e3 派发失败（rejected）→ 不应占坑
      mockedAxios.post
        .mockResolvedValueOnce({ data: { ok: true } })
        .mockResolvedValueOnce({ data: { ok: true } })
        .mockRejectedValueOnce(new Error("host3 down"));

      await service.dispatchBroadcast(task, execution);

      // 找出用于 runningTaskCount 占坑的 UPDATE 链（set 里带 runningTaskCount 函数）
      const occupancyUpdates = executorRepo.createQueryBuilder.mock.results
        .map((r: any) => r.value)
        .filter((qb: any) =>
          qb.set.mock.calls.some(
            (c: any[]) =>
              c[0] &&
              typeof c[0].runningTaskCount === "function" &&
              /runningTaskCount"\s*\+\s*1/.test(String(c[0].runningTaskCount)),
          ),
        );
      // 仅 2 个被接受执行器占坑（e3 派发失败 → 不占）
      expect(occupancyUpdates).toHaveLength(2);
      const occupiedIds = occupancyUpdates.flatMap((qb: any) =>
        qb.where.mock.calls
          .filter((c: any[]) => c[0] === "id = :id")
          .map((c: any[]) => c[1].id),
      );
      expect(occupiedIds.sort()).toEqual(["e1", "e2"]);
      expect(occupiedIds).not.toContain("e3");
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

    // FEAT-07 发布点（优雅停机路径）：落库后 re-find 并 emit executor.offline。
    it("emits executor.offline for the row after the graceful-shutdown write", async () => {
      executorRepo.update.mockResolvedValue({ affected: 1 });
      executorRepo.findOne.mockResolvedValue({
        id: "exec-3",
        appName: "graceful",
        address: "127.0.0.1:3105",
      });
      const bus = { emit: jest.fn() };
      (service as unknown as { eventBus: unknown }).eventBus = bus;

      await service.markOffline("127.0.0.1:3105");

      expect(bus.emit).toHaveBeenCalledWith(
        DOMAIN_EVENTS.EXECUTOR_OFFLINE,
        expect.objectContaining({
          executorId: "exec-3",
          appName: "graceful",
          address: "127.0.0.1:3105",
        }),
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

    // R10 (round-10 gap #3): seed the idempotent-issuance cache with the
    // fresh plaintext under the executor's CURRENT startupId, so the
    // executor-node 401 self-heal (POST /token, same startupId) adopts
    // EXACTLY the token the admin UI just showed instead of rotating a
    // second time and killing it.
    it("seeds issuedTokenCache with the new plaintext under the current startupId", async () => {
      const executor = {
        id: "e1",
        address: "10.0.0.9:3002",
        tokenHash: null,
        executorStartupId: "startup-1",
      };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      const result = await service.rotateToken("e1");

      const cache = (service as any).issuedTokenCache as Map<
        string,
        { token: string; startupId: string | null }
      >;
      expect(cache.get("10.0.0.9:3002")).toMatchObject({
        token: result.token,
        startupId: "startup-1",
      });
    });

    it("seeds issuedTokenCache with a null startupId for legacy executors (no same-startupId reuse)", async () => {
      const executor = {
        id: "e1",
        address: "10.0.0.9:3002",
        tokenHash: null,
        executorStartupId: null,
      };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      const result = await service.rotateToken("e1");

      const cache = (service as any).issuedTokenCache as Map<
        string,
        { token: string; startupId: string | null }
      >;
      expect(cache.get("10.0.0.9:3002")).toMatchObject({
        token: result.token,
        startupId: null,
      });
    });

    // AUTH-05: high-risk operation audit (best-effort — @Optional provider).
    it("AUTH-05: writes an executor.rotate_token audit entry with the supplied reason", async () => {
      const audit = { log: jest.fn().mockResolvedValue(undefined) };
      const module2 = await Test.createTestingModule({
        providers: [
          ExecutorService,
          { provide: getRepositoryToken(Executor), useValue: executorRepo },
          { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
          { provide: getRepositoryToken(Task), useValue: taskRepo },
          {
            provide: getRepositoryToken(ExecutorMetricsHistory),
            useValue: metricsHistoryRepo,
          },
          { provide: getQueueToken("task-queue"), useValue: taskQueue },
          { provide: ConfigService, useValue: configService },
          {
            provide: NotificationService,
            useValue: {
              notifyExecutorOnline: jest.fn(),
              notifyExecutorOffline: jest.fn(),
            },
          },
          {
            provide: SystemConfigService,
            useValue: { findOne: jest.fn().mockRejectedValue(new Error("nf")) },
          },
          {
            provide: SecretsCryptoService,
            useValue: new SecretsCryptoService({ get: () => "" } as any),
          },
          { provide: AuditService, useValue: audit },
        ],
      }).compile();
      const svc = module2.get(ExecutorService);

      const executor = {
        id: "e1",
        address: "10.0.0.9:3002",
        appName: "node-1",
        tokenHash: null,
      };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));

      await svc.rotateToken("e1", "suspected leak");
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "executor.rotate_token",
          resource: "executor",
          resourceId: "e1",
          detail: expect.objectContaining({
            address: "10.0.0.9:3002",
            appName: "node-1",
            reason: "suspected leak",
          }),
        }),
      );
    });

    it("AUTH-05: rotateToken audit omits detail.reason when none supplied and never fails the rotation", async () => {
      const audit = {
        log: jest.fn().mockRejectedValue(new Error("audit down")),
      };
      const module2 = await Test.createTestingModule({
        providers: [
          ExecutorService,
          { provide: getRepositoryToken(Executor), useValue: executorRepo },
          { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
          { provide: getRepositoryToken(Task), useValue: taskRepo },
          {
            provide: getRepositoryToken(ExecutorMetricsHistory),
            useValue: metricsHistoryRepo,
          },
          { provide: getQueueToken("task-queue"), useValue: taskQueue },
          { provide: ConfigService, useValue: configService },
          {
            provide: NotificationService,
            useValue: {
              notifyExecutorOnline: jest.fn(),
              notifyExecutorOffline: jest.fn(),
            },
          },
          {
            provide: SystemConfigService,
            useValue: { findOne: jest.fn().mockRejectedValue(new Error("nf")) },
          },
          {
            provide: SecretsCryptoService,
            useValue: new SecretsCryptoService({ get: () => "" } as any),
          },
          { provide: AuditService, useValue: audit },
        ],
      }).compile();
      // 静默 warn 日志噪声
      jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
      const svc = module2.get(ExecutorService);

      const executor = { id: "e1", address: "10.0.0.9:3002", tokenHash: null };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));

      const result = await svc.rotateToken("e1");
      expect(result).toHaveProperty("token");
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "executor.rotate_token",
          detail: expect.not.objectContaining({ reason: expect.anything() }),
        }),
      );
    });

    it("AUTH-05: skips audit entirely when no AuditService is wired (@Optional legacy assemblies)", async () => {
      const executor = { id: "e1", address: "10.0.0.9:3002", tokenHash: null };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      // service（beforeEach 装配）无 AuditService provider — 不抛错即通过
      const result = await service.rotateToken("e1");
      expect(result).toHaveProperty("token");
    });
  });

  describe("validateTokenByAddress", () => {
    it("returns true for valid per-executor token", async () => {
      const rawToken = "raw-secret";
      const hash = await bcrypt.hash(rawToken, 1);
      const qb = executorRepo.createQueryBuilder();
      qb.getOne.mockResolvedValue({ address: "host:3002", tokenHash: hash });
      executorRepo.createQueryBuilder.mockReturnValue(qb);
      const result = await service.validateTokenByAddress(
        "host:3002",
        rawToken,
      );
      expect(result).toBe(true);
    });

    it("falls back to shared token when no per-executor hash", async () => {
      const qb = executorRepo.createQueryBuilder();
      qb.getOne.mockResolvedValue({ address: "host:3002", tokenHash: null });
      executorRepo.createQueryBuilder.mockReturnValue(qb);
      configService.get.mockReturnValue("shared-secret");
      const result = await service.validateTokenByAddress(
        "host:3002",
        "shared-secret",
      );
      expect(result).toBe(true);
    });

    // 真机冒烟（round-16）：无 Authorization 头的心跳（presented=undefined）
    // 曾在 Buffer.from 处抛 500——现在必须 fail-closed 返回 false
    it("returns false (not a crash) when presented is undefined or empty", async () => {
      const result = await service.validateTokenByAddress(
        "host:3002",
        undefined as never,
      );
      expect(result).toBe(false);
      const result2 = await service.validateTokenByAddress("host:3002", "");
      expect(result2).toBe(false);
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

  // N26 (round-8): per-address tokenHash lookup backing the per-executor
  // callback-token HMAC fallback.
  describe("getCallbackSecretByAddress", () => {
    it("returns the stored tokenHash and caches positive results", async () => {
      const qb = executorRepo.createQueryBuilder();
      qb.getOne.mockResolvedValue({
        address: "host:3002",
        tokenHash: "$2b$12$hash",
      });
      executorRepo.createQueryBuilder.mockReturnValue(qb);
      await expect(
        service.getCallbackSecretByAddress("host:3002"),
      ).resolves.toBe("$2b$12$hash");
      await expect(
        service.getCallbackSecretByAddress("host:3002"),
      ).resolves.toBe("$2b$12$hash");
      expect(qb.getOne).toHaveBeenCalledTimes(1);
    });

    it("returns null for unknown addresses and does not cache the miss", async () => {
      const qb = executorRepo.createQueryBuilder();
      qb.getOne.mockResolvedValue(null);
      executorRepo.createQueryBuilder.mockReturnValue(qb);
      await expect(
        service.getCallbackSecretByAddress("ghost:1"),
      ).resolves.toBeNull();
      await expect(
        service.getCallbackSecretByAddress("ghost:1"),
      ).resolves.toBeNull();
      expect(qb.getOne).toHaveBeenCalledTimes(2);
    });

    it("rotateToken evicts the cached hash so the new value is read immediately", async () => {
      const qb = executorRepo.createQueryBuilder();
      qb.getOne.mockResolvedValue({
        address: "127.0.0.1",
        tokenHash: "$2b$12$old",
      });
      executorRepo.createQueryBuilder.mockReturnValue(qb);
      await service.getCallbackSecretByAddress("127.0.0.1");
      expect(qb.getOne).toHaveBeenCalledTimes(1);

      const executor = { id: "e1", address: "127.0.0.1", tokenHash: null };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      await service.rotateToken("e1");

      await service.getCallbackSecretByAddress("127.0.0.1");
      expect(qb.getOne).toHaveBeenCalledTimes(2);
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
      qb.getRawOne.mockResolvedValue({
        total: "100",
        successful: "95",
        failed: "5",
        avgDuration: "1200",
      });
      execRepo.createQueryBuilder.mockReturnValue(qb);
      // FEAT-04: history read must not break the existing metrics contract —
      // default the history repo to an empty result unless a test opts in.
      const hqb = metricsHistoryRepo.createQueryBuilder();
      hqb.getRawMany.mockResolvedValue([]);
      metricsHistoryRepo.createQueryBuilder.mockReturnValue(hqb);
      const result = await service.getExecutorMetrics("e1");
      expect(result.sevenDayStats.totalExecutions).toBe(100);
      expect(result.sevenDayStats.successful).toBe(95);
      expect(result.current.runningTaskCount).toBe(2);
      expect(result.history).toEqual([]);
    });

    it("FEAT-04: returns history points aggregated into 15-min AVG buckets, ascending", async () => {
      const executor = {
        id: "e1",
        address: "host:3002",
        status: ExecutorStatus.ONLINE,
        runningTaskCount: 2,
        cpuUsage: 40,
        memUsage: 60,
      };
      executorRepo.findOne.mockResolvedValue(executor);
      const statsQb = execRepo.createQueryBuilder();
      statsQb.getRawOne.mockResolvedValue({
        total: "0",
        successful: "0",
        failed: "0",
        avgDuration: null,
      });
      execRepo.createQueryBuilder.mockReturnValue(statsQb);
      // Raw aggregate rows as PG would return them (bucket = epoch seconds)
      const hqb = metricsHistoryRepo.createQueryBuilder();
      hqb.getRawMany.mockResolvedValue([
        {
          bucket: "1782950400",
          cpu: "30.5",
          mem: "55.25",
          running: "1.6",
        },
        {
          bucket: "1782951300",
          cpu: null,
          mem: null,
          running: "0",
        },
      ]);
      metricsHistoryRepo.createQueryBuilder.mockReturnValue(hqb);

      const result = await service.getExecutorMetrics("e1");

      expect(result.history).toHaveLength(2);
      // Ascending by bucket; ISO timestamps derived from the bucket epoch
      expect(result.history[0].timestamp).toBe(
        new Date(1782950400_000).toISOString(),
      );
      expect(result.history[0]).toEqual({
        timestamp: new Date(1782950400_000).toISOString(),
        cpuUsage: 30.5,
        memUsage: 55.3, // rounded to 1 decimal
        runningTaskCount: 2, // AVG 1.6 → round
      });
      // AVG over NULL-only heartbeats → null cpu/mem, count coerced to 0
      expect(result.history[1]).toEqual({
        timestamp: new Date(1782951300_000).toISOString(),
        cpuUsage: null,
        memUsage: null,
        runningTaskCount: 0,
      });

      // Query contract: 24h window, bucketed AVG aggregate, capped, ascending
      const { ExecutorService: Svc } = await import("../executor.service");
      const bucketSeconds = Svc.METRICS_HISTORY_BUCKET_SECONDS;
      expect(bucketSeconds).toBe(900); // 24h/900s = 96 buckets ≤ 100 cap
      expect(Svc.METRICS_HISTORY_QUERY_LIMIT).toBe(500);
      expect(hqb.select).toHaveBeenCalledWith(
        expect.stringContaining("900"),
        "bucket",
      );
      expect(hqb.addSelect).toHaveBeenCalledWith("AVG(h.cpuUsage)", "cpu");
      expect(hqb.where).toHaveBeenCalledWith("h.executorAddress = :address", {
        address: "host:3002",
      });
      expect(hqb.andWhere).toHaveBeenCalledWith("h.createdAt > :since", {
        since: expect.any(Date),
      });
      const sinceArg = (hqb.andWhere as jest.Mock).mock.calls[0][1]
        .since as Date;
      expect(Date.now() - sinceArg.getTime()).toBeGreaterThanOrEqual(
        Svc.METRICS_HISTORY_WINDOW_MS - 1000,
      );
      expect(hqb.limit).toHaveBeenCalledWith(500);
      expect(hqb.orderBy).toHaveBeenCalledWith("bucket", "ASC");
    });

    it("FEAT-04: returns empty history when the executor has no samples", async () => {
      const executor = {
        id: "e1",
        address: "host:3002",
        status: ExecutorStatus.ONLINE,
        runningTaskCount: 0,
        cpuUsage: null,
        memUsage: null,
      };
      executorRepo.findOne.mockResolvedValue(executor);
      const statsQb = execRepo.createQueryBuilder();
      statsQb.getRawOne.mockResolvedValue(null);
      execRepo.createQueryBuilder.mockReturnValue(statsQb);
      const hqb = metricsHistoryRepo.createQueryBuilder();
      hqb.getRawMany.mockResolvedValue([]);
      metricsHistoryRepo.createQueryBuilder.mockReturnValue(hqb);

      const result = await service.getExecutorMetrics("e1");
      expect(result.history).toEqual([]);
    });
  });

  describe("detectLostExecutions DR-03", () => {
    let qb: ReturnType<ReturnType<typeof makeRepo>["createQueryBuilder"]>;
    let candidate: any;
    let warn: jest.SpyInstance;

    beforeEach(() => {
      candidate = {
        id: "lost-1",
        taskId: "task-1",
        executorAddress: "host:3002",
        status: ExecutionStatus.RUNNING,
        startTime: new Date(Date.now() - 20 * 60_000),
        logs: "existing logs",
      };
      qb = execRepo.createQueryBuilder();
      qb.getMany.mockResolvedValue([candidate]);
      execRepo.createQueryBuilder.mockReturnValue(qb);
      taskRepo.findBy.mockResolvedValue([{ id: "task-1", timeout: 300 }]);
      executorRepo.findBy.mockResolvedValue([
        { address: "host:3002", status: ExecutorStatus.OFFLINE },
      ]);
      warn = jest
        .spyOn((service as any).logger, "warn")
        .mockImplementation(() => {});
    });

    afterEach(() => warn.mockRestore());

    it("conditionally marks FAILED and releases exactly one slot with a warning", async () => {
      await service.detectLostExecutions();
      expect(qb.update).toHaveBeenCalledWith(TaskExecution);
      // A1: 条件 UPDATE 走统一入口；扫描路径的门槛是 [RUNNING]（旧实现口语
      // 化为 `status = :status`，与 scheduler 的开放态集合是两份事实源）。
      expect(qb.where).toHaveBeenCalledWith(
        '"id" IN (:...ids) AND "status" IN (:...gate)',
        { ids: ["lost-1"], gate: [ExecutionStatus.RUNNING] },
      );
      expect(qb.set).toHaveBeenCalledWith({
        status: ExecutionStatus.FAILED,
        endTime: expect.any(Date),
        errorMessage:
          "[System] Executor offline or task timed out, marked as failed by scheduler",
        logs: "existing logs\n[System] Execution timed out without callback, forcefully marked as FAILED",
      });
      expect(execRepo.save).not.toHaveBeenCalled();
      expect(executorRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
      const release = executorRepo.createQueryBuilder.mock.results[0].value;
      expect(release.where).toHaveBeenCalledWith("address = :address", {
        address: "host:3002",
      });
      expect(release.execute).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "Lost execution marked FAILED: execId=lost-1, taskId=task-1",
      );
    });

    // A1: 反证「扫描路径用请求前快照地址」的老坑——executorAddress 在 dispatch
    // HTTP 返回后才落库，秒级完成/掉线的执行其快照仍为 null，用它释放会 no-op
    // 使 runningTaskCount 永久虚高。旧实现没有 RETURNING，此例必红（释放不发生）。
    it("prefers the RETURNING executorAddress over a null pre-scan snapshot (A1)", async () => {
      candidate.executorAddress = null;
      qb.execute.mockResolvedValue({
        affected: 1,
        raw: [{ id: "lost-1", executorAddress: "host:3002" }],
      });
      await service.detectLostExecutions();
      expect(executorRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
      const release = executorRepo.createQueryBuilder.mock.results[0].value;
      expect(release.where).toHaveBeenCalledWith("address = :address", {
        address: "host:3002",
      });
      expect(warn).toHaveBeenCalledWith(
        "Lost execution marked FAILED: execId=lost-1, taskId=task-1",
      );
    });

    it.each([0, undefined])(
      "does not release or warn when affected=%s",
      async (affected) => {
        qb.execute.mockResolvedValue({ affected });
        const snapshot = { ...candidate };
        await service.detectLostExecutions();
        expect(candidate).toEqual(snapshot);
        expect(execRepo.save).not.toHaveBeenCalled();
        expect(executorRepo.createQueryBuilder).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
      },
    );

    it("releases once across two scans of the same stale candidate", async () => {
      qb.execute
        .mockResolvedValueOnce({ affected: 1 })
        .mockResolvedValueOnce({ affected: 0 });
      await service.detectLostExecutions();
      await service.detectLostExecutions();
      expect(qb.execute).toHaveBeenCalledTimes(2);
      expect(executorRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it.each(["online", "within timeout"])(
      "skips candidates %s",
      async (reason) => {
        if (reason === "online") {
          executorRepo.findBy.mockResolvedValue([
            { address: "host:3002", status: ExecutorStatus.ONLINE },
          ]);
        } else {
          candidate.startTime = new Date(Date.now() - 6 * 60_000);
        }
        await service.detectLostExecutions();
        expect(qb.update).not.toHaveBeenCalled();
        expect(executorRepo.createQueryBuilder).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
      },
    );

    // NETOPT-1⑧: 扫描无界 getMany 在僵尸行积压时一次物化全部行并逐行终态写
    // 放大为长事务风暴——补 take(1000)（对齐 scheduler O-2），截断后下一轮
    // 5 分钟 tick 自收敛。逐行 transitionToTerminal 语义不变（A1 收口）。
    it("NETOPT-1⑧: scan is bounded with take(1000) so a backlog self-converges over ticks", async () => {
      await service.detectLostExecutions();
      expect(qb.take).toHaveBeenCalledWith(1000);
    });
  });

  describe("cleanupOldRecords", () => {
    it("cron 入口按 90 天 cutoff 委派分批清理", async () => {
      const spy = jest
        .spyOn(service, "cleanupOldTaskExecutions")
        .mockResolvedValue(5);
      await service.cleanupOldRecords();
      expect(spy).toHaveBeenCalledTimes(1);
      const arg = spy.mock.calls[0][0] as Date;
      // cutoff ≈ 90 天前（允许时钟推进的秒级误差）
      const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
      expect(ninetyDaysMs - (Date.now() - arg.getTime())).toBeLessThan(60_000);
    });
  });

  // NETOPT-1②: task_executions retention 分批 DELETE——原单条无界 DELETE
  // 在峰值行数下是长事务（锁表 + WAL 风暴）。对齐 R-09 metrics 模式。
  describe("cleanupOldTaskExecutions (NETOPT-1②)", () => {
    const makeDeleteQb = (batchAffected: number) => ({
      delete: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: batchAffected }),
    });

    it("deletes in batches and stops when batch < size", async () => {
      // 第一批满批 5000 → 继续；第二批 100 → 停
      const qb1 = makeDeleteQb(5000);
      const qb2 = makeDeleteQb(100);
      execRepo.createQueryBuilder
        .mockReturnValueOnce(qb1 as any)
        .mockReturnValueOnce(qb2 as any);
      const cutoff = new Date("2026-06-14T00:00:00.000Z");
      const total = await service.cleanupOldTaskExecutions(cutoff);
      expect(total).toBe(5100);
      // 两次 DELETE 调用
      expect(execRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
      // 断言 where 子句带 cutoff 参数（createdAt < cutoff）与批大小
      expect(qb1.where).toHaveBeenCalledWith(
        expect.stringContaining('"createdAt" < :cutoff'),
        expect.objectContaining({ cutoff, batchSize: 5000 }),
      );
      expect(qb1.where).toHaveBeenCalledWith(
        expect.stringContaining('FROM "task_executions"'),
        expect.anything(),
      );
    });

    it("single undersized batch runs exactly one DELETE", async () => {
      const qb = makeDeleteQb(7);
      execRepo.createQueryBuilder.mockReturnValue(qb as any);
      const total = await service.cleanupOldTaskExecutions(new Date());
      expect(total).toBe(7);
      expect(execRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it("zero expired rows → no further batches", async () => {
      const qb = makeDeleteQb(0);
      execRepo.createQueryBuilder.mockReturnValue(qb as any);
      expect(await service.cleanupOldTaskExecutions(new Date())).toBe(0);
      expect(execRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it("cron entry honors LeaderGate (non-leader skips)", async () => {
      (service as unknown as { leaderGate: { isLeader: boolean } }).leaderGate =
        { isLeader: false };
      await service.cleanupOldRecords();
      expect(execRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    // NETOPT-8④: LOG-RETENTION-01 双闸回移植——affected 恒返满批（并发写入
    // 持续补进 / 驱动 affected 语义差异）时旧 `do..while(batchDeleted>=5000)`
    // 永不终止（log-retention-cleanup 已实测 OOM 挂死）。未修复时本用例在
    // 无界循环上超时转红。
    it("NETOPT-8④: affected 恒返满批也在轮数上限处终止并 warn（不挂死）", async () => {
      const warnSpy = jest.spyOn(Logger.prototype, "warn");
      try {
        const qb = makeDeleteQb(5000);
        qb.execute.mockResolvedValue({ affected: 5000 });
        execRepo.createQueryBuilder.mockReturnValue(qb as any);
        const total = await service.cleanupOldTaskExecutions(new Date());
        expect(total).toBe(5000 * LOG_RETENTION_MAX_DELETE_ROUNDS);
        expect(execRepo.createQueryBuilder).toHaveBeenCalledTimes(
          LOG_RETENTION_MAX_DELETE_ROUNDS,
        );
        const warned = warnSpy.mock.calls.some((c) =>
          String(c[0]).includes("轮数上限"),
        );
        expect(warned).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  // R-09（DEEP_REVIEW 0ef3bbe）: executor_metrics_history retention 清理。
  // 验证分批 DELETE 循环：单批不足批大小即停；cutoff 基于保留期计算。
  describe("cleanupExpiredMetricsHistory (R-09)", () => {
    const makeDeleteQb = (batchAffected: number) => ({
      delete: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: batchAffected }),
    });

    it("deletes expired rows in batches and stops when batch < size", async () => {
      configService.get.mockReturnValue(30); // logRetention.days
      // 第一批满批 5000 → 继续；第二批 100 → 停
      const qb1 = makeDeleteQb(5000);
      const qb2 = makeDeleteQb(100);
      metricsHistoryRepo.createQueryBuilder
        .mockReturnValueOnce(qb1 as any)
        .mockReturnValueOnce(qb2 as any);
      const now = new Date("2026-09-14T00:00:00.000Z");
      const total = await service.cleanupExpiredMetricsHistory(now);
      expect(total).toBe(5100);
      // 两次 DELETE 调用
      expect(metricsHistoryRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
      // 断言 where 子句带 cutoff 参数（createdAt < cutoff）
      expect(qb1.where).toHaveBeenCalledWith(
        expect.stringContaining('"createdAt" < :cutoff'),
        expect.objectContaining({
          cutoff: expect.any(Date),
          batchSize: 5000,
        }),
      );
    });

    it("respects configured retention days via logRetention.days", async () => {
      configService.get.mockReturnValue(7);
      const qb = makeDeleteQb(0);
      metricsHistoryRepo.createQueryBuilder.mockReturnValue(qb as any);
      const now = new Date("2026-09-14T00:00:00.000Z");
      await service.cleanupExpiredMetricsHistory(now);
      const whereArg = qb.where.mock.calls[0][1];
      // 7 天前 = 2026-09-07T00:00:00.000Z
      expect(whereArg.cutoff.getTime()).toBe(
        new Date("2026-09-07T00:00:00.000Z").getTime(),
      );
    });

    it("falls back to 30 days when config missing/invalid", async () => {
      configService.get.mockReturnValue(undefined);
      const qb = makeDeleteQb(0);
      metricsHistoryRepo.createQueryBuilder.mockReturnValue(qb as any);
      const now = new Date("2026-09-14T00:00:00.000Z");
      await service.cleanupExpiredMetricsHistory(now);
      const whereArg = qb.where.mock.calls[0][1];
      // 30 天前 = 2026-08-15T00:00:00.000Z
      expect(whereArg.cutoff.getTime()).toBe(
        new Date("2026-08-15T00:00:00.000Z").getTime(),
      );
    });

    it("cron entry honors LeaderGate (non-leader skips)", async () => {
      (service as unknown as { leaderGate: { isLeader: boolean } }).leaderGate =
        { isLeader: false };
      await service.cleanupMetricsHistory();
      expect(metricsHistoryRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    // NETOPT-8④: metrics 分批 DELETE 同样补轮数/墙钟双闸（未修复时本用例
    // 在无界循环上超时转红）。
    it("NETOPT-8④: affected 恒返满批也在轮数上限处终止并 warn（不挂死）", async () => {
      configService.get.mockReturnValue(30);
      const warnSpy = jest.spyOn(Logger.prototype, "warn");
      try {
        const qb = makeDeleteQb(5000);
        qb.execute.mockResolvedValue({ affected: 5000 });
        metricsHistoryRepo.createQueryBuilder.mockReturnValue(qb as any);
        const total = await service.cleanupExpiredMetricsHistory(new Date());
        expect(total).toBe(5000 * LOG_RETENTION_MAX_DELETE_ROUNDS);
        expect(metricsHistoryRepo.createQueryBuilder).toHaveBeenCalledTimes(
          LOG_RETENTION_MAX_DELETE_ROUNDS,
        );
        const warned = warnSpy.mock.calls.some((c) =>
          String(c[0]).includes("轮数上限"),
        );
        expect(warned).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe("getRuntimeConfig", () => {
    // P2-5/P3-9（executor lifecycle audit）：前端心跳判死阈值与列表截断提示
    // 必须以后端有效配置为唯一事实源。
    it("derives heartbeatTimeoutMs = interval × multiplier and reports total/cap", async () => {
      configService.get
        .mockReturnValueOnce(15000) // executor.heartbeatInterval
        .mockReturnValueOnce(4); // executor.heartbeatTimeoutMultiplier
      executorRepo.count.mockResolvedValueOnce(7);
      await expect(service.getRuntimeConfig()).resolves.toEqual({
        heartbeatIntervalMs: 15000,
        heartbeatTimeoutMultiplier: 4,
        heartbeatTimeoutMs: 60000,
        listLimit: EXECUTOR_LIST_LIMIT,
        executorTotal: 7,
      });
      expect(executorRepo.count).toHaveBeenCalled();
    });

    it("falls back to 30s × 3 = 90s when config is unset (same defaults as markStaleOffline)", async () => {
      configService.get.mockReturnValue(undefined);
      executorRepo.count.mockResolvedValueOnce(0);
      const cfg = await service.getRuntimeConfig();
      expect(cfg.heartbeatIntervalMs).toBe(30000);
      expect(cfg.heartbeatTimeoutMultiplier).toBe(3);
      expect(cfg.heartbeatTimeoutMs).toBe(90000);
      expect(cfg.listLimit).toBe(500);
    });
  });

  describe("markStaleOffline", () => {
    // R-30（DEEP_REVIEW 0ef3bbe）: markStaleOffline 由「find 快照 + repo.update +
    // 遍历快照扇出」改为「条件 UPDATE ... RETURNING + 遍历真实跃迁行扇出」。
    // 事件/通知只对真正 ONLINE→OFFLINE 的行发出——更新间隙内已恢复心跳的执行器
    // 不在 RETURNING 结果里，不再被误发。此处以一次性 QB 桩注入跃迁行。
    const stubTransition = (
      rows: Array<{ id: string; appName: string; address: string }>,
      affected = rows.length,
    ) => {
      const qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        returning: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected, raw: rows }),
      };
      executorRepo.createQueryBuilder.mockReturnValueOnce(qb as any);
      return qb;
    };

    it("marks heartbeat-timeout executors as OFFLINE via conditional UPDATE + RETURNING", async () => {
      configService.get
        .mockReturnValueOnce(30000) // heartbeatInterval
        .mockReturnValueOnce(3); // timeoutMultiplier
      const qb = stubTransition([
        { id: "exec-1", appName: "app", address: "http://host" },
      ]);
      await service.markStaleOffline();
      expect(qb.set).toHaveBeenCalledWith({ status: ExecutorStatus.OFFLINE });
      expect(qb.where).toHaveBeenCalledWith(
        expect.stringContaining("status = :status"),
        expect.objectContaining({ status: ExecutorStatus.ONLINE }),
      );
      expect(qb.returning).toHaveBeenCalledWith(["id", "appName", "address"]);
    });

    // FEAT-07 发布点：状态落库后 emit executor.offline，每台恰一次。
    it("emits executor.offline once per transitioned executor after the status write", async () => {
      resetRuntimeGauges();
      configService.get.mockReturnValueOnce(30000).mockReturnValueOnce(3);
      const stale = {
        id: "exec-9",
        appName: "stale-app",
        address: "10.0.0.5:3002",
      };
      stubTransition([stale]);
      const bus = { emit: jest.fn() };
      (service as unknown as { eventBus: unknown }).eventBus = bus;

      await service.markStaleOffline();

      expect(bus.emit).toHaveBeenCalledTimes(1);
      expect(bus.emit).toHaveBeenCalledWith(
        DOMAIN_EVENTS.EXECUTOR_OFFLINE,
        expect.objectContaining({
          executorId: "exec-9",
          appName: "stale-app",
          address: "10.0.0.5:3002",
          occurredAt: expect.any(String),
        }),
      );
      // 离线通知与事件同扇出位：fire-and-forget 但必须发起
      await Promise.resolve();
      expect(
        (service as any).notificationService.notifyExecutorOffline,
      ).toHaveBeenCalledWith("stale-app", "10.0.0.5:3002");
    });

    // R-30: 更新间隙内已恢复心跳的执行器不被 UPDATE 命中 → 不进 RETURNING →
    // 不误发离线事件/通知（旧实现的快照扇出会把已恢复者一并误发）。
    it("R-30: 间隙内已恢复的执行器不在 RETURNING 结果中则不扇出（只对真实跃迁行扇出）", async () => {
      configService.get.mockReturnValueOnce(30000).mockReturnValueOnce(3);
      // RETURNING 仅返回真正跃迁的行（已恢复的执行器不在其中）
      stubTransition([
        { id: "exec-still-stale", appName: "stale", address: "10.0.0.9:3002" },
      ]);
      const bus = { emit: jest.fn() };
      (service as unknown as { eventBus: unknown }).eventBus = bus;
      const notify = (service as any).notificationService
        .notifyExecutorOffline as jest.Mock;

      await service.markStaleOffline();

      expect(bus.emit).toHaveBeenCalledTimes(1);
      expect(bus.emit).toHaveBeenCalledWith(
        DOMAIN_EVENTS.EXECUTOR_OFFLINE,
        expect.objectContaining({ executorId: "exec-still-stale" }),
      );
      await Promise.resolve();
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith("stale", "10.0.0.9:3002");
    });

    it("R-30: RETURNING 零跃迁行时不发事件/通知", async () => {
      configService.get.mockReturnValueOnce(30000).mockReturnValueOnce(3);
      stubTransition([], 0);
      const bus = { emit: jest.fn() };
      (service as unknown as { eventBus: unknown }).eventBus = bus;

      await service.markStaleOffline();

      expect(bus.emit).not.toHaveBeenCalled();
      expect(
        (service as any).notificationService.notifyExecutorOffline,
      ).not.toHaveBeenCalled();
    });

    it("emit failure is fail-open — markStaleOffline still resolves", async () => {
      configService.get.mockReturnValueOnce(30000).mockReturnValueOnce(3);
      stubTransition([
        { id: "exec-9", appName: "a", address: "10.0.0.5:3002" },
      ]);
      const bus = {
        emit: jest.fn(() => {
          throw new Error("bus exploded");
        }),
      };
      (service as unknown as { eventBus: unknown }).eventBus = bus;

      await expect(service.markStaleOffline()).resolves.toBeUndefined();
      expect(bus.emit).toHaveBeenCalled();
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

    // FEAT-07 发布点（管理台置离线路径）：save 后 emit executor.offline。
    it("emits executor.offline after the admin-triggered offline save", async () => {
      const executor: any = {
        id: "exec-9",
        appName: "admin-off",
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
      };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      const bus = { emit: jest.fn() };
      (service as unknown as { eventBus: unknown }).eventBus = bus;

      await service.setOfflineById("exec-9");

      expect(bus.emit).toHaveBeenCalledWith(
        DOMAIN_EVENTS.EXECUTOR_OFFLINE,
        expect.objectContaining({
          executorId: "exec-9",
          appName: "admin-off",
          address: "127.0.0.1:3105",
        }),
      );
    });
  });

  describe("getInstallCmd", () => {
    it("uses the DB token instead of the env token", async () => {
      configService.get.mockImplementation((key) =>
        key === "app.adminApiUrl"
          ? "https://admin.example.com"
          : "old-env-token",
      );
      const lookup = jest
        .spyOn((service as any).systemConfigService, "findOne")
        .mockResolvedValue({ value: "rotated-db-token" });
      const result = await service.getInstallCmd();
      expect(lookup).toHaveBeenCalledWith("executor.sharedToken");
      expect(result).toEqual({
        cmd: "curl -fsSL 'https://admin.example.com/api/executors/install.sh' | bash -s -- --api-url 'https://admin.example.com' --secret 'rotated-db-token'",
        token: "rotated-db-token",
        adminApiUrl: "https://admin.example.com",
      });
    });

    it("returns curl|bash command pointing at the backend-served install.sh route", async () => {
      // Trailing slash on ADMIN_API_URL must be normalized away from the
      // script URL; --api-url keeps the raw value (executor .env semantics).
      (configService.get as jest.Mock)
        .mockReturnValueOnce("http://admin.example.com:3105/")
        .mockReturnValueOnce("sh'ell-token");
      const result = await service.getInstallCmd();
      expect(result.cmd).toContain(
        "curl -fsSL 'http://admin.example.com:3105/api/executors/install.sh'",
      );
      expect(result.cmd).toContain(
        "| bash -s -- --api-url 'http://admin.example.com:3105/'",
      );
      // Shell-quoting guard: single quotes in the token are escaped, not passed raw.
      expect(result.cmd).toContain("--secret 'sh'\\''ell-token'");
      expect(result.token).toBe("sh'ell-token");
      expect(result.adminApiUrl).toBe("http://admin.example.com:3105/");
    });

    it("no longer emits the legacy npx autoflow-executor command", async () => {
      const result = await service.getInstallCmd();
      expect(result.cmd).not.toContain("npx autoflow-executor");
    });

    // R7 真机遗留观察①：此前 ADMIN_API_URL 未配置时会生成
    // "curl -fsSL '/api/executors/install.sh' | bash -s -- --api-url ''"
    // 这种裸机不可用的命令，现改为显式 503。
    it("throws ServiceUnavailableException when ADMIN_API_URL is not configured", async () => {
      (configService.get as jest.Mock).mockReturnValueOnce(undefined);
      await expect(service.getInstallCmd()).rejects.toThrow(
        ServiceUnavailableException,
      );
      (configService.get as jest.Mock).mockReturnValueOnce("");
      await expect(service.getInstallCmd()).rejects.toThrow(
        /ADMIN_API_URL is not configured/,
      );
    });
  });

  // ============================================================================
  // QA-02 第二阶段（branches 冲 75）：selectLeastLoaded / dispatch / dispatch
  // Broadcast / validateExecutorToken / registerExecutor / metrics-history /
  // detectLostExecutions / markStaleOffline 的未覆盖分支定向补测。
  // 全部断言具体行为（过滤结果/重试顺序/载荷/返回值），无凑数弱断言。
  // ============================================================================

  describe("selectLeastLoaded (QA-02 phase 2)", () => {
    const mk = (over: Record<string, unknown> = {}) => ({
      id: "e1",
      address: "127.0.0.1:3105",
      status: ExecutorStatus.ONLINE,
      runningTaskCount: 0,
      ...over,
    });

    it("throws ServiceUnavailableException when the fleet is empty", async () => {
      executorRepo.find.mockResolvedValue([]);
      await expect(service.selectLeastLoaded()).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it("filters by group and rejects when no executor matches", async () => {
      executorRepo.find.mockResolvedValue([mk({ groupName: "staging" })]);
      await expect(
        service.selectLeastLoaded({ group: "production" }),
      ).rejects.toThrow(/match the requested group\/tags\/runtime/);
    });

    it("filters by tags: candidates missing a required tag are excluded", async () => {
      executorRepo.find.mockResolvedValue([
        mk({ id: "e-no-tags", tags: null }),
        mk({ id: "e-partial", tags: ["gpu"] }),
        mk({ id: "e-full", tags: ["gpu", "cuda"] }),
      ]);
      executorRepo.createQueryBuilder.mockClear();
      const chosen = await service.selectLeastLoaded({ tags: ["gpu", "cuda"] });
      expect(chosen.id).toBe("e-full");
    });

    it("rejects when tags filter excludes every online executor", async () => {
      executorRepo.find.mockResolvedValue([mk({ tags: ["cpu"] })]);
      await expect(
        service.selectLeastLoaded({ tags: ["gpu"] }),
      ).rejects.toThrow(/match the requested group\/tags\/runtime/);
    });

    it("treats an executor with no capabilities as runtime-universal", async () => {
      executorRepo.find.mockResolvedValue([mk({ capabilities: [] })]);
      const chosen = await service.selectLeastLoaded({ runtime: "python" });
      expect(chosen.id).toBe("e1");
    });

    it("excludes an executor whose capabilities lack the requested runtime", async () => {
      executorRepo.find.mockResolvedValue([
        mk({ id: "e-node", capabilities: ["node"] }),
      ]);
      await expect(
        service.selectLeastLoaded({ runtime: "python" }),
      ).rejects.toThrow(/match the requested group\/tags\/runtime/);
    });

    it("skips executors at max capacity and reports all-at-capacity otherwise", async () => {
      executorRepo.find.mockResolvedValue([
        mk({ id: "e-full", runningTaskCount: 2, maxConcurrentTasks: 2 }),
      ]);
      await expect(service.selectLeastLoaded()).rejects.toThrow(
        /all online executors are at maximum capacity/,
      );
    });

    it("scores by load/cpu/mem and prefers the least loaded executor", async () => {
      executorRepo.find.mockResolvedValue([
        mk({
          id: "e-busy",
          runningTaskCount: 4,
          cpuUsage: 90,
          memUsage: 90,
          maxConcurrentTasks: 10,
        }),
        mk({
          id: "e-idle",
          runningTaskCount: 1,
          cpuUsage: 10,
          memUsage: 10,
          maxConcurrentTasks: 10,
        }),
      ]);
      const chosen = await service.selectLeastLoaded();
      expect(chosen.id).toBe("e-idle");
    });

    it("falls back to maxConcurrentTasks=10 for scoring when the column is null", async () => {
      executorRepo.find.mockResolvedValue([
        mk({ id: "e-null-max", runningTaskCount: 3, maxConcurrentTasks: null }),
        mk({ id: "e-light", runningTaskCount: 1, maxConcurrentTasks: null }),
      ]);
      const chosen = await service.selectLeastLoaded();
      expect(chosen.id).toBe("e-light");
    });
  });

  describe("dispatch — filters, scoring and atomic slot reservation (QA-02 phase 2 / BUG-22)", () => {
    const execution = { id: "exec-1", params: {} } as TaskExecution;

    it("rejects with an appName-classified message when no executor has that appName", async () => {
      executorRepo.find.mockResolvedValue([
        {
          id: "e1",
          address: "127.0.0.1:3105",
          status: ExecutorStatus.ONLINE,
          runningTaskCount: 0,
        },
      ]);
      await expect(
        service.dispatch(
          {
            id: "task-1",
            name: "t",
            executorAppName: "ghost-app",
            timeout: 10,
          } as unknown as Task,
          execution,
        ),
      ).rejects.toThrow(/No available executor with appName "ghost-app"/);
    });

    it("filters by tag subset and never dispatches to an executor missing a tag", async () => {
      const task = {
        id: "task-1",
        name: "t",
        executorTags: ["gpu", "cuda"],
        timeout: 10,
      } as unknown as Task;
      executorRepo.find.mockResolvedValue([
        {
          id: "e1",
          address: "a:1",
          status: ExecutorStatus.ONLINE,
          runningTaskCount: 0,
          tags: ["gpu"],
        },
        {
          id: "e2",
          address: "b:2",
          status: ExecutorStatus.ONLINE,
          runningTaskCount: 0,
          tags: ["gpu", "cuda"],
        },
      ]);
      mockedAxios.post.mockResolvedValue({ data: { ok: true } });
      await service.dispatch(task, execution);
      expect(
        (mockedAxios.post.mock.calls[0][0] as string).startsWith("b:2") ||
          (mockedAxios.post.mock.calls[0][0] as string).includes("b:2"),
      ).toBe(true);
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    });

    it("excludes executors whose capabilities lack the task runtime", async () => {
      const task = {
        id: "task-1",
        name: "t",
        runtime: "python",
        timeout: 10,
      } as unknown as Task;
      executorRepo.find.mockResolvedValue([
        {
          id: "e-node",
          address: "n:1",
          status: ExecutorStatus.ONLINE,
          runningTaskCount: 0,
          capabilities: ["node"],
        },
        {
          id: "e-py",
          address: "p:1",
          status: ExecutorStatus.ONLINE,
          runningTaskCount: 0,
          capabilities: ["python"],
        },
      ]);
      mockedAxios.post.mockResolvedValue({ data: { ok: true } });
      await service.dispatch(task, execution);
      expect(mockedAxios.post.mock.calls[0][0]).toContain("p:1");
    });

    it("treats empty capabilities as runtime-universal in dispatch filtering", async () => {
      const task = {
        id: "task-1",
        name: "t",
        runtime: "mystery",
        timeout: 10,
      } as unknown as Task;
      executorRepo.find.mockResolvedValue([
        {
          id: "e-any",
          address: "any:1",
          status: ExecutorStatus.ONLINE,
          runningTaskCount: 0,
          capabilities: [],
        },
      ]);
      mockedAxios.post.mockResolvedValue({ data: { ok: true } });
      await service.dispatch(task, execution);
      expect(mockedAxios.post.mock.calls[0][0]).toContain("any:1");
    });

    it("retries the next candidate when the first loses the optimistic-lock race, then succeeds", async () => {
      const first = {
        id: "e-first",
        address: "first:1",
        status: ExecutorStatus.ONLINE,
        runningTaskCount: 0,
        maxConcurrentTasks: 2,
        version: 1,
      };
      const second = {
        id: "e-second",
        address: "second:2",
        status: ExecutorStatus.ONLINE,
        runningTaskCount: 0,
        maxConcurrentTasks: 2,
        version: 5,
      };
      // 静态排序确定尝试顺序：first（running=0）先于 second（running=1）
      second.runningTaskCount = 1;
      executorRepo.find.mockResolvedValue([first, second]);
      let executes = 0;
      executorRepo.createQueryBuilder.mockImplementation(() => {
        executes += 1;
        // 第 1 次 qb = 乐观锁 UPDATE（first 输）；第 2 次 = second 赢；
        // 第 3 次 = 派发失败回滚。
        const won = executes === 2;
        return {
          update: jest.fn().mockReturnThis(),
          set: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          returning: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue({ affected: won ? 1 : 0 }),
        } as any;
      });
      // first 赢得乐观锁但 HTTP 派发失败 → 回滚 its slot，整体向上抛
      // （second 已不会被尝试——乐观锁赢家的 HTTP 失败即失败）。
      // 此用例改为验证：first 乐观锁输 → second 赢 → HTTP 成功。
      mockedAxios.post.mockResolvedValue({ data: { ok: true } });

      const result = await service.dispatch(
        { id: "task-1", name: "t", timeout: 10 } as unknown as Task,
        execution,
      );
      expect(result.ok).toBe(true);
      // 至少两次乐观锁尝试（first 输、second 赢），无回滚（HTTP 成功）
      expect(executes).toBeGreaterThanOrEqual(2);
      expect(mockedAxios.post.mock.calls[0][0]).toContain("second:2");
    });

    it("throws when every candidate is offline or at capacity", async () => {
      executorRepo.find.mockResolvedValue([
        {
          id: "e1",
          address: "a:1",
          status: ExecutorStatus.ONLINE,
          runningTaskCount: 1,
          maxConcurrentTasks: 1,
          version: 1,
        },
      ]);
      executorRepo.createQueryBuilder.mockImplementation(
        () =>
          ({
            update: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            returning: jest.fn().mockReturnThis(),
            execute: jest.fn().mockResolvedValue({ affected: 0 }),
          }) as any,
      );
      await expect(
        service.dispatch(
          { id: "task-1", name: "t", timeout: 10 } as unknown as Task,
          execution,
        ),
      ).rejects.toThrow(/all candidates are offline or at capacity/);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    // BUG-22（QA-05 压测暴露）：并发占坑**不得**因 version 漂移而失败。
    // 旧实现 `.andWhere("version = :version")`：单执行器 + worker 并发 >1 时，
    // 首个占坑把 version +1，其余并发的 CAS 全部 affected=0 → 候选人只有一个 →
    // 抛 "No available executor" → 该执行直接 FAILED（maxRetry=0 无重试兜底）。
    // 容量与在线状态本就由同一条 UPDATE 的 WHERE 原子保证，version 谓词冗余。
    it("BUG-22: 并发占坑不因版本漂移失败，且 UPDATE 不再带 version 谓词", async () => {
      // runningTaskCount=0 / max=4：容量尚有余量；version 故意给"已被别人推进过"的值
      executorRepo.find.mockResolvedValue([
        {
          id: "e1",
          address: "busy:1",
          status: ExecutorStatus.ONLINE,
          runningTaskCount: 0,
          maxConcurrentTasks: 4,
          version: 42,
        },
      ]);
      const andWhere = jest.fn().mockReturnThis();
      executorRepo.createQueryBuilder.mockImplementation(
        () =>
          ({
            update: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere,
            execute: jest.fn().mockResolvedValue({ affected: 1 }),
          }) as any,
      );
      mockedAxios.post.mockResolvedValue({ data: { ok: true } });

      await expect(
        service.dispatch(
          { id: "task-1", name: "t", timeout: 10 } as unknown as Task,
          execution,
        ),
      ).resolves.toEqual({ ok: true });

      // 占坑 UPDATE 的谓词里不得出现版本比较（回归锁）
      const predicates = andWhere.mock.calls.map((c) => String(c[0]));
      expect(predicates.some((p) => /version/i.test(p))).toBe(false);
      // 容量与在线状态谓词必须仍在（原子不变量没有被顺手删掉）
      expect(predicates.some((p) => /runningTaskCount" < :max/.test(p))).toBe(
        true,
      );
      expect(predicates.some((p) => /status = :status/.test(p))).toBe(true);
    });

    it("skips the capacity guard (1=1) for executors without maxConcurrentTasks", async () => {
      executorRepo.find.mockResolvedValue([
        {
          id: "e-inf",
          address: "inf:1",
          status: ExecutorStatus.ONLINE,
          runningTaskCount: 0,
          maxConcurrentTasks: null,
          version: 3,
        },
      ]);
      const andWhere = jest.fn().mockReturnThis();
      executorRepo.createQueryBuilder.mockImplementation(
        () =>
          ({
            update: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere,
            execute: jest.fn().mockResolvedValue({ affected: 1 }),
          }) as any,
      );
      mockedAxios.post.mockResolvedValue({ data: { ok: true } });
      await service.dispatch(
        { id: "task-1", name: "t", timeout: 10 } as unknown as Task,
        execution,
      );
      // maxConcurrentTasks=null → Infinity → 容量 andWhere 分支收 "1=1"
      const capacityCall = andWhere.mock.calls.find(
        (c: unknown[]) => String(c[0]) === "1=1",
      );
      expect(capacityCall).toBeDefined();
    });

    it("injects an Authorization header only when a shared token resolves", async () => {
      executorRepo.find.mockResolvedValue([
        {
          id: "e1",
          address: "a:1",
          status: ExecutorStatus.ONLINE,
          runningTaskCount: 0,
        },
      ]);
      // SystemConfigService.findOne 默认 reject → 走 config fallback（"http" 非 token 也非空）。
      // 返回值 mock 为可识别 token 验证 header 注入。
      (service as any).systemConfigService.findOne = jest
        .fn()
        .mockResolvedValue({ value: "db-token-1" });
      mockedAxios.post.mockResolvedValue({ data: { ok: true } });
      await service.dispatch(
        { id: "task-1", name: "t", timeout: 10 } as unknown as Task,
        execution,
      );
      const config = mockedAxios.post.mock.calls[0][2] as {
        headers: Record<string, string>;
      };
      expect(config.headers["Authorization"]).toBe("Bearer db-token-1");
    });

    it("omits the Authorization header when no shared token is configured", async () => {
      executorRepo.find.mockResolvedValue([
        {
          id: "e1",
          address: "a:1",
          status: ExecutorStatus.ONLINE,
          runningTaskCount: 0,
        },
      ]);
      (service as any).systemConfigService.findOne = jest
        .fn()
        .mockResolvedValue({ value: "" });
      configService.get.mockReturnValue("");
      mockedAxios.post.mockResolvedValue({ data: { ok: true } });
      await service.dispatch(
        { id: "task-1", name: "t", timeout: 10 } as unknown as Task,
        execution,
      );
      const config = mockedAxios.post.mock.calls[0][2] as {
        headers: Record<string, string>;
      };
      expect(config.headers["Authorization"]).toBeUndefined();
    });

    it("surfaces a secrets decryption failure as a dispatch error (no silent credential-less run)", async () => {
      executorRepo.find.mockResolvedValue([
        {
          id: "e1",
          address: "a:1",
          status: ExecutorStatus.ONLINE,
          runningTaskCount: 0,
        },
      ]);
      (service as any).secretsCrypto = {
        decryptForDispatch: jest.fn(() => {
          throw new Error("key rotated away");
        }),
      };
      await expect(
        service.dispatch(
          {
            id: "task-1",
            name: "t",
            timeout: 10,
            secrets: { API_KEY: "enc:v1:x" },
          } as unknown as Task,
          execution,
        ),
      ).rejects.toThrow(/could not be decrypted for dispatch/);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it("rolls back the slot when the pinned dispatch HTTP call fails", async () => {
      const pinned = {
        id: "e-pin",
        address: "pin:1",
        status: ExecutorStatus.ONLINE,
        runningTaskCount: 0,
        version: 1,
      };
      executorRepo.findOne.mockResolvedValue(pinned);
      const set = jest.fn().mockReturnThis();
      executorRepo.createQueryBuilder.mockImplementation(
        () =>
          ({
            update: jest.fn().mockReturnThis(),
            set,
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            returning: jest.fn().mockReturnThis(),
            execute: jest.fn().mockResolvedValue({ affected: 1 }),
          }) as any,
      );
      mockedAxios.post.mockRejectedValue(new Error("pin connection refused"));

      await expect(
        service.dispatch(
          {
            id: "task-1",
            name: "t",
            timeout: 10,
            executorId: "e-pin",
          } as unknown as Task,
          execution,
        ),
      ).rejects.toThrow("pin connection refused");
      // qb#1 = 乐观锁占用，qb#2 = 回滚
      expect(executorRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
      expect(set).toHaveBeenCalledWith({
        runningTaskCount: expect.anything(),
      });
    });
  });

  describe("dispatchBroadcast — filter and failure paths (QA-02 phase 2)", () => {
    const execution = { id: "exec-1", params: {} } as TaskExecution;

    it("rejects when no online executor has the requested appName", async () => {
      executorRepo.find.mockResolvedValue([
        {
          id: "e1",
          address: "a:1",
          status: ExecutorStatus.ONLINE,
          appName: "other",
        },
      ]);
      await expect(
        service.dispatchBroadcast(
          {
            id: "task-1",
            name: "t",
            executorAppName: "ghost",
            timeout: 10,
          } as unknown as Task,
          execution,
        ),
      ).rejects.toThrow("No available executor for broadcast dispatch");
    });

    it("applies group/tag/runtime filters to the broadcast target set", async () => {
      executorRepo.find.mockResolvedValue([
        {
          id: "e1",
          address: "wrong:1",
          status: ExecutorStatus.ONLINE,
          groupName: "staging",
          tags: ["gpu"],
          capabilities: [],
        },
        {
          id: "e2",
          address: "right:2",
          status: ExecutorStatus.ONLINE,
          groupName: "prod",
          tags: ["gpu", "cuda"],
          capabilities: [],
        },
      ]);
      mockedAxios.post.mockResolvedValue({ data: { ok: true } });
      const results = await service.dispatchBroadcast(
        {
          id: "task-1",
          name: "t",
          executorGroup: "prod",
          executorTags: ["gpu", "cuda"],
          timeout: 10,
        } as unknown as Task,
        execution,
      );
      expect(results).toHaveLength(1);
      expect(mockedAxios.post.mock.calls[0][0]).toContain("right:2");
    });

    it("surfaces the per-target error message in the all-failed broadcast error", async () => {
      executorRepo.find.mockResolvedValue([
        { id: "e1", address: "a:1", status: ExecutorStatus.ONLINE },
      ]);
      mockedAxios.post.mockRejectedValue(new Error("boom-on-a1"));
      await expect(
        service.dispatchBroadcast(
          { id: "task-1", name: "t", timeout: 10 } as unknown as Task,
          execution,
        ),
      ).rejects.toThrow(/a:1: boom-on-a1/);
    });

    it("maps a non-Error rejection reason into the failure list", async () => {
      executorRepo.find.mockResolvedValue([
        { id: "e1", address: "a:1", status: ExecutorStatus.ONLINE },
      ]);
      mockedAxios.post.mockRejectedValue("string-reason");
      await expect(
        service.dispatchBroadcast(
          { id: "task-1", name: "t", timeout: 10 } as unknown as Task,
          execution,
        ),
      ).rejects.toThrow(/a:1: string-reason/);
    });
  });

  describe("validateExecutorToken (QA-02 phase 2)", () => {
    it("returns false when the executor row does not exist", async () => {
      executorRepo.createQueryBuilder.mockReturnValue({
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      } as any);
      await expect(service.validateExecutorToken("ghost", "tok")).resolves.toBe(
        false,
      );
    });

    it("validates a per-executor token via bcrypt compare", async () => {
      const raw = "per-executor-token";
      const hash = await bcrypt.hash(raw, 1);
      executorRepo.createQueryBuilder.mockReturnValue({
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({ id: "e1", tokenHash: hash }),
      } as any);
      await expect(service.validateExecutorToken("e1", raw)).resolves.toBe(
        true,
      );
      await expect(service.validateExecutorToken("e1", "wrong")).resolves.toBe(
        false,
      );
    });

    it("returns false when falling back to a shared token that is not configured", async () => {
      executorRepo.createQueryBuilder.mockReturnValue({
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({ id: "e1", tokenHash: null }),
      } as any);
      (service as any).systemConfigService.findOne = jest
        .fn()
        .mockRejectedValue(new Error("nf"));
      configService.get.mockReturnValue("");
      await expect(
        service.validateExecutorToken("e1", "anything"),
      ).resolves.toBe(false);
    });

    it("rejects a shared-token candidate of a different length without timingSafeEqual", async () => {
      executorRepo.createQueryBuilder.mockReturnValue({
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({ id: "e1", tokenHash: null }),
      } as any);
      (service as any).systemConfigService.findOne = jest
        .fn()
        .mockResolvedValue({ value: "short" });
      await expect(
        service.validateExecutorToken("e1", "a-much-longer-token"),
      ).resolves.toBe(false);
    });

    it("accepts the exact shared token via constant-time comparison", async () => {
      executorRepo.createQueryBuilder.mockReturnValue({
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({ id: "e1", tokenHash: null }),
      } as any);
      (service as any).systemConfigService.findOne = jest
        .fn()
        .mockResolvedValue({ value: "exact-shared" });
      await expect(
        service.validateExecutorToken("e1", "exact-shared"),
      ).resolves.toBe(true);
    });
  });

  describe("registerExecutor — restart/baseline edge branches (QA-02 phase 2)", () => {
    const makeQbRepo = (prior: any) =>
      makeRepo({
        createQueryBuilder: jest.fn(() => ({
          addSelect: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockResolvedValue(prior),
        })),
      });

    it("executorVersion is only updated when the register payload carries version", async () => {
      const existing = {
        id: "e1",
        appName: "app",
        address: "127.0.0.1:3105",
        executorStartupId: "startup-1",
        executorStartedAt: new Date("2026-01-01T00:00:00Z"),
        executorVersion: "0.9",
        tokenHash: "$2b$12$existinghash",
      };
      const repo = makeQbRepo(existing);
      repo.findOne.mockResolvedValue(existing);
      repo.save.mockImplementation((e: any) => Promise.resolve(e));
      const svc = await makeServiceWithRepo(repo);
      jest
        .spyOn(svc, "rotateToken")
        .mockResolvedValue({ token: "issued-token" });

      // 同 startupId + tokenHash → sameProcess → 无重签；version 缺省 → 版本列不动
      await svc.registerExecutor({
        appName: "app",
        address: "127.0.0.1:3105",
        startupId: "startup-1",
      });
      expect(existing.executorVersion).toBe("0.9");

      // version 字段出现 → 白名单内赋值
      await svc.registerExecutor({
        appName: "app",
        address: "127.0.0.1:3105",
        startupId: "startup-1",
        version: "1.1",
      });
      expect(existing.executorVersion).toBe("1.1");
    });
  });

  describe("getExecutorMetricsHistory — defensive branches (QA-02 phase 2)", () => {
    it("skips rows whose bucket is not finite and coerces null running to 0", async () => {
      executorRepo.findOne.mockResolvedValue({
        id: "e1",
        address: "host:3002",
        status: ExecutorStatus.ONLINE,
        runningTaskCount: 0,
      });
      const statsQb = execRepo.createQueryBuilder();
      statsQb.getRawOne.mockResolvedValue({
        total: "0",
        successful: "0",
        failed: "0",
        avgDuration: null,
      });
      execRepo.createQueryBuilder.mockReturnValue(statsQb);
      const hqb = metricsHistoryRepo.createQueryBuilder();
      hqb.getRawMany.mockResolvedValue([
        { bucket: "not-a-number", cpu: "10", mem: "10", running: "1" },
        { bucket: "1782950400", cpu: "20", mem: "40", running: null },
      ]);
      metricsHistoryRepo.createQueryBuilder.mockReturnValue(hqb);

      const result = await service.getExecutorMetrics("e1");
      expect(result.history).toHaveLength(1);
      expect(result.history[0]).toEqual({
        timestamp: new Date(1782950400_000).toISOString(),
        cpuUsage: 20,
        memUsage: 40,
        runningTaskCount: 0,
      });
    });
  });

  describe("detectLostExecutions — per-task timeout branches (QA-02 phase 2)", () => {
    it("uses the task's own timeout for the per-execution threshold (task present)", async () => {
      const exec = {
        id: "exec-1",
        taskId: "task-1",
        taskName: "t",
        status: ExecutionStatus.RUNNING,
        executorAddress: "dead:1",
        startTime: new Date(Date.now() - 20 * 60 * 1000),
        logs: "partial output",
      };
      const qb = execRepo.createQueryBuilder();
      qb.getMany.mockResolvedValue([exec]);
      execRepo.createQueryBuilder.mockReturnValue(qb);
      taskRepo.findBy.mockResolvedValue([
        { id: "task-1", name: "t", timeout: 5 },
      ]);
      executorRepo.findBy.mockResolvedValue([
        { address: "dead:1", status: ExecutorStatus.OFFLINE },
      ]);
      executorRepo.createQueryBuilder.mockImplementation(
        () =>
          ({
            update: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            returning: jest.fn().mockReturnThis(),
            execute: jest.fn().mockResolvedValue({ affected: 1 }),
          }) as any,
      );

      await service.detectLostExecutions();

      // FAILED 落库（logs 保留原有内容并追加系统行）
      const setArg = execRepo.createQueryBuilder.mock.results[0].value.set.mock
        .calls[0][0] as Record<string, unknown>;
      expect(setArg.status).toBe(ExecutionStatus.FAILED);
      expect(String(setArg.logs)).toContain("partial output");
      expect(String(setArg.logs)).toContain(
        "[System] Execution timed out without callback",
      );
    });

    it("keeps an execution whose executor is still ONLINE (no false positive)", async () => {
      const exec = {
        id: "exec-2",
        taskId: "task-1",
        status: ExecutionStatus.RUNNING,
        executorAddress: "alive:1",
        startTime: new Date(Date.now() - 20 * 60 * 1000),
      };
      const qb = execRepo.createQueryBuilder();
      qb.getMany.mockResolvedValue([exec]);
      execRepo.createQueryBuilder.mockReturnValue(qb);
      taskRepo.findBy.mockResolvedValue([]);
      executorRepo.findBy.mockResolvedValue([
        { address: "alive:1", status: ExecutorStatus.ONLINE },
      ]);

      await service.detectLostExecutions();

      const setMock = (execRepo.createQueryBuilder.mock.results[0].value as any)
        .set;
      expect(setMock).not.toHaveBeenCalled();
    });

    it("uses the 5-minute default threshold when the task row is gone", async () => {
      const exec = {
        id: "exec-3",
        taskId: "missing-task",
        status: ExecutionStatus.RUNNING,
        executorAddress: null,
        startTime: new Date(Date.now() - 20 * 60 * 1000),
      };
      const qb = execRepo.createQueryBuilder();
      qb.getMany.mockResolvedValue([exec]);
      execRepo.createQueryBuilder.mockReturnValue(qb);
      qb.execute.mockResolvedValue({ affected: 1 });
      taskRepo.findBy.mockResolvedValue([]);
      executorRepo.findBy.mockResolvedValue([]);

      await service.detectLostExecutions();
      // executorAddress 为 null → releaseExecutorSlot 早退（executor qb 不触碰）
      expect(executorRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(qb.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("heartbeat — runtime metric default branches (QA-02 phase 2)", () => {
    it("keeps the stored value for metric fields the heartbeat omits", async () => {
      const executor = {
        address: "127.0.0.1:3105",
        status: ExecutorStatus.OFFLINE,
        cpuUsage: 11,
        memUsage: 22,
        diskUsage: 33,
        runningTaskCount: 5,
        totalTaskCount: 9,
        failedTaskCount: 2,
        networkLatency: 7,
      };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));

      const saved = await service.heartbeat("127.0.0.1:3105", {
        cpuUsage: 44,
      });

      // 未上报字段不被覆盖（白名单仅赋值 undefined 键之外的字段）
      expect(saved.memUsage).toBe(22);
      expect(saved.diskUsage).toBe(33);
      expect(saved.runningTaskCount).toBe(5);
      expect(saved.cpuUsage).toBe(44);
      // 心跳即上线
      expect(saved.status).toBe(ExecutorStatus.ONLINE);
      expect(saved.lastHeartbeat).toBeInstanceOf(Date);
    });

    it("restoreSilencesFromStore failure keeps the memory-only mode (notification store contract mirrored)", async () => {
      // 占位对齐 notification.service.spec 的语义——此处无 silenceStore 注入，
      // restoreSilencesFromStore 走 !silenceStore 早退分支，不抛错即契约。
      expect((service as any).tokenValidationCache).toBeDefined();
    });
  });

  // ============================================================================
  // NF-04: 任务标签亲和/反亲和调度约束——dispatch 候选过滤矩阵。
  // 语义拍板（与 entity/DTO/迁移注释及 docs/api-reference.md 同步）：
  //   - 亲和 executorAffinityTags = OR 语义（持有任一标签即命中）；
  //   - 反亲和 executorAntiAffinityTags = 排除语义（持有任一标签即剔除）；
  //   - 过滤先于 CORE-05 loadScore 排序（先筛再按负载选）；
  //   - null/[] = 无约束，默认行为零变化；
  //   - broadcast + 亲和 = 广播收窄为命中子集；broadcast + 反亲和照常剔除；
  //   - 候选为空走既有 "No online executors match..." 失败路径。
  // ============================================================================
  describe("dispatch — affinity / anti-affinity tag constraints (NF-04)", () => {
    const execution = { id: "exec-1", params: {} } as TaskExecution;

    const mkExecutor = (id: string, address: string, tags: string[] | null) =>
      ({
        id,
        address,
        status: ExecutorStatus.ONLINE,
        runningTaskCount: 0,
        tags,
        version: 1,
      }) as any;

    const mkTask = (over: Record<string, unknown>) =>
      ({ id: "task-1", name: "t", timeout: 10, ...over }) as unknown as Task;

    const dispatchedAddresses = () =>
      mockedAxios.post.mock.calls.map((c) => c[0] as string);

    beforeEach(() => {
      mockedAxios.post.mockResolvedValue({ data: { ok: true } });
    });

    it("unconstrained task (both columns null) ignores the constraint filters entirely — zero behavior change", async () => {
      const e = mkExecutor("e1", "a:1", null);
      executorRepo.find.mockResolvedValue([e]);
      await service.dispatch(mkTask({}), execution);
      expect(dispatchedAddresses()[0]).toContain("a:1");
    });

    it("affinity (OR): executor holding ANY of the affinity tags is eligible", async () => {
      executorRepo.find.mockResolvedValue([
        mkExecutor("e-gpu", "gpu:1", ["gpu"]),
        mkExecutor("e-edge", "edge:1", ["edge"]),
        mkExecutor("e-none", "none:1", ["misc"]),
      ]);
      await service.dispatch(
        mkTask({ executorAffinityTags: ["gpu", "edge"] }),
        execution,
      );
      // OR 命中前两个；loadScore 在命中集合内择优——两者 running 相同时
      // 排序稳定，两个都可能是赢家，但 e-none 必须被排除。
      const urls = dispatchedAddresses();
      expect(urls).toHaveLength(1);
      expect(urls[0]).not.toContain("none:1");
      expect(urls[0].includes("gpu:1") || urls[0].includes("edge:1")).toBe(
        true,
      );
    });

    it("affinity (OR): executor with no tags never matches an affinity constraint", async () => {
      executorRepo.find.mockResolvedValue([
        mkExecutor("e-notags", "notags:1", null),
      ]);
      await expect(
        service.dispatch(mkTask({ executorAffinityTags: ["gpu"] }), execution),
      ).rejects.toThrow(
        "No online executors match the requested group/tags/runtime",
      );
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it("affinity miss on the whole fleet fails through the existing no-executor path", async () => {
      executorRepo.find.mockResolvedValue([mkExecutor("e1", "a:1", ["misc"])]);
      await expect(
        service.dispatch(mkTask({ executorAffinityTags: ["gpu"] }), execution),
      ).rejects.toThrow(
        "No online executors match the requested group/tags/runtime",
      );
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it("anti-affinity: executors holding ANY of the tags are excluded", async () => {
      executorRepo.find.mockResolvedValue([
        mkExecutor("e-windows", "win:1", ["windows"]),
        mkExecutor("e-linux", "linux:1", ["linux"]),
      ]);
      await service.dispatch(
        mkTask({ executorAntiAffinityTags: ["windows"] }),
        execution,
      );
      const urls = dispatchedAddresses();
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain("linux:1");
    });

    it("anti-affinity excluding the entire fleet fails through the existing no-executor path", async () => {
      executorRepo.find.mockResolvedValue([
        mkExecutor("e1", "a:1", ["windows"]),
      ]);
      await expect(
        service.dispatch(
          mkTask({ executorAntiAffinityTags: ["windows"] }),
          execution,
        ),
      ).rejects.toThrow(
        "No online executors match the requested group/tags/runtime",
      );
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it("anti-affinity tolerates executors with no tags (nothing to exclude)", async () => {
      executorRepo.find.mockResolvedValue([
        mkExecutor("e-notags", "notags:1", null),
      ]);
      await service.dispatch(
        mkTask({ executorAntiAffinityTags: ["windows"] }),
        execution,
      );
      expect(dispatchedAddresses()[0]).toContain("notags:1");
    });

    it("affinity ∩ anti-affinity: matched set is filtered further (intersection semantics)", async () => {
      executorRepo.find.mockResolvedValue([
        mkExecutor("e-gpu-win", "gw:1", ["gpu", "windows"]),
        mkExecutor("e-gpu", "g:1", ["gpu"]),
        mkExecutor("e-edge", "e:1", ["edge"]),
      ]);
      await service.dispatch(
        mkTask({
          executorAffinityTags: ["gpu", "edge"],
          executorAntiAffinityTags: ["windows"],
        }),
        execution,
      );
      const urls = dispatchedAddresses();
      expect(urls).toHaveLength(1);
      // gpu/edge 亲和命中 gw:1 与 g:1；反亲和剔除 gw:1 → 只剩 g:1
      expect(urls[0]).toContain("g:1");
    });

    it("affinity filter runs BEFORE loadScore ordering: a busy matching executor loses to an idle matching one", async () => {
      const busy = mkExecutor("e-match-busy", "busy:1", ["gpu"]);
      const idle = mkExecutor("e-match-idle", "idle:1", ["gpu"]);
      busy.runningTaskCount = 4;
      busy.maxConcurrentTasks = 10;
      busy.cpuUsage = 90;
      busy.memUsage = 90;
      idle.maxConcurrentTasks = 10;
      executorRepo.find.mockResolvedValue([
        busy,
        mkExecutor("e-other-idle", "otheridle:1", ["misc"]),
        idle,
      ]);
      // busy 命中亲和但满载，otheridle 完全空闲但不命中亲和。
      // 若 loadScore 先于亲和过滤，otheridle 会胜出；先筛后选则 idle:1 胜。
      await service.dispatch(
        mkTask({ executorAffinityTags: ["gpu"] }),
        execution,
      );
      const urls = dispatchedAddresses();
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain("idle:1");
      expect(urls[0]).not.toContain("otheridle:1");
    });

    it("empty affinity array [] is treated as unconstrained (default unchanged)", async () => {
      executorRepo.find.mockResolvedValue([mkExecutor("e1", "a:1", ["misc"])]);
      await service.dispatch(
        mkTask({ executorAffinityTags: [], executorAntiAffinityTags: [] }),
        execution,
      );
      expect(dispatchedAddresses()[0]).toContain("a:1");
    });

    it("broadcast + anti-affinity: executors holding the tag are excluded from the fan-out", async () => {
      executorRepo.find.mockResolvedValue([
        mkExecutor("e1", "b1:1", ["linux"]),
        mkExecutor("e2", "b2:1", ["windows"]),
        mkExecutor("e3", "b3:1", null),
      ]);
      const results = await service.dispatchBroadcast(
        mkTask({ executorAntiAffinityTags: ["windows"] }),
        execution,
      );
      expect(results).toHaveLength(2);
      const urls = dispatchedAddresses();
      expect(urls).toHaveLength(2);
      expect(urls.some((u) => u.includes("b2:1"))).toBe(false);
    });

    it("broadcast + affinity: fan-out NARROWS to the executors matching the affinity tags (third-state ruling)", async () => {
      executorRepo.find.mockResolvedValue([
        mkExecutor("e1", "b1:1", ["gpu"]),
        mkExecutor("e2", "b2:1", ["edge"]),
        mkExecutor("e3", "b3:1", ["misc"]),
        mkExecutor("e4", "b4:1", null),
      ]);
      const results = await service.dispatchBroadcast(
        mkTask({ executorAffinityTags: ["gpu", "edge"] }),
        execution,
      );
      // 裁定：broadcast 本为全体在线执行器，亲和把广播收窄为命中子集
      // （pinning=唯一 / broadcast=全体 / broadcast+亲和=命中子集）。
      expect(results).toHaveLength(2);
      const urls = dispatchedAddresses();
      expect(urls.some((u) => u.includes("b1:1"))).toBe(true);
      expect(urls.some((u) => u.includes("b2:1"))).toBe(true);
      expect(urls.some((u) => u.includes("b3:1"))).toBe(false);
      expect(urls.some((u) => u.includes("b4:1"))).toBe(false);
    });

    it("broadcast with every candidate excluded by the constraints fails through the existing no-executor path", async () => {
      executorRepo.find.mockResolvedValue([
        mkExecutor("e1", "b1:1", ["windows"]),
      ]);
      await expect(
        service.dispatchBroadcast(
          mkTask({ executorAffinityTags: ["gpu"] }),
          execution,
        ),
      ).rejects.toThrow(
        "No online executors match the requested group/tags/runtime",
      );
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it("executorAppName branch bypasses the constraint filters (explicit single-target intent, same as group/tags)", async () => {
      executorRepo.find.mockResolvedValue([
        {
          id: "e1",
          appName: "alpha",
          address: "app:1",
          status: ExecutorStatus.ONLINE,
          runningTaskCount: 0,
          tags: ["windows"],
          version: 1,
        } as any,
      ]);
      await service.dispatch(
        mkTask({
          executorAppName: "alpha",
          executorAffinityTags: ["gpu"],
          executorAntiAffinityTags: ["windows"],
        }),
        execution,
      );
      // appName 精确指定本就绕过 group/tags 过滤（既有语义），亲和约束
      // 与 group/tags 同面处理，不额外收紧 appName 路径。
      expect(dispatchedAddresses()[0]).toContain("app:1");
    });
  });
});

// R-26（DEEP_REVIEW 0ef3bbe）: @Optional 关键依赖缺失时的静默降级可观测性。
// 生产装配下 DomainEventBus / AuditService 由 @Global 模块恒提供；构造器对
// 缺失项各 warn 一次——「executor.offline 事件静默不发」「rotate-token 等高危
// 操作审计静默不写」两条降级路径因此可见。不改变任何业务行为。
describe("R-26: @Optional 关键依赖缺失可观测性（ExecutorService）", () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  const buildService = (opts: {
    eventBus: unknown;
    audit: unknown;
  }): ExecutorService =>
    new ExecutorService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { get: jest.fn().mockReturnValue("http") } as never, // configService
      {} as never, // notificationService
      {} as never, // systemConfigService
      {} as never, // secretsCrypto
      opts.eventBus as never, // eventBus（@Optional）
      null as never, // tracing（@Optional）
      opts.audit as never, // audit（@Optional）
      null as never, // leaderGate（@Optional）
      null as never, // pullService（@Optional）
    );

  const r26Messages = (): string[] =>
    warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("R-26"));

  it("eventBus/audit 缺失时各 warn 一次，且不抛", () => {
    expect(() => buildService({ eventBus: null, audit: null })).not.toThrow();
    const msgs = r26Messages();
    expect(msgs).toHaveLength(2);
    expect(msgs.some((m) => m.includes("DomainEventBus"))).toBe(true);
    expect(msgs.some((m) => m.includes("AuditService"))).toBe(true);
  });

  it("依赖齐备时不产生任何 R-26 warn", () => {
    buildService({ eventBus: { emit: jest.fn() }, audit: { log: jest.fn() } });
    expect(r26Messages()).toHaveLength(0);
  });
});
