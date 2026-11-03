import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { getQueueToken } from "@nestjs/bullmq";
import { DataSource } from "typeorm";

import { TaskService } from "../task.service";
import {
  Task,
  TaskStatus,
  TaskTriggerType,
  MisfireStrategy,
} from "../entities/task.entity";
import { TaskExecution } from "../entities/task-execution.entity";
import { ExecutionLogLine } from "../entities/execution-log-line.entity";
import { TaskVersion } from "../entities/task-version.entity";
import { ExecutionReport } from "../../metrics/entities/execution-report.entity";
import { SchedulerService } from "../../scheduler/scheduler.service";
import { AiService } from "../../ai/ai.service";
import { AiAnalysisService } from "../../ai/ai-analysis.service";
import { ExecutorService } from "../../executor/executor.service";
import { ConfigService } from "@nestjs/config";
import { AuditService } from "../../audit/audit.service";
import { DomainEventBus } from "../../../common/services/domain-event-bus.service";
import { SecretsCryptoService } from "../../../common/utils/secret-crypto.util.service";

/**
 * A6b：**显式「提前触发并消耗下一个计划点」入口**的行为测试。
 *
 * 产品 2026-11-03 拍板的口径（原话）：
 * > 手动执行不算覆盖计划落点；**除非**给一个入口**提前触发**，去**消耗最近 1 次 cron**。
 *
 * 本 spec 覆盖 task 侧（登记）：①不勾选 ⇒ 无登记；④重复勾选 ⇒ 409；
 * ⑤编辑 cron 后旧登记失效；⑥非 cron ⇒ 400。
 * 调度侧（到点跳过 + 留痕 + 清除登记 + 跳过之后下一拍正常）的用例在
 * `modules/scheduler/__tests__/scheduler.service.spec.ts`。
 */

/** 记录 task 行的**条件 UPDATE**（A6b 的登记/清除都走它）。 */
type CondUpdate = {
  where: string;
  params: Record<string, unknown>;
  set: Record<string, unknown>;
};

const makeTask = (overrides: Partial<Task> = {}): Task =>
  ({
    id: "11111111-1111-4111-8111-111111111111",
    name: "A6b Task",
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
    ownerUserId: null,
    secrets: null,
    lastTriggerTime: null,
    consumedFirePointAt: null,
    updatedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  }) as unknown as Task;

describe("A6b · 提前触发并消耗下一个计划点（task 侧登记）", () => {
  let service: TaskService;
  let taskRepo: Record<string, jest.Mock>;
  let execRepo: Record<string, jest.Mock>;
  let taskQueue: { add: jest.Mock };
  let auditMock: { log: jest.Mock };
  /** 记录到的条件 UPDATE（每次登记/清除一条）。 */
  let condUpdates: CondUpdate[];
  /** 条件 UPDATE 的受影响行数（默认 1 = 成功）。 */
  let affectedRows: number;
  /** versionRepo：saveVersion 需要它的 QB 链（select/where/getRawOne）。 */
  let versionRepo: Record<string, jest.Mock>;

  beforeEach(async () => {
    condUpdates = [];
    affectedRows = 1;

    // **有状态**的 task 行 mock：条件 UPDATE 真的按谓词判定 affected
    // （`IS NULL` / `IS NOT NULL` / 等值）⇒ 用例能验证「重复勾选 ⇒ 409」
    // 这类**依赖 DB 谓词语义**的行为，而不是靠手拧 affectedRows。
    const repo = () => {
      /** 行上 `consumedFirePointAt` 的当前值（null = 无登记）。 */
      let consumed: Date | null = null;
      const qbFactory = () => {
        const rec: Partial<CondUpdate> = { where: "", params: {}, set: {} };
        const qb: Record<string, jest.Mock> = {
          update: jest.fn().mockReturnThis(),
          where: jest.fn((w: string, p: Record<string, unknown>) => {
            rec.where = w;
            rec.params = p;
            return qb;
          }),
          andWhere: jest.fn().mockReturnThis(),
          set: jest.fn((v: Record<string, unknown>) => {
            rec.set = v;
            return qb;
          }),
          execute: jest.fn(async () => {
            condUpdates.push(rec as CondUpdate);
            // 按谓词判定 affected（模拟 PG 的行谓词语义）
            const w = String(rec.where ?? "");
            let affected = 1;
            if (w.includes('"consumedFirePointAt" IS NULL')) {
              affected = consumed == null ? 1 : 0;
            } else if (w.includes('"consumedFirePointAt" IS NOT NULL')) {
              affected = consumed != null ? 1 : 0;
            } else if (w.includes('"consumedFirePointAt" = :firePoint')) {
              const want = rec.params?.firePoint as Date | undefined;
              affected =
                want != null &&
                consumed != null &&
                consumed.getTime() === want.getTime()
                  ? 1
                  : 0;
            }
            if (affected > 0 && "consumedFirePointAt" in (rec.set ?? {})) {
              consumed = (rec.set as { consumedFirePointAt: Date | null })
                .consumedFirePointAt;
            }
            if (affectedRows !== 1) affected = affectedRows;
            return { affected };
          }),
        };
        return qb;
      };
      return {
        findOne: jest.fn(),
        find: jest.fn().mockResolvedValue([]),
        save: jest.fn(),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
        createQueryBuilder: jest.fn(() => qbFactory()),
        /** 测试用：读出行上的登记当前值。 */
        __getConsumed: () => consumed,
        /** 测试用：直接设置行上的登记当前值（模拟落库回填 / 重启后读同一行）。 */
        __setConsumed: (d: Date | null) => {
          consumed = d;
        },
      };
    };

    const taskRepoMock = repo();
    const execRepoMock = repo();
    taskRepo = taskRepoMock as never;
    execRepo = execRepoMock as never;
    taskQueue = { add: jest.fn().mockResolvedValue({ id: "job-1" }) };
    auditMock = { log: jest.fn().mockResolvedValue(undefined) };

    // versionRepo：saveVersion 需要它的 QB 链（select/where/getRawOne）
    versionRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      save: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      createQueryBuilder: jest.fn(() => {
        const qb: Record<string, jest.Mock> = {
          select: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          getRawOne: jest.fn().mockResolvedValue({ maxNum: 0 }),
          getMany: jest.fn().mockResolvedValue([]),
          insert: jest.fn().mockReturnThis(),
          values: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue({ affected: 1 }),
        };
        return qb;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TaskService,
        { provide: getRepositoryToken(Task), useValue: taskRepo },
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
        {
          provide: getRepositoryToken(ExecutionLogLine),
          useValue: repo(),
        },
        { provide: getRepositoryToken(TaskVersion), useValue: versionRepo },
        { provide: getRepositoryToken(ExecutionReport), useValue: {} },
        { provide: getQueueToken("task-queue"), useValue: taskQueue },
        {
          provide: DataSource,
          useValue: {
            transaction: jest.fn(async (cb: (m: unknown) => unknown) =>
              cb({
                create: jest.fn(),
                save: jest.fn(async () => ({ id: "exec-1" })),
              }),
            ),
          },
        },
        {
          provide: SchedulerService,
          useValue: {
            scheduleOne: jest.fn(),
            stop: jest.fn(),
            getStats: jest.fn(() => ({ isLeader: false })),
          },
        },
        { provide: AiService, useValue: {} },
        { provide: AiAnalysisService, useValue: {} },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue("") },
        },
        {
          provide: ExecutorService,
          useValue: {
            getExecutorUrl: jest.fn().mockResolvedValue("http://x"),
            notifyExecutorKill: jest.fn(),
            scheduleRetryAfterRecovery: jest.fn(),
            hasRetryBudget: jest.fn().mockReturnValue(true),
          },
        },
        { provide: DomainEventBus, useValue: { emit: jest.fn() } },
        { provide: AuditService, useValue: auditMock },
        {
          provide: SecretsCryptoService,
          useValue: new SecretsCryptoService({ get: () => "" } as never),
        },
      ],
    }).compile();

    service = module.get(TaskService);
  });

  afterEach(() => jest.clearAllMocks());

  /**
   * 让 findOne 返回给定任务行（trigger() 的取数入口）。
   *
   * ⚠️ 返回的**同一对象引用** ⇒ 用例改它（如模拟落库回填）会反映到后续读取，
   * 且「登记存在与否」由 mock 的**有状态**谓词判定（见 repo() 注释）。
   */
  const givenTask = (task: Task) => {
    taskRepo.findOne.mockResolvedValue(task);
  };

  it("① 不勾选 consumeNextFirePoint ⇒ 无任何登记写入（缺省行为逐字节不变）", async () => {
    givenTask(makeTask());
    await service.trigger(
      "11111111-1111-4111-8111-111111111111",
      {},
      { id: 7, role: "admin" as never },
    );
    // 一次条件 UPDATE 都没有 ⇒ 完全没碰新列
    expect(condUpdates).toHaveLength(0);
    // 触发本身照常发生
    expect(taskQueue.add).toHaveBeenCalledTimes(1);
  });

  it("①b 显式传 consumeNextFirePoint=false ⇒ 同样无登记（缺省等价）", async () => {
    givenTask(makeTask());
    await service.trigger(
      "11111111-1111-4111-8111-111111111111",
      { consumeNextFirePoint: false },
      { id: 7, role: "admin" as never },
    );
    expect(condUpdates).toHaveLength(0);
  });

  it("② 勾选 ⇒ 登记「下一个落点」（条件 UPDATE，谓词 IS NULL）且触发照常发生", async () => {
    const task = makeTask();
    givenTask(task);
    await service.trigger(
      "11111111-1111-4111-8111-111111111111",
      { consumeNextFirePoint: true },
      { id: 7, role: "admin" as never },
    );
    expect(condUpdates).toHaveLength(1);
    const upd = condUpdates[0];
    // 原子登记：谓词必须是「当前没有登记」
    expect(upd.where).toContain('"consumedFirePointAt" IS NULL');
    // 写入的是**下一个**落点（未来时刻）
    const firePointAt = upd.set.consumedFirePointAt as Date;
    expect(firePointAt).toBeInstanceOf(Date);
    expect(firePointAt.getTime()).toBeGreaterThan(Date.now());
    // 落点必须落在 cron 表达式上（*/5 ⇒ 秒/毫秒为 0）
    expect(firePointAt.getSeconds()).toBe(0);
    expect(firePointAt.getMilliseconds()).toBe(0);
    // 触发本身**照常**发生（这一跑就是「提前跑」）
    expect(taskQueue.add).toHaveBeenCalledTimes(1);
    // 留痕：审计写了 task.fire_point_consumed
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "task.fire_point_consumed" }),
    );
  });

  it("④ 重复勾选 ⇒ 409（第二次登记的条件 UPDATE 命中 0 行 ⇒ 已有未消耗登记）", async () => {
    givenTask(makeTask());
    // 第一次勾选 ⇒ 登记成功（这一跑就是「提前跑」）
    await service.trigger(
      "11111111-1111-4111-8111-111111111111",
      { consumeNextFirePoint: true },
      { id: 7, role: "admin" as never },
    );
    expect(condUpdates).toHaveLength(1);
    expect(taskQueue.add).toHaveBeenCalledTimes(1);

    // 第二次勾选 ⇒ 已有未消耗登记 ⇒ **409**（不静默覆盖）
    await expect(
      service.trigger(
        "11111111-1111-4111-8111-111111111111",
        { consumeNextFirePoint: true },
        { id: 7, role: "admin" as never },
      ),
    ).rejects.toMatchObject({
      errorCode: "TASK_FIRE_POINT_ALREADY_CONSUMED",
      status: 409,
    });
    // 第二次**没有**触发（避免「没登记却跑了」）
    expect(taskQueue.add).toHaveBeenCalledTimes(1);
  });

  it("⑥ 非 cron 任务（fixed_rate）⇒ 400 明确报错，且不登记、不触发", async () => {
    givenTask(
      makeTask({
        triggerType: TaskTriggerType.FIXED_RATE,
        cronExpression: null,
        fixedRate: 60,
      }),
    );
    await expect(
      service.trigger(
        "11111111-1111-4111-8111-111111111111",
        { consumeNextFirePoint: true },
        { id: 7, role: "admin" as never },
      ),
    ).rejects.toMatchObject({
      errorCode: "TASK_FIRE_POINT_NOT_CRON",
      status: 400,
    });
    expect(condUpdates).toHaveLength(0);
    expect(taskQueue.add).not.toHaveBeenCalled();
  });

  it("⑤ 编辑 cron 表达式 ⇒ 旧的未消耗登记**失效并清除**（否则会白吞一次执行）", async () => {
    const task = makeTask({
      consumedFirePointAt: new Date(Date.now() + 60_000),
    });
    // update() 的取数入口（findByIdRaw → findOne）与回读
    taskRepo.findOne.mockResolvedValue(task);
    await service.update(
      "11111111-1111-4111-8111-111111111111",
      { cronExpression: "0 9 * * *" } as never,
      { id: 7, role: "admin" as never },
    );
    // 有一条「清除登记」的条件 UPDATE（谓词 IS NOT NULL）
    const clear = condUpdates.find((u) =>
      u.where.includes('"consumedFirePointAt" IS NOT NULL'),
    );
    expect(clear).toBeDefined();
    expect(clear!.set.consumedFirePointAt).toBeNull();
  });

  it("⑤b 只编辑**其它**字段 ⇒ 登记**不动**（不误清）", async () => {
    const task = makeTask({
      consumedFirePointAt: new Date(Date.now() + 60_000),
    });
    taskRepo.findOne.mockResolvedValue(task);
    await service.update(
      "11111111-1111-4111-8111-111111111111",
      { description: "只是改个描述" } as never,
      { id: 7, role: "admin" as never },
    );
    const clear = condUpdates.find((u) =>
      u.where.includes('"consumedFirePointAt" IS NOT NULL'),
    );
    expect(clear).toBeUndefined();
  });

  it("⑦ 登记**持久化在 DB 行上**（不是进程内状态）⇒ 重启后仍有效", async () => {
    // 登记走的是**条件 UPDATE 写 DB 列**（`tasks.consumedFirePointAt`），
    // 进程内**没有任何** Map/Set 承载它 ⇒ 重启（= 新 service 实例 + 同一行）
    // 后登记仍在。
    //
    // 这里用「同一个 mock 行被两个 service 实例先后读到」来模拟重启：
    // 实例 A 登记 ⇒ 写进 mock 的行；实例 B（新实例）读同一行 ⇒ 登记仍在。
    const persisted = makeTask();
    taskRepo.findOne.mockResolvedValue(persisted);
    await service.trigger(
      "11111111-1111-4111-8111-111111111111",
      { consumeNextFirePoint: true },
      { id: 7, role: "admin" as never },
    );
    const upd = condUpdates[0];
    // 登记写进了 DB 列
    expect(upd.set.consumedFirePointAt).toBeInstanceOf(Date);
    // 模拟落库：把写进列的值回填到行上（重启后读到的是**这一行**）
    persisted.consumedFirePointAt = upd.set.consumedFirePointAt as Date;
    // mock 的有状态谓词也要知道「列上已有登记」⇒ 下一条 UPDATE 的
    // `IS NULL` 谓词必须命中 0 行 ⇒ 409
    (
      taskRepo as unknown as { __setConsumed: (d: Date | null) => void }
    ).__setConsumed?.(persisted.consumedFirePointAt);

    // 「重启」= 新建一个 service 实例（新的内存状态），读同一行
    const module2 = await Test.createTestingModule({
      providers: [
        TaskService,
        { provide: getRepositoryToken(Task), useValue: taskRepo },
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
        {
          provide: getRepositoryToken(ExecutionLogLine),
          useValue: {
            find: jest.fn().mockResolvedValue([]),
            findOne: jest.fn(),
            save: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            createQueryBuilder: jest.fn(),
          },
        },
        { provide: getRepositoryToken(TaskVersion), useValue: versionRepo },
        { provide: getRepositoryToken(ExecutionReport), useValue: {} },
        { provide: getQueueToken("task-queue"), useValue: taskQueue },
        {
          provide: DataSource,
          useValue: {
            transaction: jest.fn(async (cb: (m: unknown) => unknown) =>
              cb({
                create: jest.fn(),
                save: jest.fn(async () => ({ id: "exec-2" })),
              }),
            ),
          },
        },
        {
          provide: SchedulerService,
          useValue: {
            scheduleOne: jest.fn(),
            stop: jest.fn(),
            getStats: jest.fn(() => ({ isLeader: false })),
          },
        },
        { provide: AiService, useValue: {} },
        { provide: AiAnalysisService, useValue: {} },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue("") },
        },
        {
          provide: ExecutorService,
          useValue: {
            getExecutorUrl: jest.fn().mockResolvedValue("http://x"),
            notifyExecutorKill: jest.fn(),
            scheduleRetryAfterRecovery: jest.fn(),
            hasRetryBudget: jest.fn().mockReturnValue(true),
          },
        },
        { provide: DomainEventBus, useValue: { emit: jest.fn() } },
        { provide: AuditService, useValue: auditMock },
        {
          provide: SecretsCryptoService,
          useValue: new SecretsCryptoService({ get: () => "" } as never),
        },
      ],
    }).compile();
    const restarted = module2.get(TaskService);

    // 重启后再勾选 ⇒ 登记仍然存在 ⇒ **409**（不会静默覆盖前一条承诺）
    await expect(
      restarted.trigger(
        "11111111-1111-4111-8111-111111111111",
        { consumeNextFirePoint: true },
        { id: 7, role: "admin" as never },
      ),
    ).rejects.toMatchObject({
      errorCode: "TASK_FIRE_POINT_ALREADY_CONSUMED",
      status: 409,
    });
  });

  it("⑥b cron 表达式非法 ⇒ 400（算不出落点）", async () => {
    givenTask(makeTask({ cronExpression: "not a cron" }));
    await expect(
      service.trigger(
        "11111111-1111-4111-8111-111111111111",
        { consumeNextFirePoint: true },
        { id: 7, role: "admin" as never },
      ),
    ).rejects.toMatchObject({
      errorCode: "TASK_FIRE_POINT_UNRESOLVABLE",
      status: 400,
    });
    expect(condUpdates).toHaveLength(0);
  });
});
