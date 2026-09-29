import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { ExecutorService } from "../executor.service";
import { Executor, ExecutorStatus } from "../entities/executor.entity";
import { ExecutorMetricsHistory } from "../entities/executor-metrics-history.entity";
import { Task } from "../../task/entities/task.entity";
import {
  TaskExecution,
  TaskExecution as TaskExecutionEntity,
  ExecutionStatus,
} from "../../task/entities/task-execution.entity";
import { MutexGroup } from "../../application/entities/mutex-group.entity";
import { MutexWaitError } from "../../task/execution-mutex";
import { NotificationService } from "../../notification/notification.service";
import { SystemConfigService } from "../../config/config.service";
import { SecretsCryptoService } from "../../../common/utils/secret-crypto.util.service";
import { ExecutorPullService } from "../executor-pull.service";
import { TracingService } from "../../../common/tracing/tracing.service";
import { LeaderGateService } from "../../../common/leader-gate/leader-gate.service";
import { AuditService } from "../../audit/audit.service";
import { DomainEventBus } from "../../../common/services/domain-event-bus.service";
import { ExecutorTokenCacheSyncService } from "../token-cache-sync.service";

jest.mock("axios", () => ({ post: jest.fn(), get: jest.fn() }));
jest.mock("../../../common/utils/safe-http.util", () => ({
  ...jest.requireActual("../../../common/utils/safe-http.util"),
  assertSafeExecutorUrl: jest
    .fn()
    .mockResolvedValue(new URL("http://fixture/")),
  assertAndPinExecutorUrl: jest
    .fn()
    .mockImplementation(async (raw: string) => ({
      url: new URL(raw),
      pinnedIp: "93.184.216.34",
      pinned: false,
    })),
}));

/**
 * MUTEX-01（应用互斥组）：占坑路径单测。
 *
 * 覆盖 `claimExecutorSlotForExecution` 的三态判定与「占用从执行行推导」的
 * 落库形状：
 * - 无组执行走原有单条 UPDATE（默认人群零行为变化）；
 * - 挂组执行走事务 + executors 行锁，容量/在线/组占用三闸全过才占坑并
 *   落占用标记（task_executions.executorAddress）；
 * - 组占用满 → mutex_full（dispatch 循环据此抛 MutexWaitError → processor
 *   置 WAITING 排队）；
 * - 组配置缺失（组被删）→ 降级为无组语义。
 */

const makeExecRepoMock = () => ({
  createQueryBuilder: jest.fn(() => ({
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  })),
});

const makeRepoMock = () => ({
  findOne: jest.fn().mockResolvedValue(null),
  find: jest.fn().mockResolvedValue([]),
  findBy: jest.fn().mockResolvedValue([]),
  create: jest.fn((d) => d),
  save: jest.fn((e) => Promise.resolve(e)),
  update: jest.fn().mockResolvedValue({ affected: 1 }),
  createQueryBuilder: jest.fn(() => ({
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    returning: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  })),
  // claimExecutorSlotForExecution 挂组路径经 repo.manager.transaction 开事务
  // （默认无实现——忘记接线的用例会以 "transaction not wired" 失败显式暴露）。
  manager: {
    transaction: jest.fn(),
  },
});

describe("ExecutorService mutex claim (MUTEX-01)", () => {
  let service: ExecutorService;
  let executorRepo: ReturnType<typeof makeRepoMock>;
  let execRepo: ReturnType<typeof makeExecRepoMock>;
  let mutexGroupRepo: { findOne: jest.Mock };
  /** 事务内 query 分发表：按 SQL 片段返回行/记录写操作。 */
  let txQueries: Array<{ sql: string; params?: unknown[] }>;
  let lockRow: Record<string, unknown> | null;
  let occupancyCount: number;

  const candidate = {
    id: "exec-row-1",
    address: "10.0.0.5:3002",
    status: ExecutorStatus.ONLINE,
    runningTaskCount: 3,
    maxConcurrentTasks: 10,
    version: 7,
  } as unknown as Executor;

  const groupedExecution = {
    id: "exec-uuid-1",
    mutexGroupId: "group-1",
    status: ExecutionStatus.RUNNING,
  } as unknown as TaskExecutionEntity;

  beforeEach(async () => {
    executorRepo = makeRepoMock();
    execRepo = makeExecRepoMock();
    mutexGroupRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: "group-1",
        name: "ziniao-browser",
        maxConcurrentPerDevice: 1,
      }),
    };
    txQueries = [];
    lockRow = {
      address: candidate.address,
      status: "online",
      runningTaskCount: 3,
      maxConcurrentTasks: 10,
    };
    occupancyCount = 0;

    executorRepo.manager.transaction.mockImplementation(async (cb: any) => {
      const fakeManager = {
        query: jest.fn(async (sql: string, params?: unknown[]) => {
          txQueries.push({ sql, params });
          if (sql.includes("FOR UPDATE")) {
            return lockRow ? [lockRow] : [];
          }
          if (sql.includes("COUNT(*)")) {
            return [{ count: occupancyCount }];
          }
          return [];
        }),
      };
      return cb(fakeManager);
    });

    const module = await Test.createTestingModule({
      providers: [
        ExecutorService,
        { provide: getRepositoryToken(Executor), useValue: executorRepo },
        {
          provide: getRepositoryToken(TaskExecution as never),
          useValue: execRepo,
        },
        {
          provide: getRepositoryToken(Task as never),
          useValue: makeRepoMock(),
        },
        {
          provide: getRepositoryToken(ExecutorMetricsHistory),
          useValue: makeRepoMock(),
        },
        { provide: getQueueToken("task-queue"), useValue: { add: jest.fn() } },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(undefined) },
        },
        {
          provide: NotificationService,
          useValue: {
            notifyFailure: jest.fn(),
            notifyFailureWithConfig: jest.fn(),
            notifyExecutorOnline: jest.fn(),
            notifyExecutorOffline: jest.fn(),
            sendAll: jest.fn(),
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
        { provide: getRepositoryToken(MutexGroup), useValue: mutexGroupRepo },
        { provide: ExecutorPullService, useValue: null },
        { provide: TracingService, useValue: null },
        { provide: LeaderGateService, useValue: null },
        { provide: AuditService, useValue: null },
        { provide: DomainEventBus, useValue: null },
        { provide: ExecutorTokenCacheSyncService, useValue: null },
      ],
    }).compile();
    service = module.get(ExecutorService);
  });

  // 真正的写操作：排除 "FOR UPDATE" 行锁读（它的 SQL 同样含 UPDATE 字样）。
  const updates = () =>
    txQueries.filter(
      (q) => q.sql.includes("UPDATE") && !q.sql.includes("FOR UPDATE"),
    );
  const occupancyCountQuery = () =>
    txQueries.find((q) => q.sql.includes("COUNT(*)"));

  it("无组执行走原有单条 UPDATE 路径（不开启事务，零行为变化）", async () => {
    const outcome = await (service as any).claimExecutorSlotForExecution(
      candidate,
      { id: "exec-1", mutexGroupId: null } as never,
    );

    expect(outcome).toBe("claimed");
    expect(executorRepo.manager.transaction).not.toHaveBeenCalled();
    expect(executorRepo.createQueryBuilder).toHaveBeenCalled();
  });

  it("挂组执行：占用未满 → 占坑并同事务落占用标记", async () => {
    occupancyCount = 0; // < maxConcurrentPerDevice(1)
    const outcome = await (service as any).claimExecutorSlotForExecution(
      candidate,
      groupedExecution,
    );

    expect(outcome).toBe("claimed");
    const sqls = updates().map((q) => q.sql);
    expect(sqls.some((s) => s.includes('"executors"'))).toBe(true);
    // 占用标记：地址按锁内行值落库（COUNT 用地址入参一致）。
    const marker = updates().find((q) => q.sql.includes('"task_executions"'));
    expect(marker).toBeDefined();
    expect(marker!.params).toEqual([candidate.address, groupedExecution.id]);
    // 占用判定查的是同设备×同组×running。
    expect(occupancyCountQuery()!.params).toEqual([
      candidate.address,
      groupedExecution.mutexGroupId,
    ]);
  });

  it("挂组执行：同设备同组占用已满 → mutex_full（不占坑、不落标记）", async () => {
    occupancyCount = 1; // >= maxConcurrentPerDevice(1)
    const outcome = await (service as any).claimExecutorSlotForExecution(
      candidate,
      groupedExecution,
    );

    expect(outcome).toBe("mutex_full");
    expect(updates()).toHaveLength(0);
  });

  it("挂组执行：设备离线 → unavailable", async () => {
    lockRow = { ...lockRow!, status: "offline" };
    const outcome = await (service as any).claimExecutorSlotForExecution(
      candidate,
      groupedExecution,
    );
    expect(outcome).toBe("unavailable");
    expect(updates()).toHaveLength(0);
  });

  it("挂组执行：设备容量已满 → unavailable（容量闸先于占用闸）", async () => {
    lockRow = { ...lockRow!, runningTaskCount: 10 };
    const outcome = await (service as any).claimExecutorSlotForExecution(
      candidate,
      groupedExecution,
    );
    expect(outcome).toBe("unavailable");
    expect(occupancyCountQuery()).toBeUndefined();
  });

  it("挂组执行：组已被删除 → 降级为无组语义（走 legacy 路径，不阻断派发）", async () => {
    mutexGroupRepo.findOne.mockResolvedValue(null);
    const outcome = await (service as any).claimExecutorSlotForExecution(
      candidate,
      groupedExecution,
    );
    expect(outcome).toBe("claimed");
    expect(executorRepo.manager.transaction).not.toHaveBeenCalled();
  });

  it("MutexWaitError 消息带 [mutex_wait] token（processor 分类链的识别锚点）", () => {
    const err = new MutexWaitError("等待同组执行释放");
    expect(err.message.startsWith("[mutex_wait]")).toBe(true);
  });
});
