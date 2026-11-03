import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { getQueueToken } from "@nestjs/bullmq";
import { DataSource } from "typeorm";
import * as nodeCron from "node-cron";

import { SchedulerService } from "../scheduler.service";
import { SchedulerMetricsService } from "../scheduler-metrics.service";
import {
  Task,
  TaskStatus,
  TaskTriggerType,
  MisfireStrategy,
} from "../../task/entities/task.entity";
import { TaskExecution } from "../../task/entities/task-execution.entity";
import { RedisLockService } from "../../../common/services/redis-lock.service";
import { ExecutorService } from "../../executor/executor.service";
import { ConfigService } from "@nestjs/config";

/**
 * A6b：**调度侧**的「到点跳过一次」行为。
 *
 * 产品 2026-11-03 拍板的口径：「手动执行不算覆盖计划落点；**除非**给一个入口
 * **提前触发**，去**消耗最近 1 次 cron**」⇒ 到那一拍，调度器**跳过一次**并
 * 清除登记（一次性，**不是**永久 mute）。
 *
 * 本 spec 覆盖：②勾选 ⇒ 到点跳过一次 + 留痕（warn）+ 登记清除；
 * ③跳过之后的下一个计划点**正常触发**；⑤（登记被消费后）补偿不再把它当漏跑。
 */

const mockRepo = () => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn(),
  save: jest.fn(),
  create: jest.fn(),
  findBy: jest.fn(),
  update: jest.fn().mockResolvedValue({ affected: 1 }),
  count: jest.fn().mockResolvedValue(0),
  createQueryBuilder: jest.fn(() => makeUpdateQb({ affected: 1 })),
});

const makeUpdateQb = (result: { affected: number }) => {
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

const makeTask = (overrides: Partial<Task> = {}): Task =>
  ({
    id: "22222222-2222-4222-8222-222222222222",
    name: "A6b Cron Task",
    status: TaskStatus.ACTIVE,
    triggerType: TaskTriggerType.CRON,
    cronExpression: "*/5 * * * *",
    timezone: null,
    fixedRate: null,
    blockStrategy: "serial",
    misfireStrategy: MisfireStrategy.FIRE_ONCE,
    maxRetry: 3,
    retryDelay: 5,
    priority: 2,
    params: {},
    currentVersion: 1,
    lastTriggerTime: null,
    consumedFirePointAt: null,
    ...overrides,
  }) as unknown as Task;

describe("A6b · 提前触发并消耗下一个计划点（scheduler 侧到点跳过）", () => {
  let service: SchedulerService;
  let taskRepo: Record<string, jest.Mock>;
  let execRepo: Record<string, jest.Mock>;
  let queue: { add: jest.Mock };
  let redisLockService: Record<string, jest.Mock>;
  let metrics: SchedulerMetricsService;

  /** 抓到的 cron 回调（nodeCron.createTask 的第 2 个实参）。 */
  let cronCallback: ((ctx: { date: Date }) => Promise<void>) | null;

  beforeEach(async () => {
    cronCallback = null;
    const repo = mockRepo();
    taskRepo = repo as never;
    execRepo = mockRepo() as never;
    // enqueue 路径：建执行行（create → save）
    const exec = { id: "exec-a6b", status: "pending" } as never;
    execRepo.create.mockReturnValue(exec);
    execRepo.save.mockResolvedValue(exec);
    queue = { add: jest.fn().mockResolvedValue({ id: "job-1" }) } as never;
    redisLockService = {
      acquireLock: jest.fn(),
      extendLock: jest.fn().mockResolvedValue(true),
      releaseLock: jest.fn().mockResolvedValue(true),
    } as never;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchedulerService,
        SchedulerMetricsService,
        { provide: getRepositoryToken(Task), useValue: taskRepo },
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
        { provide: getQueueToken("task-queue"), useValue: queue },
        { provide: RedisLockService, useValue: redisLockService },
        {
          provide: DataSource,
          useValue: {
            createQueryBuilder: jest.fn(() => makeUpdateQb({ affected: 1 })),
            getRepository: jest.fn(() => ({
              find: jest.fn().mockResolvedValue([]),
            })),
            transaction: jest.fn(),
            query: jest.fn(async () => []),
          },
        },
        {
          provide: ExecutorService,
          useValue: {
            hasRetryBudget: jest.fn().mockReturnValue(true),
            notifyExecutorKill: jest.fn().mockResolvedValue(undefined),
            scheduleRetryAfterRecovery: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();

    service = module.get(SchedulerService);
    metrics = module.get(SchedulerMetricsService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  /** 让 service 成为 Leader（跳过判定只在 Leader 侧发生）。 */
  const makeLeader = async () => {
    redisLockService.acquireLock.mockResolvedValueOnce({
      key: "scheduler:leader",
      lockId: "leader-lock-id",
      ttlMs: 90000,
      released: false,
      release: jest.fn().mockResolvedValue(true),
    });
    await service.initLeaderElection();
  };

  /**
   * 记录 task 行的**每一次**条件 UPDATE 的谓词（区分「清除登记」与
   * 「enqueue 里的 claimTaskTrigger」——两者都走 createQueryBuilder）。
   */
  const whereClauses = (): string[] =>
    (
      taskRepo.createQueryBuilder as unknown as {
        mock: { results: Array<{ value: Record<string, jest.Mock> }> };
      }
    ).mock.results.map((r) =>
      String(r.value.where?.mock?.calls?.[0]?.[0] ?? ""),
    );

  /** 「清除登记」那条条件 UPDATE 的谓词（没有 ⇒ 未发生清除）。 */
  const consumeClause = (): string | undefined =>
    whereClauses().find((w) => w.includes("consumedFirePointAt"));

  /**
   * 注册一个 cron 任务并抓下它的回调（**不真的启动定时器**）。
   */
  const registerCron = async (task: Task) => {
    const spy = jest
      .spyOn(nodeCron, "createTask")
      .mockImplementation((_expr: string, fn: unknown) => {
        cronCallback = fn as (ctx: { date: Date }) => Promise<void>;
        return {
          on: jest.fn(),
          start: jest.fn(),
          stop: jest.fn(),
          destroy: jest.fn(),
        } as never;
      });
    taskRepo.find.mockResolvedValue([task]);
    await service.scheduleOne(task);
    spy.mockRestore();
    expect(cronCallback).not.toBeNull();
  };

  it("② 到点且已登记 ⇒ 跳过一次（不入队）+ 登记被清除（条件 UPDATE）+ warn 留痕", async () => {
    await makeLeader();
    const firePoint = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    const task = makeTask({ consumedFirePointAt: firePoint });
    // 触发时刻的 findOne 返回带登记的行
    taskRepo.findOne.mockResolvedValue(task);
    // 条件 UPDATE（清除登记）命中 1 行
    const qb = makeUpdateQb({ affected: 1 });
    jest.spyOn(taskRepo, "createQueryBuilder").mockReturnValue(qb);

    await registerCron(task);
    await cronCallback!({ date: firePoint });

    // 跳过一次 ⇒ **没有入队**
    expect(queue.add).not.toHaveBeenCalled();
    // 清除登记：一条**条件** UPDATE（谓词含等值比较 ⇒ 只有这一拍能清）
    expect(consumeClause()).toContain('"consumedFirePointAt" = :firePoint');
    expect(qb.set).toHaveBeenCalledWith({ consumedFirePointAt: null });
    // 留痕：warn 说清「这一拍被有意跳过、登记已清、下一个落点照常」
    const warnSpy = jest.spyOn((service as any).logger, "warn");
    await cronCallback!({ date: firePoint });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("SKIPPED"));
    // 指标：有意跳过与「丢点」分开计
    expect(metrics.snapshot).toMatchObject({
      cronSlotsConsumed: expect.any(Number),
    });
  });

  it("③ 跳过一次之后的下一个计划点**正常触发**（不是永久 mute）", async () => {
    await makeLeader();
    const firePoint = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    const nextFirePoint = new Date(firePoint.getTime() + 5 * 60_000);
    const task = makeTask({ consumedFirePointAt: firePoint });
    // 第一次到点后登记已被清除 ⇒ 第二次 findOne 返回**无登记**的行
    taskRepo.findOne
      .mockResolvedValueOnce(task)
      .mockResolvedValue(makeTask({ consumedFirePointAt: null }));
    const qb = makeUpdateQb({ affected: 1 });
    jest.spyOn(taskRepo, "createQueryBuilder").mockReturnValue(qb);
    redisLockService.acquireLock.mockResolvedValue({
      key: "task:trigger:x",
      lockId: "l1",
      ttlMs: 1000,
      released: false,
      release: jest.fn().mockResolvedValue(true),
    });

    await registerCron(task);
    await cronCallback!({ date: firePoint });
    expect(queue.add).not.toHaveBeenCalled();

    // 下一个落点：登记已清 ⇒ **照常触发**
    await cronCallback!({ date: nextFirePoint });
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it("未登记 ⇒ 照常触发（缺省行为不变，零写入）", async () => {
    await makeLeader();
    const task = makeTask();
    taskRepo.findOne.mockResolvedValue(task);
    jest.spyOn(taskRepo, "createQueryBuilder");
    redisLockService.acquireLock.mockResolvedValue({
      key: "task:trigger:x",
      lockId: "l1",
      ttlMs: 1000,
      released: false,
      release: jest.fn().mockResolvedValue(true),
    });

    await registerCron(task);
    await cronCallback!({
      date: new Date(Math.floor(Date.now() / 60_000) * 60_000),
    });

    // **没有**「清除登记」那条条件 UPDATE（未登记 ⇒ 零写入路径）
    expect(consumeClause()).toBeUndefined();
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it("登记的是**别的**落点 ⇒ 本拍照常触发（登记只对那一拍有效）", async () => {
    await makeLeader();
    const firePoint = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    const otherFirePoint = new Date(firePoint.getTime() + 60_000);
    const task = makeTask({ consumedFirePointAt: otherFirePoint });
    taskRepo.findOne.mockResolvedValue(task);
    jest.spyOn(taskRepo, "createQueryBuilder");
    redisLockService.acquireLock.mockResolvedValue({
      key: "task:trigger:x",
      lockId: "l1",
      ttlMs: 1000,
      released: false,
      release: jest.fn().mockResolvedValue(true),
    });

    await registerCron(task);
    await cronCallback!({ date: firePoint });

    // 登记的是别的落点 ⇒ 本拍**不**走清除路径
    expect(consumeClause()).toBeUndefined();
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it("多实例：条件 UPDATE 命中 0 行 ⇒ 别的实例已用掉 ⇒ 本实例照常触发", async () => {
    await makeLeader();
    const firePoint = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    const task = makeTask({ consumedFirePointAt: firePoint });
    taskRepo.findOne.mockResolvedValue(task);
    // affected=0 ⇒ 已被别人清掉（本实例没抢到）。
    // ⚠️ 必须**按谓词分别**给结果：`enqueue` 里的 `claimTaskTrigger` 也走
    // createQueryBuilder，它必须**成功**（否则整条入队被 claim 挡掉，测的就
    // 不是「跳过判定」而是「claim 判定」了）。
    jest.spyOn(taskRepo, "createQueryBuilder").mockImplementation(() => {
      const qb = makeUpdateQb({ affected: 1 });
      qb.where.mockImplementation((w: string, _p: Record<string, unknown>) => {
        if (String(w).includes("consumedFirePointAt")) {
          qb.execute.mockResolvedValue({ affected: 0 });
        }
        return qb;
      });
      return qb;
    });
    redisLockService.acquireLock.mockResolvedValue({
      key: "task:trigger:x",
      lockId: "l1",
      ttlMs: 1000,
      released: false,
      release: jest.fn().mockResolvedValue(true),
    });

    await registerCron(task);
    await cronCallback!({ date: firePoint });

    // 没抢到 ⇒ **不跳过**（照常触发，避免整拍被吞）
    expect(queue.add).toHaveBeenCalledTimes(1);
  });
});
