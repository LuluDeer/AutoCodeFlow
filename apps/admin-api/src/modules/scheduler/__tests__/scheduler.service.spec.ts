import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { getQueueToken } from "@nestjs/bullmq";
import {
  SchedulerService,
  computeTriggerDedupTtlMs,
  TRIGGER_DEDUP_MIN_TTL_MS,
  TRIGGER_DEDUP_JITTER_BUFFER_MS,
} from "../scheduler.service";
import { SchedulerMetricsService } from "../scheduler-metrics.service";
import {
  Task,
  TaskStatus,
  TaskTriggerType,
  BlockStrategy,
  MisfireStrategy,
  TaskPriority,
} from "../../task/entities/task.entity";
import {
  TaskExecution,
  ExecutionStatus,
  ExecutionFailureReason,
} from "../../task/entities/task-execution.entity";
import { DataSource } from "typeorm";
import * as nodeCron from "node-cron";
import { RedisLockService } from "../../../common/services/redis-lock.service";

const mockRepo = () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  save: jest.fn(),
  create: jest.fn(),
  findBy: jest.fn(),
  update: jest.fn().mockResolvedValue({ affected: 1 }),
  createQueryBuilder: jest.fn(),
});

const mockQueue = () => ({
  add: jest.fn().mockResolvedValue({ id: "job-1" }),
  getJobCounts: jest.fn().mockResolvedValue({
    waiting: 0,
    active: 0,
    delayed: 0,
    failed: 0,
    completed: 0,
  }),
});

const mockRedisLock = () => ({
  acquireLock: jest.fn(),
  extendLock: jest.fn().mockResolvedValue(true),
  releaseLock: jest.fn().mockResolvedValue(true),
});

const mockDataSource = () => ({
  createQueryBuilder: jest.fn(() => ({
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  })),
  transaction: jest.fn(),
});

const makeTask = (overrides: Partial<Task> = {}): Task =>
  ({
    id: "task-1",
    name: "Test Task",
    status: TaskStatus.ACTIVE,
    triggerType: TaskTriggerType.CRON,
    cronExpression: "* * * * *",
    fixedRate: null,
    blockStrategy: BlockStrategy.SERIAL,
    misfireStrategy: MisfireStrategy.IGNORE,
    maxRetry: 3,
    retryDelay: 5,
    priority: 2,
    params: {},
    currentVersion: 1,
    lastTriggerTime: null,
    ...overrides,
  }) as unknown as Task;

/** 构造 UPDATE ... RETURNING 风格的 QueryBuilder mock */
const makeUpdateQb = (result: { affected: number; raw?: unknown[] }) => {
  const qb: Record<string, jest.Mock> = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    returning: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue(result),
  };
  return qb;
};

describe("SchedulerService", () => {
  let service: SchedulerService;
  let taskRepo: ReturnType<typeof mockRepo>;
  let execRepo: ReturnType<typeof mockRepo>;
  let queue: ReturnType<typeof mockQueue>;
  let redisLockService: ReturnType<typeof mockRedisLock>;
  let dataSource: ReturnType<typeof mockDataSource>;
  let metrics: SchedulerMetricsService;

  const makeLeader = async () => {
    redisLockService.acquireLock.mockResolvedValueOnce({
      key: "scheduler:leader",
      lockId: "leader-lock-id",
      ttlMs: 30000,
      released: false,
      release: jest.fn().mockResolvedValue(true),
    });
    await service.initLeaderElection();
    expect(service.getStats().isLeader).toBe(true);
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchedulerService,
        SchedulerMetricsService,
        { provide: getRepositoryToken(Task), useFactory: mockRepo },
        { provide: getRepositoryToken(TaskExecution), useFactory: mockRepo },
        { provide: getQueueToken("task-queue"), useFactory: mockQueue },
        { provide: RedisLockService, useFactory: mockRedisLock },
        { provide: DataSource, useFactory: mockDataSource },
      ],
    }).compile();

    service = module.get<SchedulerService>(SchedulerService);
    taskRepo = module.get(getRepositoryToken(Task));
    execRepo = module.get(getRepositoryToken(TaskExecution));
    queue = module.get(getQueueToken("task-queue"));
    redisLockService = module.get(RedisLockService);
    dataSource = module.get(DataSource);
    metrics = module.get(SchedulerMetricsService);
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.clearAllMocks();
  });

  describe("leader election (TASK-006)", () => {
    it("should become leader when the leader lock is acquired", async () => {
      await makeLeader();
      expect(service.getStats().isLeader).toBe(true);
      expect(redisLockService.acquireLock).toHaveBeenCalledWith(
        "scheduler:leader",
        expect.any(Number),
      );
    });

    it("stays follower when the leader lock is held by another instance", async () => {
      redisLockService.acquireLock.mockResolvedValue(null);
      await service.initLeaderElection();
      expect(service.getStats().isLeader).toBe(false);
    });

    it("degrades to leader (fail-open) when Redis throws, then re-contends later", async () => {
      redisLockService.acquireLock.mockRejectedValue(
        new Error("Redis connection down"),
      );
      await service.initLeaderElection();
      // 降级行为：调度不停摆，按 Leader 运行
      expect(service.getStats().isLeader).toBe(true);

      // Redis 恢复且锁被其他实例持有 → 让位
      redisLockService.acquireLock.mockResolvedValue(null);
      await service.initLeaderElection();
      expect(service.getStats().isLeader).toBe(false);
    });

    it("non-leader skips scan ticks: reload / checkMisfires / recoverStaleExecutions", async () => {
      redisLockService.acquireLock.mockResolvedValue(null);
      await service.initLeaderElection();

      await service.reload();
      await service.checkMisfires();
      await service.recoverStaleExecutions();

      expect(taskRepo.find).not.toHaveBeenCalled();
      expect(execRepo.find).not.toHaveBeenCalled();
      expect(service.getStats().activeTimers).toBe(0);
      expect(service.getStats().activeCronTasks).toBe(0);
    });

    it("non-leader skips scheduleOne registration but leader registers", async () => {
      redisLockService.acquireLock.mockResolvedValue(null);
      await service.initLeaderElection();
      const task = makeTask({
        triggerType: TaskTriggerType.CRON,
        cronExpression: "0 * * * *",
      });
      await service.scheduleOne(task);
      expect(service.getStats().activeCronTasks).toBe(0);

      await makeLeader();
      await service.scheduleOne(task);
      expect(service.getStats().activeCronTasks).toBe(1);
    });

    it("demotes when the leader lease is lost (extendLock returns false)", async () => {
      await makeLeader();
      const task = makeTask({
        triggerType: TaskTriggerType.FIXED_RATE,
        fixedRate: 60,
        cronExpression: null,
      });
      await service.scheduleOne(task);
      expect(service.getStats().activeTimers).toBe(1);

      // 租约被其它实例接管 → demote 后清空本地调度并重新参与竞选
      redisLockService.extendLock.mockResolvedValue(false);
      await (service as any).verifyLeadership();

      expect(service.getStats().isLeader).toBe(false);
      expect(service.getStats().activeTimers).toBe(0);
    });

    it("keeps leadership when the lease check hits a redis hiccup (extendLock throws)", async () => {
      await makeLeader();
      redisLockService.extendLock.mockRejectedValue(new Error("timeout"));
      await (service as any).verifyLeadership();
      expect(service.getStats().isLeader).toBe(true);
    });

    it("only one instance wins the leader lock when two contend (redis-backed)", async () => {
      // 模拟两个实例串行竞选：Redis SET NX 保证只有一个 OK
      const results: boolean[] = [];
      redisLockService.acquireLock.mockImplementation(async () => {
        // 第一次调用成功，后续全部失败（锁已被占用）
        if (results.length === 0) {
          results.push(true);
          return {
            key: "scheduler:leader",
            lockId: "instance-a",
            ttlMs: 30000,
            released: false,
            release: jest.fn().mockResolvedValue(true),
          };
        }
        results.push(false);
        return null;
      });

      const instanceA = service;
      await instanceA.initLeaderElection();

      const moduleB: TestingModule = await Test.createTestingModule({
        providers: [
          SchedulerService,
          SchedulerMetricsService,
          { provide: getRepositoryToken(Task), useFactory: mockRepo },
          { provide: getRepositoryToken(TaskExecution), useFactory: mockRepo },
          { provide: getQueueToken("task-queue"), useFactory: mockQueue },
          { provide: RedisLockService, useFactory: mockRedisLock },
          { provide: DataSource, useFactory: mockDataSource },
        ],
      }).compile();
      const instanceB = moduleB.get<SchedulerService>(SchedulerService);
      try {
        await instanceB.initLeaderElection();

        expect(instanceA.getStats().isLeader).toBe(true);
        expect(instanceB.getStats().isLeader).toBe(false);

        // 只有 Leader 注册调度
        const task = makeTask({
          triggerType: TaskTriggerType.CRON,
          cronExpression: "0 * * * *",
        });
        taskRepo.find.mockResolvedValue([task]);
        await instanceA.reload();
        await instanceB.reload();
        expect(instanceA.getStats().activeCronTasks).toBe(1);
        expect(instanceB.getStats().activeCronTasks).toBe(0);
      } finally {
        instanceB.onModuleDestroy();
      }
    });
  });

  describe("claimTaskTrigger — DB conditional claim (TASK-006)", () => {
    /**
     * 构造"两个实例并发扫描"场景：Redis 锁服务不可用（两实例都走 DB claim
     * 兜底路径），数据库行级条件 UPDATE 保证只有一个实例 claim 成功。
     */
    const setupConcurrentClaim = (task: Task, winner: "first" | "second") => {
      redisLockService.acquireLock.mockRejectedValue(new Error("redis down"));
      let calls = 0;
      taskRepo.createQueryBuilder.mockImplementation(() =>
        makeUpdateQb({
          affected: (calls += 1) === (winner === "first" ? 1 : 2) ? 1 : 0,
        }),
      );
      // claim 成功后 enqueue 的正常路径
      taskRepo.findOne.mockResolvedValue(task);
      const exec = {
        id: "exec-1",
        status: ExecutionStatus.PENDING,
      } as TaskExecution;
      execRepo.create.mockReturnValue(exec);
      execRepo.save.mockResolvedValue(exec);
    };

    it("two instances claim concurrently — exactly one wins and enqueues", async () => {
      await makeLeader();
      const task = makeTask();
      setupConcurrentClaim(task, "first");

      const [resultA, resultB] = await Promise.all([
        service.enqueue(task, "cron"),
        service.enqueue({ ...task }, "cron"),
      ]);

      const winners = [resultA, resultB].filter(Boolean);
      expect(winners).toHaveLength(1);
      expect(winners[0]).toEqual(execRepo.create.mock.results[0].value);
      expect(queue.add).toHaveBeenCalledTimes(1);
    });

    it("the losing instance skips without creating any execution", async () => {
      await makeLeader();
      const task = makeTask();
      setupConcurrentClaim(task, "second");
      // 直接验证 claim 失败即跳过：条件 UPDATE 返回 affected=0
      taskRepo.createQueryBuilder.mockImplementation(() =>
        makeUpdateQb({ affected: 0 }),
      );

      const result = await service.enqueue(task, "cron");
      expect(result).toBeNull();
      expect(queue.add).not.toHaveBeenCalled();
      expect(execRepo.create).not.toHaveBeenCalled();
    });

    it("db claim UPDATE is guarded by status=ACTIVE and the trigger window", async () => {
      await makeLeader();
      const task = makeTask();
      redisLockService.acquireLock.mockRejectedValue(new Error("redis down"));
      taskRepo.createQueryBuilder.mockImplementation(() =>
        makeUpdateQb({ affected: 0 }),
      );

      await service.enqueue(task, "cron");

      const qb = taskRepo.createQueryBuilder.mock.results[0].value;
      expect(qb.where).toHaveBeenCalledWith(
        expect.stringContaining('"status" = :status'),
        expect.objectContaining({ status: TaskStatus.ACTIVE }),
      );
      expect(qb.where).toHaveBeenCalledWith(
        expect.stringContaining('"lastTriggerTime"'),
        expect.objectContaining({ windowStart: expect.any(Date) }),
      );
      expect(qb.set).toHaveBeenCalledWith(
        expect.objectContaining({ lastTriggerTime: expect.any(Date) }),
      );
    });

    it("keeps using the redis trigger lock (no db claim) when redis is healthy", async () => {
      await makeLeader();
      const task = makeTask();
      redisLockService.acquireLock.mockResolvedValueOnce({
        key: `task:trigger:${task.id}`,
        lockId: "l1",
        ttlMs: 5000,
        released: false,
        release: jest.fn().mockResolvedValue(true),
      });
      taskRepo.findOne.mockResolvedValue(task);
      const exec = {
        id: "exec-1",
        status: ExecutionStatus.PENDING,
      } as TaskExecution;
      execRepo.create.mockReturnValue(exec);
      execRepo.save.mockResolvedValue(exec);

      await service.enqueue(task, "manual");
      expect(taskRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalled();
      // R4-P0: the trigger dedup lock must NOT be renewed by a watchdog —
      // it is never released and its TTL is the dedup window, so renewal
      // would permanently suppress every later trigger of the task.
      expect(redisLockService.acquireLock).toHaveBeenCalledWith(
        `task:trigger:${task.id}`,
        expect.any(Number),
        { renew: false },
      );
      // ...while the leader lease keeps the default (renewing) behaviour.
      expect(redisLockService.acquireLock).toHaveBeenCalledWith(
        "scheduler:leader",
        expect.any(Number),
      );
    });
  });

  describe("getStats", () => {
    it("should return healthy stats with zero counts initially", () => {
      const stats = service.getStats();
      expect(stats.healthy).toBe(true);
      expect(stats.activeTimers).toBe(0);
      expect(stats.activeCronTasks).toBe(0);
      expect(stats.runningTaskCount).toBe(0);
      expect(stats.totalScheduledTasks).toBe(0);
      expect(stats.uptime).toBeGreaterThanOrEqual(0);
    });
  });

  describe("stop", () => {
    it("should not throw when stopping a task that was never scheduled", () => {
      expect(() => service.stop("nonexistent")).not.toThrow();
    });
  });

  describe("onModuleDestroy", () => {
    it("should not throw when no timers or cron tasks are active", () => {
      expect(() => service.onModuleDestroy()).not.toThrow();
    });

    it("releases the leader lock on shutdown", async () => {
      const release = jest.fn().mockResolvedValue(true);
      redisLockService.acquireLock.mockResolvedValueOnce({
        key: "scheduler:leader",
        lockId: "leader-lock-id",
        ttlMs: 30000,
        released: false,
        release,
      });
      await service.initLeaderElection();
      await service.onModuleDestroy();
      expect(release).toHaveBeenCalled();
      expect(service.getStats().isLeader).toBe(false);
    });
  });

  describe("checkMisfires", () => {
    it("should skip tasks without lastTriggerTime", async () => {
      await makeLeader();
      const task = makeTask({ lastTriggerTime: null });
      taskRepo.find.mockResolvedValue([task]);
      await expect(service.checkMisfires()).resolves.not.toThrow();
    });

    it("should fire once for FIRE_ONCE misfire strategy", async () => {
      await makeLeader();
      const oldTime = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
      const task = makeTask({
        triggerType: TaskTriggerType.FIXED_RATE,
        fixedRate: 60,
        misfireStrategy: MisfireStrategy.FIRE_ONCE,
        lastTriggerTime: oldTime,
      });
      taskRepo.find.mockResolvedValue([task]);

      const lock = { release: jest.fn().mockResolvedValue(undefined) };
      redisLockService.acquireLock.mockResolvedValue(lock);
      taskRepo.findOne.mockResolvedValue(task);
      execRepo.findOne.mockResolvedValue(null);
      const exec = {
        id: "exec-1",
        status: ExecutionStatus.PENDING,
      } as TaskExecution;
      execRepo.create.mockReturnValue(exec);
      execRepo.save.mockResolvedValue(exec);

      await service.checkMisfires();
      expect(queue.add).toHaveBeenCalled();
    });

    it("should ignore misfire when strategy is IGNORE", async () => {
      await makeLeader();
      const oldTime = new Date(Date.now() - 10 * 60 * 1000);
      const task = makeTask({
        triggerType: TaskTriggerType.FIXED_RATE,
        fixedRate: 60,
        misfireStrategy: MisfireStrategy.IGNORE,
        lastTriggerTime: oldTime,
      });
      taskRepo.find.mockResolvedValue([task]);
      await service.checkMisfires();
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  describe("enqueue", () => {
    it("should return null when lock cannot be acquired", async () => {
      await makeLeader();
      redisLockService.acquireLock.mockResolvedValue(null);
      const task = makeTask();
      const result = await service.enqueue(task, "manual");
      expect(result).toBeNull();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("should return null when task is no longer active", async () => {
      await makeLeader();
      const lock = { release: jest.fn().mockResolvedValue(undefined) };
      redisLockService.acquireLock.mockResolvedValue(lock);
      taskRepo.findOne.mockResolvedValue(null);
      const task = makeTask();
      const result = await service.enqueue(task, "manual");
      expect(result).toBeNull();
      // P1: the dedup lock is deliberately NOT released — its TTL is the
      // dedup window across instances.
      expect(lock.release).not.toHaveBeenCalled();
    });

    it("should enqueue task and return execution when all checks pass", async () => {
      await makeLeader();
      const lock = { release: jest.fn().mockResolvedValue(undefined) };
      redisLockService.acquireLock.mockResolvedValue(lock);
      const task = makeTask({ blockStrategy: BlockStrategy.SERIAL });
      taskRepo.findOne.mockResolvedValue(task);
      const exec = {
        id: "exec-1",
        status: ExecutionStatus.PENDING,
      } as TaskExecution;
      execRepo.create.mockReturnValue(exec);
      execRepo.save.mockResolvedValue(exec);

      const result = await service.enqueue(task, "manual");
      expect(result).toEqual(exec);
      expect(queue.add).toHaveBeenCalledWith(
        "execute",
        { executionId: "exec-1", task },
        expect.any(Object),
      );
      // P1: not released on success either — TTL-based dedup, see enqueue.
      expect(lock.release).not.toHaveBeenCalled();
    });

    it("should skip and return null when blockStrategy=DISCARD and task is running", async () => {
      await makeLeader();
      const lock = { release: jest.fn().mockResolvedValue(undefined) };
      redisLockService.acquireLock.mockResolvedValue(lock);
      const task = makeTask({ blockStrategy: BlockStrategy.DISCARD });
      taskRepo.findOne.mockResolvedValue(task);
      const runningExec = {
        id: "running-1",
        status: ExecutionStatus.RUNNING,
        executorAddress: "host:3002",
      } as TaskExecution;
      execRepo.findOne.mockResolvedValue(runningExec);

      const result = await service.enqueue(task, "cron");
      expect(result).toBeNull();
      expect(queue.add).not.toHaveBeenCalled();
      expect(dataSource.createQueryBuilder).not.toHaveBeenCalled();
      // P1: not released on skip — TTL-based dedup, see enqueue.
      expect(lock.release).not.toHaveBeenCalled();
    });

    it("should cancel running execution when blockStrategy=COVER_EARLY", async () => {
      await makeLeader();
      const lock = { release: jest.fn().mockResolvedValue(undefined) };
      redisLockService.acquireLock.mockResolvedValue(lock);
      const task = makeTask({ blockStrategy: BlockStrategy.COVER_EARLY });
      taskRepo.findOne.mockResolvedValue(task);
      const runningExec = {
        id: "running-1",
        status: ExecutionStatus.RUNNING,
        executorAddress: "host:3002",
        errorMessage: null,
        endTime: null,
      } as unknown as TaskExecution;
      execRepo.findOne.mockResolvedValue(runningExec);
      const newExec = { id: "exec-2" } as TaskExecution;
      execRepo.create.mockReturnValue(newExec);
      execRepo.save.mockResolvedValue(newExec);
      // R4-P1: the cover transition is a conditional UPDATE ... RETURNING
      execRepo.createQueryBuilder.mockReturnValue(
        makeUpdateQb({
          affected: 1,
          raw: [{ id: "running-1", executorAddress: "host:3002" }],
        }),
      );

      await service.enqueue(task, "cron");
      const coverQb = execRepo.createQueryBuilder.mock.results[0].value;
      expect(coverQb.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: ExecutionStatus.CANCELLED }),
      );
      expect(coverQb.where).toHaveBeenCalledWith(
        expect.stringContaining('"status" IN (:...open)'),
        expect.objectContaining({
          open: [ExecutionStatus.PENDING, ExecutionStatus.RUNNING],
        }),
      );
      expect(coverQb.returning).toHaveBeenCalledWith(["id", "executorAddress"]);
      // No blind entity save anymore; slot released exactly once via RETURNING.
      expect(execRepo.save).not.toHaveBeenCalledWith(runningExec);
      expect(dataSource.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalled();
    });

    it("COVER_EARLY must not cover an execution whose callback already finished it (R4-P1)", async () => {
      await makeLeader();
      const lock = { release: jest.fn().mockResolvedValue(undefined) };
      redisLockService.acquireLock.mockResolvedValue(lock);
      const task = makeTask({ blockStrategy: BlockStrategy.COVER_EARLY });
      taskRepo.findOne.mockResolvedValue(task);
      const runningExec = {
        id: "running-1",
        status: ExecutionStatus.RUNNING,
        executorAddress: "host:3002",
        errorMessage: null,
        endTime: null,
      } as unknown as TaskExecution;
      execRepo.findOne.mockResolvedValue(runningExec);
      const newExec = { id: "exec-2" } as TaskExecution;
      execRepo.create.mockReturnValue(newExec);
      execRepo.save.mockResolvedValue(newExec);
      // Concurrent callback already moved the row to SUCCESS: the guarded
      // UPDATE hits nothing (affected=0, no RETURNING rows).
      execRepo.createQueryBuilder.mockReturnValue(
        makeUpdateQb({ affected: 0, raw: [] }),
      );

      await service.enqueue(task, "cron");

      // No slot release — the callback path already released it exactly once.
      expect(dataSource.createQueryBuilder).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalled();
      expect(execRepo.save).not.toHaveBeenCalledWith(runningExec);
    });
  });

  describe("reload", () => {
    it("should schedule a cron task for an active CRON task", async () => {
      await makeLeader();
      const task = makeTask({
        triggerType: TaskTriggerType.CRON,
        cronExpression: "0 * * * *",
      });
      taskRepo.find.mockResolvedValue([task]);
      await service.reload();
      const stats = service.getStats();
      expect(stats.activeCronTasks).toBe(1);
    });

    it("should pass timezone option when scheduling cron task on reload", async () => {
      await makeLeader();
      const scheduleSpy = jest.spyOn(nodeCron, "schedule");
      const task = makeTask({
        triggerType: TaskTriggerType.CRON,
        cronExpression: "0 * * * *",
        timezone: "Asia/Shanghai",
      });
      taskRepo.find.mockResolvedValue([task]);
      await service.reload();
      expect(scheduleSpy).toHaveBeenCalledWith(
        "0 * * * *",
        expect.any(Function),
        { timezone: "Asia/Shanghai" },
      );
      scheduleSpy.mockRestore();
    });

    it("should skip cron task with invalid expression", async () => {
      await makeLeader();
      const task = makeTask({
        triggerType: TaskTriggerType.CRON,
        cronExpression: "not-valid-cron",
      });
      taskRepo.find.mockResolvedValue([task]);
      await service.reload();
      const stats = service.getStats();
      expect(stats.activeCronTasks).toBe(0);
    });

    it("should fall back to server timezone when task timezone is invalid", async () => {
      await makeLeader();
      const scheduleSpy = jest.spyOn(nodeCron, "schedule");
      const task = makeTask({
        triggerType: TaskTriggerType.CRON,
        cronExpression: "0 * * * *",
        timezone: "Not/AZone",
      });
      taskRepo.find.mockResolvedValue([task]);
      await service.reload();
      expect(scheduleSpy).toHaveBeenCalledWith(
        "0 * * * *",
        expect.any(Function),
        undefined,
      );
      scheduleSpy.mockRestore();
    });

    it("should schedule a fixed_rate task", async () => {
      await makeLeader();
      const task = makeTask({
        triggerType: TaskTriggerType.FIXED_RATE,
        fixedRate: 300,
        cronExpression: null,
      });
      taskRepo.find.mockResolvedValue([task]);
      await service.reload();
      const stats = service.getStats();
      expect(stats.activeTimers).toBe(1);
    });

    it("should stop removed tasks on reload", async () => {
      await makeLeader();
      // First reload registers the task
      const task = makeTask({
        triggerType: TaskTriggerType.CRON,
        cronExpression: "0 * * * *",
      });
      taskRepo.find.mockResolvedValue([task]);
      await service.reload();
      expect(service.getStats().activeCronTasks).toBe(1);

      // Second reload with empty list should stop it
      taskRepo.find.mockResolvedValue([]);
      await service.reload();
      expect(service.getStats().activeCronTasks).toBe(0);
    });

    it("should not register the same task twice when reload and scheduleOne overlap (TASK-003)", async () => {
      await makeLeader();
      const task = makeTask({
        triggerType: TaskTriggerType.CRON,
        cronExpression: "0 * * * *",
      });
      taskRepo.find.mockResolvedValue([task]);

      const reloadPromise = service.reload();
      const schedulePromise = service.scheduleOne(task);
      await Promise.all([reloadPromise, schedulePromise]);

      expect(service.getStats().activeCronTasks).toBe(1);
    });

    it("concurrent reload + scheduleOne for many tasks never double-registers (TASK-003)", async () => {
      await makeLeader();
      const tasks = Array.from({ length: 5 }, (_, i) =>
        makeTask({
          id: `task-${i}`,
          triggerType: TaskTriggerType.CRON,
          cronExpression: "0 * * * *",
        }),
      );
      taskRepo.find.mockResolvedValue(tasks);

      await Promise.all([
        service.reload(),
        ...tasks.map((t) => service.scheduleOne(t)),
        service.reload(),
        ...tasks.map((t) => service.scheduleOne(t)),
      ]);

      expect(service.getStats().activeCronTasks).toBe(5);
    });
  });

  describe("recoverStaleExecutions (TASK-004 batch update)", () => {
    it("recovers stale RUNNING executions with a single transactional batch UPDATE", async () => {
      await makeLeader();
      const staleExec = {
        id: "exec-stale",
        taskId: "task-1",
        status: ExecutionStatus.RUNNING,
        startTime: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
        executorAddress: "host:3002",
        errorMessage: null,
        endTime: null,
      };
      execRepo.find
        .mockResolvedValueOnce([staleExec]) // RUNNING scan
        .mockResolvedValueOnce([]); // PENDING scan
      taskRepo.find.mockResolvedValue([]); // N5 cutoff probe: no timed tasks
      taskRepo.findBy.mockResolvedValue([]);
      // 事务管理器：UPDATE ... RETURNING 命中该行
      dataSource.transaction.mockImplementation(async (fn: any) =>
        fn({
          createQueryBuilder: () =>
            makeUpdateQb({
              affected: 1,
              raw: [{ id: "exec-stale", executorAddress: "host:3002" }],
            }),
        }),
      );

      await service.recoverStaleExecutions();

      // 批量路径：不再逐行 save
      expect(execRepo.save).not.toHaveBeenCalled();
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      // 仅对 RETURNING 命中的行释放 executor 槽位
      expect(dataSource.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it("uses per-task timeout bucket with TIMEOUT failure reason in batch UPDATE", async () => {
      await makeLeader();
      const staleExec = {
        id: "exec-timeout",
        taskId: "task-2",
        status: ExecutionStatus.RUNNING,
        startTime: new Date(Date.now() - 20 * 60 * 1000), // 20 min ago (N5: threshold = max(2×300s, 60s) = 10 min)
        executorAddress: "host:3002",
        errorMessage: null,
        endTime: null,
      };
      execRepo.find
        .mockResolvedValueOnce([staleExec])
        .mockResolvedValueOnce([]);
      // N5: the ACTIVE-task cutoff probe must not disturb the RUNNING scan.
      taskRepo.find.mockResolvedValue([]);
      taskRepo.findBy.mockResolvedValue([
        makeTask({ id: "task-2", timeout: 300 }),
      ]);
      const updateQb = makeUpdateQb({
        affected: 1,
        raw: [{ id: "exec-timeout", executorAddress: "host:3002" }],
      });
      dataSource.transaction.mockImplementation(async (fn: any) =>
        fn({ createQueryBuilder: () => updateQb }),
      );

      await service.recoverStaleExecutions();

      // 条件 UPDATE 保留终态保护语义：仅 open 状态可被置 FAILED
      expect(updateQb.where).toHaveBeenCalledWith(
        expect.stringContaining('"status" IN (:...open)'),
        expect.objectContaining({
          open: [ExecutionStatus.PENDING, ExecutionStatus.RUNNING],
        }),
      );
      expect(updateQb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: ExecutionStatus.FAILED,
          failureReason: ExecutionFailureReason.TIMEOUT,
        }),
      );
    });

    it("should NOT touch fresh executions (within task timeout) — no transaction at all", async () => {
      await makeLeader();
      const freshExec = {
        id: "exec-fresh",
        taskId: "task-3",
        status: ExecutionStatus.RUNNING,
        startTime: new Date(Date.now() - 2 * 60 * 1000), // 2 min ago
        executorAddress: "host:3002",
      };
      execRepo.find
        .mockResolvedValueOnce([freshExec])
        .mockResolvedValueOnce([]);
      taskRepo.find.mockResolvedValue([
        makeTask({ id: "task-3", timeout: 600 }),
      ]);
      taskRepo.findBy.mockResolvedValue([
        makeTask({ id: "task-3", timeout: 600 }),
      ]);

      await service.recoverStaleExecutions();

      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(execRepo.save).not.toHaveBeenCalled();
      expect(dataSource.createQueryBuilder).not.toHaveBeenCalled();
    });

    it("sweeps never-dispatched PENDING executions with one conditional batch UPDATE", async () => {
      await makeLeader();
      const stalePending = {
        id: "exec-pending",
        taskId: "task-1",
        status: ExecutionStatus.PENDING,
        createdAt: new Date(Date.now() - 20 * 60 * 1000), // 20 min ago
      };
      execRepo.find
        .mockResolvedValueOnce([]) // RUNNING scan empty
        .mockResolvedValueOnce([stalePending]);
      taskRepo.find.mockResolvedValue([]); // N5 cutoff probe
      const pendingQb = makeUpdateQb({
        affected: 1,
        raw: [{ id: "exec-pending" }],
      });
      execRepo.createQueryBuilder.mockReturnValue(pendingQb);

      await service.recoverStaleExecutions();

      expect(pendingQb.where).toHaveBeenCalledWith(
        expect.stringContaining('"status" = :status'),
        expect.objectContaining({ status: ExecutionStatus.PENDING }),
      );
      expect(pendingQb.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: ExecutionStatus.FAILED }),
      );
    });

    it("does nothing when no running executions exist", async () => {
      await makeLeader();
      execRepo.find.mockResolvedValue([]);
      taskRepo.find.mockResolvedValue([]); // N5 cutoff probe
      await service.recoverStaleExecutions();
      expect(execRepo.save).not.toHaveBeenCalled();
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it("N5: scans with a cutoff of max(2×taskTimeout, 60s) for short-timeout tasks", async () => {
      await makeLeader();
      execRepo.find
        .mockResolvedValueOnce([]) // RUNNING scan
        .mockResolvedValueOnce([]); // PENDING sweep
      // timeout=10s → per-task threshold max(20s, 60s) = 60s
      taskRepo.find.mockResolvedValue([
        makeTask({ id: "task-1", timeout: 10 }),
      ]);

      const before = Date.now();
      await service.recoverStaleExecutions();

      const runningScan = execRepo.find.mock.calls[0][0] as {
        where: { startTime: { value: Date; type: string } };
      };
      const cutoff = runningScan.where.startTime.value.getTime();
      // cutoff ≈ now - 60s (definitely NOT now - 1h)
      expect(runningScan.where.startTime.type).toBe("lessThan");
      expect(cutoff).toBeGreaterThan(before - 61_000);
      expect(cutoff).toBeLessThanOrEqual(before - 59_000);
    });

    it("N5: keeps the 1h fallback window when no task has a timeout", async () => {
      await makeLeader();
      execRepo.find.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      taskRepo.find.mockResolvedValue([
        makeTask({ id: "task-1", timeout: 0 }),
        makeTask({ id: "task-2", timeout: 0 }),
      ]);

      const before = Date.now();
      await service.recoverStaleExecutions();

      const runningScan = execRepo.find.mock.calls[0][0] as {
        where: { startTime: { value: Date } };
      };
      const cutoff = runningScan.where.startTime.value.getTime();
      expect(cutoff).toBeLessThanOrEqual(before - 59 * 60 * 1000);
      expect(cutoff).toBeGreaterThan(before - 61 * 60 * 1000);
    });

    it("N5: per-row recovery threshold honours max(2×taskTimeout, 60s)", async () => {
      await makeLeader();
      // timeout=10s → threshold 60s. A 2-minute-old RUNNING row must be swept.
      const staleExec = {
        id: "exec-short",
        taskId: "task-1",
        status: ExecutionStatus.RUNNING,
        startTime: new Date(Date.now() - 2 * 60 * 1000),
        executorAddress: "host:3002",
      };
      execRepo.find
        .mockResolvedValueOnce([staleExec])
        .mockResolvedValueOnce([]);
      taskRepo.find.mockResolvedValue([
        makeTask({ id: "task-1", timeout: 10 }),
      ]);
      taskRepo.findBy.mockResolvedValue([
        makeTask({ id: "task-1", timeout: 10 }),
      ]);
      const updateQb = makeUpdateQb({
        affected: 1,
        raw: [{ id: "exec-short", executorAddress: "host:3002" }],
      });
      dataSource.transaction.mockImplementation(async (fn: any) =>
        fn({ createQueryBuilder: () => updateQb }),
      );

      await service.recoverStaleExecutions();

      expect(updateQb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: ExecutionStatus.FAILED,
          failureReason: ExecutionFailureReason.TIMEOUT,
        }),
      );
    });

    it("N5: a row within max(2×taskTimeout, 60s) is left alone (short-timeout grace)", async () => {
      await makeLeader();
      // timeout=60s → threshold 120s. A 1-minute-old row is inside the grace
      // window even though it already exceeds the bare task timeout.
      const runningExec = {
        id: "exec-grace",
        taskId: "task-1",
        status: ExecutionStatus.RUNNING,
        startTime: new Date(Date.now() - 60 * 1000),
        executorAddress: "host:3002",
      };
      execRepo.find
        .mockResolvedValueOnce([runningExec])
        .mockResolvedValueOnce([]);
      taskRepo.find.mockResolvedValue([
        makeTask({ id: "task-1", timeout: 60 }),
      ]);
      taskRepo.findBy.mockResolvedValue([
        makeTask({ id: "task-1", timeout: 60 }),
      ]);

      await service.recoverStaleExecutions();

      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });

  describe("scheduler observability (R4-§5.5)", () => {
    it("recordTick counts ticks and accumulates duration via reload", async () => {
      await makeLeader();
      taskRepo.find.mockResolvedValue([]);

      const before = metrics.snapshot;
      expect(before.ticks).toBe(0);

      await service.reload();
      await service.reload();

      const snap = metrics.snapshot;
      expect(snap.ticks).toBe(2);
      expect(snap.tickDurationMsTotal).toBeGreaterThanOrEqual(0);
      expect(snap.lastTickDurationMs).toBeGreaterThanOrEqual(0);
      expect(snap.lastTickAt).not.toBeNull();
    });

    it("enqueue claims, skips and failures are counted on the right counters", async () => {
      await makeLeader();
      const lock = { release: jest.fn().mockResolvedValue(undefined) };

      // 1) success → triggersClaimed
      redisLockService.acquireLock.mockResolvedValue(lock);
      const task = makeTask();
      taskRepo.findOne.mockResolvedValue(task);
      const exec = {
        id: "exec-1",
        status: ExecutionStatus.PENDING,
      } as TaskExecution;
      execRepo.create.mockReturnValue(exec);
      execRepo.save.mockResolvedValue(exec);
      await service.enqueue(task, "cron");
      expect(metrics.snapshot.triggersClaimed).toBe(1);

      // 2) redis lock held → triggersSkippedLockHeld
      redisLockService.acquireLock.mockResolvedValue(null);
      await service.enqueue(task, "cron");
      expect(metrics.snapshot.triggersSkippedLockHeld).toBe(1);

      // 3) task no longer active → triggersSkippedInactive
      redisLockService.acquireLock.mockResolvedValue(lock);
      taskRepo.findOne.mockResolvedValue(null);
      await service.enqueue(task, "cron");
      expect(metrics.snapshot.triggersSkippedInactive).toBe(1);

      // 4) DISCARD with a running execution → triggersSkippedBlockStrategy
      const discardTask = makeTask({ blockStrategy: BlockStrategy.DISCARD });
      redisLockService.acquireLock.mockResolvedValue(lock);
      taskRepo.findOne.mockResolvedValue(discardTask);
      execRepo.findOne.mockResolvedValue({
        id: "r1",
        status: ExecutionStatus.RUNNING,
      });
      await service.enqueue(discardTask, "cron");
      expect(metrics.snapshot.triggersSkippedBlockStrategy).toBe(1);

      // 5) DB claim path losing → triggersSkippedDbClaim
      redisLockService.acquireLock.mockRejectedValue(new Error("redis down"));
      taskRepo.createQueryBuilder.mockReturnValue(
        makeUpdateQb({ affected: 0 }),
      );
      await service.enqueue(discardTask, "cron");
      expect(metrics.snapshot.triggersSkippedDbClaim).toBe(1);

      // 6) queue.add throws → triggersFailed (with PENDING compensation)
      redisLockService.acquireLock.mockResolvedValue(lock);
      taskRepo.findOne.mockResolvedValue(task);
      execRepo.findOne.mockResolvedValue(null);
      queue.add.mockRejectedValueOnce(new Error("broker down"));
      execRepo.update.mockResolvedValue({ affected: 1 });
      await service.enqueue(task, "cron");
      expect(metrics.snapshot.triggersFailed).toBe(1);

      // 7) success again → claimed counts up to 2
      redisLockService.acquireLock.mockResolvedValue(lock);
      taskRepo.findOne.mockResolvedValue(task);
      queue.add.mockResolvedValue({ id: "job-2" });
      await service.enqueue(task, "cron");
      expect(metrics.snapshot.triggersClaimed).toBe(2);
    });

    it("getQueueDepth returns BullMQ job counts", async () => {
      queue.getJobCounts.mockResolvedValue({
        waiting: 3,
        active: 2,
        delayed: 1,
        failed: 4,
        completed: 100,
      });
      const depth = await service.getQueueDepth();
      expect(depth).toEqual({
        waiting: 3,
        active: 2,
        delayed: 1,
        failed: 4,
        completed: 100,
      });
      expect(queue.getJobCounts).toHaveBeenCalledWith(
        "waiting",
        "active",
        "delayed",
        "failed",
        "completed",
      );
    });

    it("getQueueDepth returns nulls instead of throwing when Redis is down", async () => {
      queue.getJobCounts.mockRejectedValue(new Error("redis down"));
      const depth = await service.getQueueDepth();
      expect(depth).toEqual({
        waiting: null,
        active: null,
        delayed: null,
        failed: null,
        completed: null,
      });
    });

    it("getSchedulerMetrics aggregates counters, derived rates and queue depth", async () => {
      await makeLeader();
      taskRepo.find.mockResolvedValue([]);
      await service.reload();

      const snap = await service.getSchedulerMetrics();
      expect(snap.counters.ticks).toBe(1);
      expect(snap.counters.startedAt).toEqual(expect.any(String));
      expect(snap.derived.avgTickDurationMs).toBeGreaterThanOrEqual(0);
      expect(snap.derived.tickRatePerSec).toBeGreaterThanOrEqual(0);
      expect(snap.derived.triggerClaimRatePerSec).toBeGreaterThanOrEqual(0);
      expect(snap.queue).toEqual({
        waiting: 0,
        active: 0,
        delayed: 0,
        failed: 0,
        completed: 0,
      });
    });
  });

  describe("N2: enqueue priority normalization (PG string enum → BullMQ integer)", () => {
    /**
     * N2: tasks.priority lives in a PG string enum ('low'/'normal'/'high'/
     * 'critical'); TypeORM hydrates it as a string. Passing the raw label to
     * BullMQ's priority option makes every scheduled enqueue fail with
     * "Priority should not be float" (80/80 in round-5 e2e). The enqueue
     * boundary must always hand BullMQ a number.
     */
    const setupHappyPath = (task: Task) => {
      const lock = { release: jest.fn().mockResolvedValue(true) };
      redisLockService.acquireLock.mockResolvedValue(lock);
      taskRepo.findOne.mockResolvedValue(task);
      const exec = {
        id: "exec-1",
        status: ExecutionStatus.PENDING,
      } as TaskExecution;
      execRepo.create.mockReturnValue(exec);
      execRepo.save.mockResolvedValue(exec);
      execRepo.findOne.mockResolvedValue(null); // no RUNNING row for DISCARD etc.
      return exec;
    };

    it.each([
      [
        "normal (hydrated PG label, the real-world failing shape)",
        "normal",
        TaskPriority.NORMAL,
      ],
      ["lowercase high label", "high", TaskPriority.HIGH],
      ["UPPERCASE label", "CRITICAL", TaskPriority.CRITICAL],
      ["mixed case label", "Low", TaskPriority.LOW],
      ["numeric 1", 1, TaskPriority.LOW],
      ["numeric 4", 4, TaskPriority.CRITICAL],
      ['integer string "3"', "3", TaskPriority.HIGH],
      ["undefined → NORMAL fallback", undefined, TaskPriority.NORMAL],
      ["null → NORMAL fallback", null, TaskPriority.NORMAL],
      ["unknown garbage → NORMAL fallback", "urgent", TaskPriority.NORMAL],
      ["boolean → NORMAL fallback", true, TaskPriority.NORMAL],
    ])(
      "priority %s is enqueued as a number",
      async (_name: string, raw: unknown, expected: TaskPriority) => {
        await makeLeader();
        const task = makeTask({ priority: raw as unknown as TaskPriority });
        setupHappyPath(task);

        await service.enqueue(task, "cron");

        expect(queue.add).toHaveBeenCalledWith(
          "execute",
          { executionId: "exec-1", task },
          expect.objectContaining({ priority: expected }),
        );
        expect(typeof queue.add.mock.calls[0][2].priority).toBe("number");
      },
    );

    it("never forwards a raw string priority to BullMQ even for NaN-ish values", async () => {
      await makeLeader();
      const task = makeTask({
        priority: "whatever" as unknown as TaskPriority,
      });
      setupHappyPath(task);

      await service.enqueue(task, "fixed_rate");

      const opts = queue.add.mock.calls[0][2];
      expect(opts.priority).toBe(TaskPriority.NORMAL);
      expect(Number.isInteger(opts.priority)).toBe(true);
    });
  });

  describe("N6: trigger dedup lock TTL derived from the trigger period", () => {
    const setupHappyPath = (task: Task) => {
      taskRepo.findOne.mockResolvedValue(task);
      const exec = {
        id: "exec-1",
        status: ExecutionStatus.PENDING,
      } as TaskExecution;
      execRepo.create.mockReturnValue(exec);
      execRepo.save.mockResolvedValue(exec);
    };

    it("fixed_rate 15s task: TTL is the period minus the jitter buffer, NOT max(timeout, period)", async () => {
      await makeLeader();
      const task = makeTask({
        triggerType: TaskTriggerType.FIXED_RATE,
        fixedRate: 15,
        timeout: 300,
      });
      setupHappyPath(task);
      redisLockService.acquireLock.mockResolvedValueOnce({
        key: `task:trigger:${task.id}`,
        lockId: "l1",
        ttlMs: 14_500,
        released: false,
        release: jest.fn().mockResolvedValue(true),
      });

      await service.enqueue(task, "fixed_rate");

      expect(redisLockService.acquireLock).toHaveBeenCalledWith(
        `task:trigger:${task.id}`,
        14_500,
        { renew: false },
      );
      expect(queue.add).toHaveBeenCalled();
    });

    it("short-period task with default timeout is no longer suppressed to the timeout (regression)", async () => {
      await makeLeader();
      const task = makeTask({
        triggerType: TaskTriggerType.FIXED_RATE,
        fixedRate: 15,
        timeout: 0, // makeTask default timeout=0 already; be explicit
      });
      setupHappyPath(task);
      redisLockService.acquireLock.mockResolvedValueOnce({
        key: `task:trigger:${task.id}`,
        lockId: "l1",
        ttlMs: 14_500,
        released: false,
        release: jest.fn().mockResolvedValue(true),
      });

      await service.enqueue(task, "fixed_rate");

      const ttl = redisLockService.acquireLock.mock.calls.find(
        (c: unknown[]) => c[0] === `task:trigger:${task.id}`,
      )![1] as number;
      // Old behaviour: max(300s, 15s) = 300s. Round-5 residual: exactly 15s
      // left a δ-phase-lag window that skipped the next tick (15s/30s mix).
      // Now: period - jitter buffer.
      expect(ttl).toBe(14_500);
      expect(ttl).toBeLessThan(15_000);
    });

    it("cron task: TTL falls back to the 1s lower bound", async () => {
      await makeLeader();
      const task = makeTask({ timeout: 300 });
      setupHappyPath(task);
      redisLockService.acquireLock.mockResolvedValueOnce({
        key: `task:trigger:${task.id}`,
        lockId: "l1",
        ttlMs: 1_000,
        released: false,
        release: jest.fn().mockResolvedValue(true),
      });

      await service.enqueue(task, "cron");

      expect(redisLockService.acquireLock).toHaveBeenCalledWith(
        `task:trigger:${task.id}`,
        1_000,
        { renew: false },
      );
    });

    it("api/manual triggers keep the conservative 5s window", async () => {
      await makeLeader();
      const task = makeTask({ triggerType: TaskTriggerType.API, timeout: 300 });
      setupHappyPath(task);
      redisLockService.acquireLock.mockResolvedValueOnce({
        key: `task:trigger:${task.id}`,
        lockId: "l1",
        ttlMs: 5_000,
        released: false,
        release: jest.fn().mockResolvedValue(true),
      });

      await service.enqueue(task, "manual");

      expect(redisLockService.acquireLock).toHaveBeenCalledWith(
        `task:trigger:${task.id}`,
        5_000,
        { renew: false },
      );
    });

    it("DB claim window mirrors the new TTL (fixed_rate → the period)", async () => {
      await makeLeader();
      const task = makeTask({
        triggerType: TaskTriggerType.FIXED_RATE,
        fixedRate: 15,
        timeout: 300,
      });
      setupHappyPath(task);
      redisLockService.acquireLock.mockRejectedValue(new Error("redis down"));
      taskRepo.createQueryBuilder.mockReturnValue(
        makeUpdateQb({ affected: 1 }),
      );

      await service.enqueue(task, "fixed_rate");

      const claimQb = taskRepo.createQueryBuilder.mock.results[0].value;
      const claimArgs = claimQb.where.mock.calls[0][1] as {
        windowStart: Date;
      };
      // claim window = lockTTL = 15s - 500ms buffer → windowStart ≈ now - 14.5s
      const delta = Date.now() - claimArgs.windowStart.getTime();
      expect(delta).toBeGreaterThanOrEqual(14_000);
      expect(delta).toBeLessThanOrEqual(15_000);
      expect(queue.add).toHaveBeenCalled();
    });
  });

  describe("N6 residual: computeTriggerDedupTtlMs period-minus-buffer (round5v2 §2.3)", () => {
    it("fixed_rate 15s → period - 500ms jitter buffer = 14500ms", () => {
      expect(
        computeTriggerDedupTtlMs(
          makeTask({ triggerType: TaskTriggerType.FIXED_RATE, fixedRate: 15 }),
        ),
      ).toBe(14_500);
    });

    it("fixed_rate 60s → 59500ms", () => {
      expect(
        computeTriggerDedupTtlMs(
          makeTask({ triggerType: TaskTriggerType.FIXED_RATE, fixedRate: 60 }),
        ),
      ).toBe(59_500);
    });

    it("fixed_rate 1s: buffer would dip below the floor → MIN_TTL applies", () => {
      const ttl = computeTriggerDedupTtlMs(
        makeTask({ triggerType: TaskTriggerType.FIXED_RATE, fixedRate: 1 }),
      );
      expect(ttl).toBe(TRIGGER_DEDUP_MIN_TTL_MS);
      expect(TRIGGER_DEDUP_JITTER_BUFFER_MS).toBeGreaterThan(0);
    });

    it("cron → MIN_TTL lower bound", () => {
      expect(
        computeTriggerDedupTtlMs(
          makeTask({
            triggerType: TaskTriggerType.CRON,
            cronExpression: "0 * * * *",
          }),
        ),
      ).toBe(TRIGGER_DEDUP_MIN_TTL_MS);
    });

    it.each([TaskTriggerType.API, TaskTriggerType.MANUAL])(
      "%s trigger → conservative 5s window",
      (triggerType) => {
        expect(computeTriggerDedupTtlMs(makeTask({ triggerType }))).toBe(5_000);
      },
    );
  });

  describe("scheduleOne", () => {
    it("should stop existing schedule and register new cron task", async () => {
      await makeLeader();
      const task = makeTask({
        triggerType: TaskTriggerType.CRON,
        cronExpression: "0 * * * *",
      });
      await service.scheduleOne(task);
      const stats = service.getStats();
      expect(stats.activeCronTasks).toBe(1);
    });

    it("should pass timezone option when scheduleOne registers cron task", async () => {
      await makeLeader();
      const scheduleSpy = jest.spyOn(nodeCron, "schedule");
      const task = makeTask({
        triggerType: TaskTriggerType.CRON,
        cronExpression: "0 * * * *",
        timezone: "UTC",
      });
      await service.scheduleOne(task);
      expect(scheduleSpy).toHaveBeenCalledWith(
        "0 * * * *",
        expect.any(Function),
        { timezone: "UTC" },
      );
      scheduleSpy.mockRestore();
    });

    it("should stop existing schedule and register fixed_rate timer", async () => {
      await makeLeader();
      const task = makeTask({
        triggerType: TaskTriggerType.FIXED_RATE,
        fixedRate: 60,
        cronExpression: null,
      });
      await service.scheduleOne(task);
      const stats = service.getStats();
      expect(stats.activeTimers).toBe(1);
    });

    it("should not register cron task with invalid expression", async () => {
      await makeLeader();
      const task = makeTask({
        triggerType: TaskTriggerType.CRON,
        cronExpression: "bad-expr",
      });
      await service.scheduleOne(task);
      expect(service.getStats().activeCronTasks).toBe(0);
    });
  });
});
