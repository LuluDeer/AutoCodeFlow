import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { HealthService } from "../health.service";
import { Task } from "../../task/entities/task.entity";
import { Executor } from "../../executor/entities/executor.entity";
import { TaskExecution } from "../../task/entities/task-execution.entity";

// Mock the redis createClient so HealthService constructor doesn't open a real connection
jest.mock("redis", () => ({
  createClient: jest.fn(() => ({
    isReady: false,
    connect: jest.fn().mockResolvedValue(undefined),
    ping: jest.fn().mockResolvedValue("PONG"),
  })),
}));

const makeRepoMock = (overrides: Partial<Record<string, jest.Mock>> = {}) => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn(),
  count: jest.fn().mockResolvedValue(0),
  query: jest.fn().mockResolvedValue([{ "?column?": 1 }]),
  ...overrides,
});

const makeQueueMock = () => ({
  getWaitingCount: jest.fn().mockResolvedValue(0),
  getActiveCount: jest.fn().mockResolvedValue(1),
  getDelayedCount: jest.fn().mockResolvedValue(0),
  getFailedCount: jest.fn().mockResolvedValue(0),
  getJobs: jest.fn().mockResolvedValue([]),
});

describe("HealthService", () => {
  let service: HealthService;
  let taskRepo: ReturnType<typeof makeRepoMock>;
  let executorRepo: ReturnType<typeof makeRepoMock>;
  let execRepo: ReturnType<typeof makeRepoMock>;
  let taskQueue: ReturnType<typeof makeQueueMock>;

  // WIKI-OPT-1: 模块装配抽为 helper——阈值/缓存配置化后，部分用例需要在
  // 构造期注入自定义 health.* 配置（HealthService 在构造器读取配置），
  // 通过 configMap 覆盖对应键；未覆盖的键回退 ConfigService.get 的第二参
  // 默认值（与生产 configuration.ts 的回退默认一致）。
  const buildService = async (
    configMap: Record<string, unknown> = {},
  ): Promise<HealthService> => {
    const module = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: getRepositoryToken(Task), useValue: taskRepo },
        { provide: getRepositoryToken(Executor), useValue: executorRepo },
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
        { provide: "BullQueue_task-queue", useValue: taskQueue },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, def?: unknown) =>
              key in configMap ? configMap[key] : def,
            ),
          },
        },
      ],
    }).compile();
    return module.get(HealthService);
  };

  beforeEach(async () => {
    taskRepo = makeRepoMock();
    executorRepo = makeRepoMock();
    execRepo = makeRepoMock();
    taskQueue = makeQueueMock();
    service = await buildService();
  });

  describe("checkDatabase", () => {
    it("returns healthy when SELECT 1 succeeds", async () => {
      taskRepo.query.mockResolvedValue([{ "?column?": 1 }]);
      const result = await service.checkDatabase();
      expect(result.status).toBe("healthy");
      expect(taskRepo.query).toHaveBeenCalledWith("SELECT 1");
    });

    it("returns unhealthy when query throws", async () => {
      taskRepo.query.mockRejectedValue(new Error("connection refused"));
      const result = await service.checkDatabase();
      expect(result.status).toBe("unhealthy");
      expect(result.details).toContain("connection refused");
    });
  });

  describe("checkQueue", () => {
    it("returns healthy when queue counts are normal", async () => {
      const result = await service.checkQueue();
      expect(result.status).toBe("healthy");
      expect(typeof result.size).toBe("number");
    });

    it("returns degraded when failed count exceeds threshold", async () => {
      taskQueue.getFailedCount.mockResolvedValue(200);
      const result = await service.checkQueue();
      expect(result.status).toBe("degraded");
    });

    it("returns unhealthy when queue throws", async () => {
      taskQueue.getWaitingCount.mockRejectedValue(new Error("Bull down"));
      const result = await service.checkQueue();
      expect(result.status).toBe("unhealthy");
    });
  });

  describe("checkExecutors", () => {
    it("returns degraded when no executors are registered", async () => {
      executorRepo.count.mockResolvedValue(0);
      const result = await service.checkExecutors();
      expect(result.status).toBe("degraded");
      expect(result.totalCount).toBe(0);
    });

    it("returns unhealthy when all executors are offline", async () => {
      // count(where) counts online; count() with no args is the total
      executorRepo.count.mockImplementation((opts?: unknown) => (opts ? 0 : 2));
      const result = await service.checkExecutors();
      expect(result.status).toBe("unhealthy");
      expect(result.onlineCount).toBe(0);
    });

    it("returns healthy when majority of executors are online", async () => {
      executorRepo.count.mockImplementation((opts?: unknown) => (opts ? 2 : 3));
      const result = await service.checkExecutors();
      expect(result.status).toBe("healthy");
      expect(result.onlineCount).toBe(2);
      expect(result.totalCount).toBe(3);
    });

    it("returns degraded when fewer than 50% of executors are online", async () => {
      executorRepo.count.mockImplementation((opts?: unknown) => (opts ? 1 : 3));
      const result = await service.checkExecutors();
      expect(result.status).toBe("degraded");
    });

    it("returns unhealthy with zeroed counts when the executor repo throws", async () => {
      executorRepo.count.mockRejectedValue(new Error("executors db down"));
      const result = await service.checkExecutors();
      expect(result.status).toBe("unhealthy");
      expect(result.onlineCount).toBe(0);
      expect(result.totalCount).toBe(0);
      expect(result.details).toContain("executors db down");
    });
  });

  describe("checkTasks", () => {
    it("returns task counts correctly", async () => {
      // count(where) counts active tasks; count() with no args is the total
      taskRepo.count.mockImplementation((opts?: unknown) => (opts ? 2 : 3));
      execRepo.count.mockResolvedValue(1);

      const result = await service.checkTasks();
      expect(result.status).toBe("healthy");
      expect(result.activeCount).toBe(2);
      expect(result.totalCount).toBe(3);
      expect(result.runningCount).toBe(1);
    });

    it("returns unhealthy with zeroed counts when the task repo throws", async () => {
      taskRepo.count.mockRejectedValue(new Error("tasks db down"));
      const result = await service.checkTasks();
      expect(result.status).toBe("unhealthy");
      expect(result.activeCount).toBe(0);
      expect(result.totalCount).toBe(0);
      expect(result.runningCount).toBe(0);
      expect(result.details).toContain("tasks db down");
    });
  });

  describe("checkScheduler", () => {
    it("returns healthy when getJobs succeeds", async () => {
      taskQueue.getJobs.mockResolvedValue([{}, {}]);
      const result = await service.checkScheduler();
      expect(result.status).toBe("healthy");
      expect(result.details).toContain("2 jobs");
    });

    it("returns unhealthy when getJobs throws", async () => {
      taskQueue.getJobs.mockRejectedValue(new Error("queue error"));
      const result = await service.checkScheduler();
      expect(result.status).toBe("unhealthy");
    });
  });

  // WIKI-OPT-1: 单项检查异常不得击穿 getFullHealth（此前 checkTasks/
  // checkExecutors 无 try/catch，任一 reject 会让整体 Promise.all 拒绝）。
  describe("getFullHealth failure isolation", () => {
    it("resolves unhealthy and aggregates a tasks component when checkTasks fails", async () => {
      taskRepo.count.mockRejectedValue(new Error("tasks db down"));

      const result = await service.getFullHealth();

      expect(result.status).toBe("unhealthy");
      expect(result.services.tasks.status).toBe("unhealthy");
      expect(result.services.tasks.details).toContain("tasks db down");
      expect(result.services.tasks.totalCount).toBe(0);
      const tasksComponent = result.components.find((c) => c.name === "tasks");
      expect(tasksComponent).toBeDefined();
      expect(tasksComponent?.status).toBe("unhealthy");
      expect(tasksComponent?.message).toContain("tasks db down");
      // metrics 用归零后的计数，而非 undefined
      expect(result.metrics.totalTasks).toBe(0);
      expect(result.metrics.activeTasks).toBe(0);
    });

    it("resolves unhealthy when checkExecutors fails", async () => {
      executorRepo.count.mockRejectedValue(new Error("executors db down"));

      const result = await service.getFullHealth();

      expect(result.status).toBe("unhealthy");
      expect(result.services.executors.status).toBe("unhealthy");
      expect(result.services.executors.details).toContain("executors db down");
      const executorsComponent = result.components.find(
        (c) => c.name === "executors",
      );
      expect(executorsComponent?.status).toBe("unhealthy");
    });

    it("aggregates all six checks (including tasks) into components on the healthy path", async () => {
      taskRepo.count.mockImplementation((opts?: unknown) => (opts ? 2 : 3));
      execRepo.count.mockResolvedValue(1);
      executorRepo.count.mockImplementation((opts?: unknown) => (opts ? 3 : 3));

      const result = await service.getFullHealth();

      expect(result.status).toBe("healthy");
      expect(result.services.tasks).toEqual({
        status: "healthy",
        activeCount: 2,
        totalCount: 3,
        runningCount: 1,
      });
      expect(result.components.map((c) => c.name)).toEqual([
        "database",
        "redis",
        "queue",
        "executors",
        "tasks",
        "scheduler",
      ]);
    });
  });

  // WIKI-OPT-1: 判定阈值配置化（health.* 节）——改配置值须改变判定结果。
  describe("configurable thresholds", () => {
    it("queue degraded judgment follows the configured failed threshold", async () => {
      taskQueue.getFailedCount.mockResolvedValue(50);

      // 默认阈值 100 → 50 个 failed 仍 healthy
      const defaultResult = await service.checkQueue();
      expect(defaultResult.status).toBe("healthy");

      // 阈值降到 10 → 同样的积压判为 degraded
      service = await buildService({ "health.queueFailedMax": 10 });
      const tunedResult = await service.checkQueue();
      expect(tunedResult.status).toBe("degraded");
      expect(tunedResult.details).toContain("High queue backlog");
    });

    it("executor degraded judgment follows the configured online ratio minimum", async () => {
      executorRepo.count.mockImplementation((opts?: unknown) => (opts ? 1 : 3));

      // 默认比例下限 0.5 → 1/3 在线判为 degraded
      const defaultResult = await service.checkExecutors();
      expect(defaultResult.status).toBe("degraded");

      // 下限放宽到 0.2 → 1/3 在线判为 healthy
      service = await buildService({ "health.executorOnlineRatioMin": 0.2 });
      const tunedResult = await service.checkExecutors();
      expect(tunedResult.status).toBe("healthy");
    });
  });

  // WIKI-OPT-1: getFullHealth 短 TTL 缓存（health.cacheTtlMs，默认 0=关闭）；
  // live/ready 探针（getReadiness）不缓存。
  describe("full health cache (HEALTH_CACHE_TTL_MS)", () => {
    it("does not cache by default: every call recomputes", async () => {
      await service.getFullHealth();
      await service.getFullHealth();
      expect(taskQueue.getWaitingCount).toHaveBeenCalledTimes(2);
    });

    it("serves the cached response within the TTL window", async () => {
      service = await buildService({ "health.cacheTtlMs": 60000 });

      const first = await service.getFullHealth();
      expect(taskQueue.getWaitingCount).toHaveBeenCalledTimes(1);

      const second = await service.getFullHealth();
      expect(taskQueue.getWaitingCount).toHaveBeenCalledTimes(1);
      expect(second).toBe(first);
    });

    it("recomputes once the TTL window has elapsed", async () => {
      service = await buildService({ "health.cacheTtlMs": 1 });

      await service.getFullHealth();
      await new Promise((resolve) => setTimeout(resolve, 5));
      await service.getFullHealth();

      expect(taskQueue.getWaitingCount).toHaveBeenCalledTimes(2);
    });

    it("never caches readiness checks even when the cache is enabled", async () => {
      service = await buildService({ "health.cacheTtlMs": 60000 });

      await service.getReadiness();
      await service.getReadiness();

      expect(taskRepo.query).toHaveBeenCalledTimes(2);
    });
  });
});
