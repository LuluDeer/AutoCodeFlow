import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { EventEmitter } from "events";
// NETOPT-5②: 断言 createClient 收到的 TLS 入参
import { createClient } from "redis";
import { HealthService } from "../health.service";
import { Task } from "../../task/entities/task.entity";
import { Executor } from "../../executor/entities/executor.entity";
import { TaskExecution } from "../../task/entities/task-execution.entity";

// Mock the redis createClient so HealthService constructor doesn't open a real connection
//
// ARCH-008: `on` 必须存在——构造函数现在会注册 error 监听器（缺它就是击穿
// 进程的根因，见 health.service.ts 内注释）。若这里漏掉 `on`，本套件会在
// 构造期抛 "on is not a function"，恰好也起到守卫作用。
const mockRedisOn = jest.fn();
jest.mock("redis", () => ({
  createClient: jest.fn(() => ({
    isReady: false,
    connect: jest.fn().mockResolvedValue(undefined),
    ping: jest.fn().mockResolvedValue("PONG"),
    on: mockRedisOn,
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
  // NETOPT-5④: checkScheduler 改用 Redis 侧聚合的 getJobCounts（不再全量物化）
  getJobCounts: jest.fn().mockResolvedValue({ wait: 0, active: 1 }),
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
    // NETOPT-5④: 改用 getJobCounts 聚合统计，不再 getJobs 全量物化
    it("uses getJobCounts and reports the wait+active total", async () => {
      taskQueue.getJobCounts.mockResolvedValue({ wait: 2, active: 0 });
      const result = await service.checkScheduler();
      expect(taskQueue.getJobCounts).toHaveBeenCalledWith("wait", "active");
      expect(result.status).toBe("healthy");
      expect(result.details).toContain("2 jobs");
    });

    it("tolerates null count fields from BullMQ (redis-side aggregation)", async () => {
      taskQueue.getJobCounts.mockResolvedValue({ wait: null, active: null });
      const result = await service.checkScheduler();
      expect(result.status).toBe("healthy");
      expect(result.details).toContain("0 jobs");
    });

    it("returns unhealthy when getJobCounts throws", async () => {
      taskQueue.getJobCounts.mockRejectedValue(new Error("queue error"));
      const result = await service.checkScheduler();
      expect(result.status).toBe("unhealthy");
      expect(result.details).toContain("queue error");
    });
  });

  // R-25（DEEP_REVIEW 0ef3bbe）：公开健康端点不得暴露 executor 在线数、
  // 队列深度、任务计数等内部运维指标——只返回 status + timestamp。
  describe("getPublicHealth (R-25)", () => {
    it("returns only status and timestamp, no sensitive fields", async () => {
      taskRepo.count.mockImplementation((opts?: unknown) => (opts ? 2 : 3));
      execRepo.count.mockResolvedValue(1);
      executorRepo.count.mockImplementation((opts?: unknown) => (opts ? 3 : 3));
      taskQueue.getFailedCount.mockResolvedValue(0);
      taskQueue.getWaitingCount.mockResolvedValue(0);

      const result = await service.getPublicHealth();

      expect(result).toEqual({
        status: expect.any(String),
        timestamp: expect.any(String),
      });
      // 断言不包含任何敏感字段
      expect(result).not.toHaveProperty("services");
      expect(result).not.toHaveProperty("metrics");
      expect(result).not.toHaveProperty("components");
      expect(result).not.toHaveProperty("onlineExecutors");
      expect(result).not.toHaveProperty("queueSize");
      expect(result).not.toHaveProperty("totalExecutors");
    });

    it("returns degraded status when components are degraded", async () => {
      executorRepo.count.mockImplementation((opts?: unknown) => (opts ? 1 : 3));

      const result = await service.getPublicHealth();

      expect(result.status).toBe("degraded");
      expect(result).not.toHaveProperty("services");
    });

    it("propagates unhealthy status", async () => {
      taskRepo.count.mockRejectedValue(new Error("db down"));

      const result = await service.getPublicHealth();

      expect(result.status).toBe("unhealthy");
      expect(result).not.toHaveProperty("metrics");
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

  // ============================================================================
  // NETOPT-5②/④: redis TLS 透传 + 公开拨测缓存。
  // ============================================================================
  describe("redis client TLS passthrough (NETOPT-5②)", () => {
    it("passes socket.tls + rejectUnauthorized when redis.tls=true", async () => {
      await buildService({
        "redis.tls": true,
        "redis.tlsRejectUnauthorized": false,
      });
      const mocked = jest.mocked(createClient);
      const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1][0] as {
        socket?: { tls?: boolean; rejectUnauthorized?: boolean };
      };
      expect(lastCall.socket).toEqual({
        tls: true,
        rejectUnauthorized: false,
      });
    });

    it("rejectUnauthorized defaults to true (self-signed must opt out explicitly)", async () => {
      await buildService({ "redis.tls": true });
      const mocked = jest.mocked(createClient);
      const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1][0] as {
        socket?: { tls?: boolean; rejectUnauthorized?: boolean };
      };
      expect(lastCall.socket).toEqual({ tls: true, rejectUnauthorized: true });
    });

    it("builds a plain (no socket override) client when redis.tls is off", async () => {
      await buildService({});
      const mocked = jest.mocked(createClient);
      const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1][0] as {
        socket?: unknown;
      };
      expect(lastCall.socket).toBeUndefined();
    });
  });

  // ============================================================================
  // ARCH-008: 健康检查 Redis 客户端**必须**注册 error 监听器。
  //
  // 这是本仓最严重的一次生产事故的根因锁定测试：node-redis 的
  // `RedisClient extends EventEmitter`，而 EventEmitter 在**无 'error'
  // 监听器**时 `emit('error')` 会直接 throw。socket 一断即变成进程级
  // uncaughtException → main.ts gracefulFatalShutdown → exit(1)，整个
  // admin-api 消失（生产实测两次全站 502）。
  //
  // 为什么只有此处致命（另两处 ioredis 客户端同样"忘了挂"却没事）：ioredis
  // 自带 silentEmit 保护——无监听器时只 console.error 后返回、不 throw；
  // node-redis 没有这层保护。故本断言不可省。
  // ============================================================================
  describe("ARCH-008: redis error listener (进程级存活红线)", () => {
    it("构造时注册 'error' 监听器（缺它 = Redis 抖动即整实例退出）", async () => {
      mockRedisOn.mockClear();
      await buildService({});
      const errorRegistrations = mockRedisOn.mock.calls.filter(
        (c) => c[0] === "error",
      );
      expect(errorRegistrations).toHaveLength(1);
      expect(typeof errorRegistrations[0][1]).toBe("function");
    });

    it("监听器本身不抛——回调可安全接收 Error（否则等于没挂）", async () => {
      mockRedisOn.mockClear();
      await buildService({});
      const handler = mockRedisOn.mock.calls.find(
        (c) => c[0] === "error",
      )?.[1] as (err: Error) => void;
      // 真实场景：socket 断开时 node-redis 传入一个 Error。回调必须吞掉它，
      // 而不是二次抛出（那会让"已挂监听器"形同虚设）。
      expect(() => handler(new Error("socket closed"))).not.toThrow();
    });

    it("EventEmitter 无监听器时 emit('error') 确实会 throw（根因成立的证明）", () => {
      // 直接用原生 EventEmitter 证明机制，不依赖对 node-redis 内部行为的假设：
      // 这是"没挂监听器 → 进程崩溃"这条因果链的最小复现。
      const bare = new EventEmitter();
      expect(() => bare.emit("error", new Error("boom"))).toThrow("boom");
      // 挂了监听器之后不再抛——正是本修复的作用
      const guarded = new EventEmitter();
      guarded.on("error", () => undefined);
      expect(() => guarded.emit("error", new Error("boom"))).not.toThrow();
    });
  });

  describe("public health cache (NETOPT-5④, HEALTH_PUBLIC_CACHE_TTL_MS)", () => {
    it("caches the status/timestamp projection by default (5s window)", async () => {
      const first = await service.getPublicHealth();
      const second = await service.getPublicHealth();
      // 第二次命中缓存：DB SELECT 1 只跑一次
      expect(taskRepo.query).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
      // R-25 语义不变：仍只有 status + timestamp
      expect(Object.keys(second).sort()).toEqual(["status", "timestamp"]);
    });

    it("recomputes after the public TTL window elapses", async () => {
      service = await buildService({ "health.publicCacheTtlMs": 1 });
      await service.getPublicHealth();
      await new Promise((resolve) => setTimeout(resolve, 5));
      await service.getPublicHealth();
      expect(taskRepo.query).toHaveBeenCalledTimes(2);
    });

    it("can be disabled with publicCacheTtlMs=0 (recomputes every call)", async () => {
      service = await buildService({ "health.publicCacheTtlMs": 0 });
      await service.getPublicHealth();
      await service.getPublicHealth();
      expect(taskRepo.query).toHaveBeenCalledTimes(2);
    });
  });
});
