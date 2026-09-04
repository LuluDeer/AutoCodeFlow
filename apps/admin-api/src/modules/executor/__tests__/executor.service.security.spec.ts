import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ExecutorService } from "../executor.service";
import { Executor, ExecutorStatus } from "../entities/executor.entity";
import { TaskExecution } from "../../task/entities/task-execution.entity";
import { Task } from "../../task/entities/task.entity";
import { ConfigService } from "@nestjs/config";
import * as bcrypt from "bcrypt";
import { NotificationService } from "../../notification/notification.service";
import { SystemConfigService } from "../../config/config.service";

jest.mock("axios", () => {
  const actual = jest.requireActual("axios");
  const post = jest.fn();
  const get = jest.fn();
  // `import axios from "axios"` resolves to exports.default under interop —
  // stub it with the SAME jest.fn()s so the service's default-imported axios
  // never performs a real network call.
  return {
    ...actual,
    post,
    get,
    default: { ...(actual.default ?? actual), post, get },
  };
});
jest.mock("../../../common/utils/safe-http.util", () => ({
  assertSafeExecutorUrl: jest.fn().mockResolvedValue(new URL("http://ok")),
}));

const makeRepo = (overrides: Partial<Record<string, jest.Mock>> = {}) => ({
  findOne: jest.fn(),
  find: jest.fn().mockResolvedValue([]),
  findBy: jest.fn().mockResolvedValue([]),
  create: jest.fn((d) => d),
  save: jest.fn((e) => Promise.resolve(e)),
  update: jest.fn().mockResolvedValue({ affected: 1 }),
  delete: jest.fn().mockResolvedValue({ affected: 1 }),
  remove: jest.fn().mockResolvedValue(undefined),
  findAndCount: jest.fn().mockResolvedValue([[], 0]),
  createQueryBuilder: jest.fn(() => ({
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
    getOne: jest.fn().mockResolvedValue(null),
    select: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
    getRawOne: jest.fn().mockResolvedValue(null),
    getCount: jest.fn().mockResolvedValue(0),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  })),
  ...overrides,
});

/**
 * F-2 / F-7 / F-3 / F-5 regression coverage at the service layer.
 */
describe("ExecutorService — security regressions (F-2/F-7/F-3/F-5)", () => {
  let service: ExecutorService;
  let executorRepo: ReturnType<typeof makeRepo>;
  let execRepo: ReturnType<typeof makeRepo>;
  let taskRepo: ReturnType<typeof makeRepo>;
  let taskQueue: { add: jest.Mock };
  let configService: { get: jest.Mock };

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
        {
          provide: NotificationService,
          useValue: {
            notifyExecutorOnline: jest.fn().mockResolvedValue(undefined),
            notifyExecutorOffline: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: SystemConfigService,
          useValue: { findOne: jest.fn().mockRejectedValue(new Error("nf")) },
        },
      ],
    }).compile();
    service = module.get(ExecutorService);
    jest.clearAllMocks();
  });

  describe("F-2: heartbeat column injection", () => {
    it("ignores injected tokenHash — the column is untouched after save", async () => {
      const executor: any = {
        address: "10.0.0.9:3002",
        status: ExecutorStatus.OFFLINE,
        tokenHash: "$2b$12$legithash",
      };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));

      await service.heartbeat("10.0.0.9:3002", {
        cpuUsage: 10,
        tokenHash: "$2b$12$attackerhash",
      } as any);

      expect(executor.tokenHash).toBe("$2b$12$legithash");
      expect(executor.status).toBe(ExecutorStatus.ONLINE);
      expect(executor.cpuUsage).toBe(10);
    });

    it("ignores injected optimistic-lock version, maxConcurrentTasks and arbitrary entity columns", async () => {
      const executor: any = {
        address: "10.0.0.9:3002",
        status: ExecutorStatus.ONLINE,
        version: 7,
        maxConcurrentTasks: 4,
        executorStartupId: "startup-real",
        executorStartedAt: new Date("2026-01-01T00:00:00.000Z"),
        runningTaskCount: 3,
        appName: "real-executor",
        id: "real-id",
      };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));

      await service.heartbeat("10.0.0.9:3002", {
        version: 9999,
        maxConcurrentTasks: 100000,
        appName: "renamed",
        id: "victim-id",
        tokenHash: "$2b$12$attackerhash",
      } as any);

      expect(executor.version).toBe(7);
      expect(executor.maxConcurrentTasks).toBe(4);
      expect(executor.appName).toBe("real-executor");
      expect(executor.id).toBe("real-id");
      // tokenHash was never assigned:
      expect(executor.tokenHash).toBeUndefined();
    });

    it("accepts known metric columns only", async () => {
      const executor: any = {
        address: "10.0.0.9:3002",
        status: ExecutorStatus.OFFLINE,
        cpuUsage: null,
        memUsage: null,
        diskUsage: null,
        networkLatency: null,
        runningTaskCount: 0,
        totalTaskCount: 0,
        failedTaskCount: 0,
      };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));

      await service.heartbeat("10.0.0.9:3002", {
        cpuUsage: 1,
        memUsage: 2,
        diskUsage: 3,
        networkLatency: 4,
        runningTaskCount: 5,
        totalTaskCount: 6,
        failedTaskCount: 7,
      });

      expect(executor.cpuUsage).toBe(1);
      expect(executor.memUsage).toBe(2);
      expect(executor.diskUsage).toBe(3);
      expect(executor.networkLatency).toBe(4);
      expect(executor.runningTaskCount).toBe(5);
      expect(executor.totalTaskCount).toBe(6);
      expect(executor.failedTaskCount).toBe(7);
    });
  });

  describe("F-7: register id injection", () => {
    it("repo.create never receives client-supplied id / tokenHash / status", async () => {
      executorRepo.findOne.mockResolvedValue(null);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));

      await service.register({
        appName: "hijack",
        address: "10.0.0.9:3002",
        id: "existing-executor-id",
        tokenHash: "$2b$12$attackerhash",
        status: ExecutorStatus.OFFLINE,
        runningTaskCount: -1000,
        version: 99,
      } as any);

      const created = executorRepo.create.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect("id" in created).toBe(false);
      expect("tokenHash" in created).toBe(false);
      expect("runningTaskCount" in created).toBe(false);
      expect("version" in created).toBe(false);
      // status/lastHeartbeat are set by the service, not the client:
      expect(created.status).toBe(ExecutorStatus.ONLINE);
    });
  });

  describe("F-3: dispatch SSRF guard", () => {
    const execution = { id: "exec-1", params: {} } as TaskExecution;
    const task = {
      id: "task-1",
      name: "t",
      timeout: 10,
      status: "active",
      triggerType: "manual",
    } as unknown as Task;

    it("refuses to POST to a metadata address and rolls back the slot", async () => {
      const { assertSafeExecutorUrl } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("../../../common/utils/safe-http.util") as {
          assertSafeExecutorUrl: jest.Mock;
        };
      assertSafeExecutorUrl.mockRejectedValueOnce(
        new Error(
          "Executor address 169.254.169.254 resolves to 169.254.169.254 (link-local) — outbound request refused",
        ),
      );
      const executor = {
        id: "e1",
        address: "169.254.169.254:80",
        status: ExecutorStatus.ONLINE,
        runningTaskCount: 0,
        capabilities: [],
      };
      executorRepo.find.mockResolvedValue([executor]);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const axios = require("axios");
      await expect(service.dispatch(task, execution)).rejects.toThrow(
        /link-local/,
      );
      expect(axios.post).not.toHaveBeenCalled();
      // rollback: qb#1 = optimistic slot increment, qb#2 = decrement on failure
      expect(executorRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
      const rollbackQb = executorRepo.createQueryBuilder.mock.results[1].value;
      expect(rollbackQb.set).toHaveBeenCalledWith({
        runningTaskCount: expect.anything(),
      });
    });

    it("POSTs to a private LAN address by default (internal-network topology)", async () => {
      const { assertSafeExecutorUrl } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("../../../common/utils/safe-http.util") as {
          assertSafeExecutorUrl: jest.Mock;
        };
      assertSafeExecutorUrl.mockResolvedValue(
        new URL("http://10.0.0.9:3002/api/execute"),
      );
      const executor = {
        id: "e1",
        address: "10.0.0.9:3002",
        status: ExecutorStatus.ONLINE,
        runningTaskCount: 0,
        capabilities: [],
      };
      executorRepo.find.mockResolvedValue([executor]);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const axios = require("axios");
      axios.post.mockResolvedValue({ data: { success: true } });
      const result = await service.dispatch(task, execution);
      expect(result.success).toBe(true);
      expect(axios.post).toHaveBeenCalledWith(
        "http://10.0.0.9:3002/api/execute",
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe("F-5: token validation positive cache", () => {
    const rawToken = "raw-secret";
    const hashReady = async () => {
      const hash = await bcrypt.hash(rawToken, 1);
      const qb = executorRepo.createQueryBuilder();
      qb.getOne.mockResolvedValue({ address: "host:3002", tokenHash: hash });
      executorRepo.createQueryBuilder.mockReturnValue(qb);
    };

    it("caches a successful validation and skips the second bcrypt compare", async () => {
      await hashReady();
      const spy = jest.spyOn(bcrypt, "compare");
      expect(await service.validateTokenByAddress("host:3002", rawToken)).toBe(
        true,
      );
      expect(await service.validateTokenByAddress("host:3002", rawToken)).toBe(
        true,
      );
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it("never caches negative results", async () => {
      await hashReady();
      const spy = jest.spyOn(bcrypt, "compare");
      configService.get.mockReturnValue(""); // no shared token fallback
      expect(await service.validateTokenByAddress("host:3002", "wrong")).toBe(
        false,
      );
      expect(await service.validateTokenByAddress("host:3002", "wrong")).toBe(
        false,
      );
      expect(spy).toHaveBeenCalledTimes(2);
      spy.mockRestore();
    });

    it("does not leak raw tokens into the cache key", async () => {
      await hashReady();
      await service.validateTokenByAddress("host:3002", rawToken);
      const keys = [...(service as any).tokenValidationCache.keys()];
      expect(keys).toHaveLength(1);
      expect(keys[0]).not.toContain(rawToken);
      expect(keys[0]).not.toContain("host:3002");
    });
  });
});
