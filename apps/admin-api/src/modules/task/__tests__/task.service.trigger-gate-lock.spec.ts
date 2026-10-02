import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { getQueueToken } from "@nestjs/bullmq";
import { ConflictException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TaskService, TRIGGER_GATE_LOCK_TTL_MS } from "../task.service";
import { Task, BlockStrategy } from "../entities/task.entity";
import { TaskExecution } from "../entities/task-execution.entity";
import { ExecutionLogLine } from "../entities/execution-log-line.entity";
import { TaskVersion } from "../entities/task-version.entity";
import { ExecutionReport } from "../../metrics/entities/execution-report.entity";
import { SchedulerService } from "../../scheduler/scheduler.service";
import { AiService } from "../../ai/ai.service";
import { AiAnalysisService } from "../../ai/ai-analysis.service";
import { ExecutorService } from "../../executor/executor.service";
import { DomainEventBus } from "../../../common/services/domain-event-bus.service";
import { AuditService } from "../../audit/audit.service";
import { SecretsCryptoService } from "../../../common/utils/secret-crypto.util.service";
import { RedisLockService } from "../../../common/services/redis-lock.service";
import { DataSource } from "typeorm";

/**
 * B-5（调度域审计）：blockStrategy 闸门 TOCTOU 收口——触发路径套
 * per-(taskId + canonicalParams) 短 Redis 锁（持锁窗口覆盖检查+落行）。
 *
 * 主 task.service.spec 对闸门模块整体打桩且不提供 RedisLockService（@Optional
 * 缺席 → fail-open 跳锁），不适合承载锁语义；本 spec 提供真实 RedisLockService
 * 替身 + 真实闸门，专测并发语义可测部分：
 * - 取锁成功 → 检查+落行后释放（不滞留，TTL 兜底仅为崩溃保护）；
 * - 锁被占用 → 409（与 discard 命中同语义），零落行零入队；
 * - Redis 故障 → fail-open 照常触发（与仓库既有纪律一致）；
 * - SERIAL 不取锁（闸门对 SERIAL 本就直通）；
 * - 锁 key 按参数规范化摘要区分——异参触发互不阻塞。
 */

const makeRepo = () => ({
  create: jest.fn((d) => d),
  save: jest.fn((e) => Promise.resolve(e)),
  findOne: jest.fn(),
  find: jest.fn().mockResolvedValue([]), // 真实闸门读在跑/排队执行：默认空 = 无阻塞
  update: jest.fn().mockResolvedValue({ affected: 1 }),
  createQueryBuilder: jest.fn(() => ({
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue({ maxNum: 0 }),
    getMany: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    returning: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1, raw: [] }),
  })),
});

const makeLock = (key: string) => ({
  key,
  lockId: "lock-id-1",
  ttlMs: TRIGGER_GATE_LOCK_TTL_MS,
  released: false,
  release: jest.fn().mockResolvedValue(true),
});

describe("TaskService trigger gate lock (B-5: 闸门 TOCTOU)", () => {
  let service: TaskService;
  let taskRepo: ReturnType<typeof makeRepo>;
  let execRepo: ReturnType<typeof makeRepo>;
  let versionRepo: ReturnType<typeof makeRepo>;
  let dataSource: { transaction: jest.Mock };
  let taskQueue: { add: jest.Mock };
  let redisLockService: {
    acquireLock: jest.Mock;
    extendLock: jest.Mock;
    releaseLock: jest.Mock;
  };

  const makeTask = (overrides: Record<string, unknown> = {}) => ({
    id: "t-1",
    name: "gate-lock-task",
    params: { orderId: "A" } as Record<string, unknown>,
    maxRetry: 1,
    retryDelay: 0,
    currentVersion: "v1",
    status: "active",
    blockStrategy: BlockStrategy.DISCARD,
    ...overrides,
  });

  const setupTriggerPath = (task: Record<string, unknown>) => {
    taskRepo.findOne.mockResolvedValue(task);
    const exec = {
      id: "exec-1",
      status: "pending",
    } as unknown as TaskExecution;
    dataSource.transaction.mockImplementation(async (fn: any) =>
      fn({
        create: jest.fn().mockReturnValue(exec),
        save: jest.fn().mockResolvedValue(exec),
      }),
    );
    return exec;
  };

  beforeEach(async () => {
    taskRepo = makeRepo();
    execRepo = makeRepo();
    versionRepo = makeRepo();
    taskQueue = { add: jest.fn().mockResolvedValue({}) };
    dataSource = {
      transaction: jest.fn(async (fn: any) =>
        fn({
          create: jest.fn().mockReturnValue({ id: "exec-1" }),
          save: jest.fn().mockResolvedValue({ id: "exec-1" }),
        }),
      ),
    };
    redisLockService = {
      acquireLock: jest.fn(),
      extendLock: jest.fn().mockResolvedValue(true),
      releaseLock: jest.fn().mockResolvedValue(true),
    };

    const module = await Test.createTestingModule({
      providers: [
        TaskService,
        { provide: getRepositoryToken(Task), useValue: taskRepo },
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
        { provide: getRepositoryToken(ExecutionLogLine), useValue: makeRepo() },
        { provide: getRepositoryToken(TaskVersion), useValue: versionRepo },
        { provide: getRepositoryToken(ExecutionReport), useValue: {} },
        { provide: getQueueToken("task-queue"), useValue: taskQueue },
        { provide: DataSource, useValue: dataSource },
        {
          provide: SchedulerService,
          useValue: { stop: jest.fn(), scheduleOne: jest.fn() },
        },
        { provide: AiService, useValue: { chat: jest.fn() } },
        { provide: AiAnalysisService, useValue: { analyzeFailure: jest.fn() } },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue("") },
        },
        {
          provide: ExecutorService,
          useValue: { notifyExecutorKill: jest.fn() },
        },
        { provide: DomainEventBus, useValue: { emit: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
        // B-5: 被测协作面——真实锁服务替身
        { provide: RedisLockService, useValue: redisLockService },
        {
          provide: SecretsCryptoService,
          useValue: new SecretsCryptoService({ get: () => "" } as any),
        },
      ],
    }).compile();

    service = module.get(TaskService);
  });

  it("取锁成功：以 (taskId+params 摘要) 为 key、秒级 TTL 取锁，落行后释放", async () => {
    const task = makeTask();
    setupTriggerPath(task);
    const lock = makeLock("task:trigger-gate:t-1:<hash>");
    redisLockService.acquireLock.mockResolvedValue(lock);

    await service.trigger("t-1", {} as never);

    expect(redisLockService.acquireLock).toHaveBeenCalledTimes(1);
    const [key, ttl] = redisLockService.acquireLock.mock.calls[0];
    expect(key).toMatch(/^task:trigger-gate:t-1:[0-9a-f]{24}$/);
    expect(ttl).toBe(TRIGGER_GATE_LOCK_TTL_MS);
    // 持锁窗口=检查+落行：落行完成即释放（不滞留；TTL 仅崩溃兜底）
    expect(lock.release).toHaveBeenCalledTimes(1);
    expect(taskQueue.add).toHaveBeenCalledWith(
      "execute",
      { executionId: "exec-1" },
      expect.anything(),
    );
  });

  it("锁被占用（并发同参触发在途）→ 409 且不落行不入队", async () => {
    const task = makeTask();
    setupTriggerPath(task);
    redisLockService.acquireLock.mockResolvedValue(null);

    await expect(service.trigger("t-1", {} as never)).rejects.toBeInstanceOf(
      ConflictException,
    );
    // 零落行、零入队、无锁可释放
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(taskQueue.add).not.toHaveBeenCalled();
  });

  it("Redis 故障 fail-open：取锁抛错仅降级，触发照常完成", async () => {
    const task = makeTask();
    setupTriggerPath(task);
    redisLockService.acquireLock.mockRejectedValue(
      new Error("redis connection down"),
    );

    await expect(service.trigger("t-1", {} as never)).resolves.toMatchObject({
      id: "exec-1",
    });
    expect(taskQueue.add).toHaveBeenCalledTimes(1);
  });

  it("blockStrategy=SERIAL 不取锁（触发层语义即放行，串行由互斥组承担）", async () => {
    const task = makeTask({ blockStrategy: BlockStrategy.SERIAL });
    setupTriggerPath(task);

    await service.trigger("t-1", {} as never);

    expect(redisLockService.acquireLock).not.toHaveBeenCalled();
    expect(taskQueue.add).toHaveBeenCalledTimes(1);
  });

  it("锁 key 按参数规范化摘要区分：异参触发互不阻塞（合法并发不受影响）", async () => {
    const task = makeTask();
    setupTriggerPath(task);
    redisLockService.acquireLock.mockResolvedValue(makeLock("k1"));

    await service.trigger("t-1", {
      params: { orderId: "A" },
    } as never);
    const keyForA = redisLockService.acquireLock.mock.calls[0][0];

    redisLockService.acquireLock.mockClear();
    await service.trigger("t-1", {
      params: { orderId: "B" },
    } as never);
    const keyForB = redisLockService.acquireLock.mock.calls[0][0];

    expect(keyForA).not.toBe(keyForB);
    // 同参（含键序差异的等价对象）取同一 key
    redisLockService.acquireLock.mockClear();
    await service.trigger("t-1", {
      params: { orderId: "A" },
    } as never);
    expect(redisLockService.acquireLock.mock.calls[0][0]).toBe(keyForA);
  });
});
