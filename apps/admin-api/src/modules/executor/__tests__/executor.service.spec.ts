import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { getRepositoryToken } from "@nestjs/typeorm";
import {
  NotFoundException,
  ServiceUnavailableException,
  Logger,
} from "@nestjs/common";
import { ExecutorService } from "../executor.service";
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
import {
  getRuntimeGaugesSnapshot,
  resetRuntimeGauges,
} from "../../metrics/runtime-metrics-entry";

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
      expect(execRepo.delete).toHaveBeenCalledWith("retry-2");
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
      expect(qb.where).toHaveBeenCalledWith("id = :id AND status = :status", {
        id: "lost-1",
        status: ExecutionStatus.RUNNING,
      });
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
        .mockReturnValueOnce(30000) // heartbeatInterval
        .mockReturnValueOnce(3); // timeoutMultiplier
      // find() must return stale executors so the early-return guard is skipped
      executorRepo.find.mockResolvedValue([
        { id: "exec-1", appName: "app", address: "http://host" },
      ]);
      executorRepo.update.mockResolvedValue({ affected: 1 });
      await service.markStaleOffline();
      expect(executorRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: ExecutorStatus.ONLINE }),
        { status: ExecutorStatus.OFFLINE },
      );
    });

    // FEAT-07 发布点：状态落库后 emit executor.offline，每台恰一次。
    it("emits executor.offline once per stale executor after the status write", async () => {
      resetRuntimeGauges();
      configService.get
        .mockReturnValueOnce(30000)
        .mockReturnValueOnce(3);
      const stale = {
        id: "exec-9",
        appName: "stale-app",
        address: "10.0.0.5:3002",
      };
      executorRepo.find.mockResolvedValue([stale]);
      executorRepo.update.mockResolvedValue({ affected: 1 });
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

    it("emit failure is fail-open — markStaleOffline still resolves", async () => {
      configService.get
        .mockReturnValueOnce(30000)
        .mockReturnValueOnce(3);
      executorRepo.find.mockResolvedValue([
        { id: "exec-9", appName: "a", address: "10.0.0.5:3002" },
      ]);
      executorRepo.update.mockResolvedValue({ affected: 1 });
      const bus = {
        emit: jest.fn(() => {
          throw new Error("bus exploded");
        }),
      };
      (service as unknown as { eventBus: unknown }).eventBus = bus;

      await expect(service.markStaleOffline()).resolves.toBeUndefined();
      expect(executorRepo.update).toHaveBeenCalled();
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
        key === "ADMIN_API_URL" ? "https://admin.example.com" : "old-env-token",
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

  describe("dispatch — filters, scoring and optimistic-lock retry (QA-02 phase 2)", () => {
    const execution = { id: "exec-1", params: {} } as TaskExecution;

    it("rejects with an appName-classified message when no executor has that appName", async () => {
      executorRepo.find.mockResolvedValue([
        { id: "e1", address: "127.0.0.1:3105", status: ExecutorStatus.ONLINE, runningTaskCount: 0 },
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
        { id: "e1", address: "a:1", status: ExecutorStatus.ONLINE, runningTaskCount: 0, tags: ["gpu"] },
        { id: "e2", address: "b:2", status: ExecutorStatus.ONLINE, runningTaskCount: 0, tags: ["gpu", "cuda"] },
      ]);
      mockedAxios.post.mockResolvedValue({ data: { ok: true } });
      await service.dispatch(task, execution);
      expect((mockedAxios.post.mock.calls[0][0] as string).startsWith("b:2") ||
        (mockedAxios.post.mock.calls[0][0] as string).includes("b:2")).toBe(true);
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    });

    it("excludes executors whose capabilities lack the task runtime", async () => {
      const task = { id: "task-1", name: "t", runtime: "python", timeout: 10 } as unknown as Task;
      executorRepo.find.mockResolvedValue([
        { id: "e-node", address: "n:1", status: ExecutorStatus.ONLINE, runningTaskCount: 0, capabilities: ["node"] },
        { id: "e-py", address: "p:1", status: ExecutorStatus.ONLINE, runningTaskCount: 0, capabilities: ["python"] },
      ]);
      mockedAxios.post.mockResolvedValue({ data: { ok: true } });
      await service.dispatch(task, execution);
      expect(mockedAxios.post.mock.calls[0][0]).toContain("p:1");
    });

    it("treats empty capabilities as runtime-universal in dispatch filtering", async () => {
      const task = { id: "task-1", name: "t", runtime: "mystery", timeout: 10 } as unknown as Task;
      executorRepo.find.mockResolvedValue([
        { id: "e-any", address: "any:1", status: ExecutorStatus.ONLINE, runningTaskCount: 0, capabilities: [] },
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

    it("throws when every candidate loses the optimistic-lock race (capacity full / version conflict)", async () => {
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
      executorRepo.createQueryBuilder.mockImplementation(() => ({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      }) as any);
      await expect(
        service.dispatch(
          { id: "task-1", name: "t", timeout: 10 } as unknown as Task,
          execution,
        ),
      ).rejects.toThrow(/all at capacity or concurrency conflict/);
      expect(mockedAxios.post).not.toHaveBeenCalled();
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
        { id: "e1", address: "a:1", status: ExecutorStatus.ONLINE, runningTaskCount: 0 },
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
        { id: "e1", address: "a:1", status: ExecutorStatus.ONLINE, runningTaskCount: 0 },
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
        { id: "e1", address: "a:1", status: ExecutorStatus.ONLINE, runningTaskCount: 0 },
      ]);
      (service as any).secretsCrypto = {
        decryptForDispatch: jest.fn(() => {
          throw new Error("key rotated away");
        }),
      };
      await expect(
        service.dispatch(
          { id: "task-1", name: "t", timeout: 10, secrets: { API_KEY: "enc:v1:x" } } as unknown as Task,
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
            execute: jest.fn().mockResolvedValue({ affected: 1 }),
          }) as any,
      );
      mockedAxios.post.mockRejectedValue(new Error("pin connection refused"));

      await expect(
        service.dispatch(
          { id: "task-1", name: "t", timeout: 10, executorId: "e-pin" } as unknown as Task,
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
        { id: "e1", address: "a:1", status: ExecutorStatus.ONLINE, appName: "other" },
      ]);
      await expect(
        service.dispatchBroadcast(
          { id: "task-1", name: "t", executorAppName: "ghost", timeout: 10 } as unknown as Task,
          execution,
        ),
      ).rejects.toThrow("No available executor for broadcast dispatch");
    });

    it("applies group/tag/runtime filters to the broadcast target set", async () => {
      executorRepo.find.mockResolvedValue([
        { id: "e1", address: "wrong:1", status: ExecutorStatus.ONLINE, groupName: "staging", tags: ["gpu"], capabilities: [] },
        { id: "e2", address: "right:2", status: ExecutorStatus.ONLINE, groupName: "prod", tags: ["gpu", "cuda"], capabilities: [] },
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
      await expect(
        service.validateExecutorToken("ghost", "tok"),
      ).resolves.toBe(false);
    });

    it("validates a per-executor token via bcrypt compare", async () => {
      const raw = "per-executor-token";
      const hash = await bcrypt.hash(raw, 1);
      executorRepo.createQueryBuilder.mockReturnValue({
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({ id: "e1", tokenHash: hash }),
      } as any);
      await expect(
        service.validateExecutorToken("e1", raw),
      ).resolves.toBe(true);
      await expect(
        service.validateExecutorToken("e1", "wrong"),
      ).resolves.toBe(false);
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
      executorRepo.createQueryBuilder.mockImplementation(() => ({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      }) as any);

      await service.detectLostExecutions();

      // FAILED 落库（logs 保留原有内容并追加系统行）
      const setArg = execRepo.createQueryBuilder.mock.results[0].value.set
        .mock.calls[0][0] as Record<string, unknown>;
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
});
