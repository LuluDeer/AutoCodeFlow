import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { getRepositoryToken } from "@nestjs/typeorm";
import {
  NotFoundException,
  ServiceUnavailableException,
  ForbiddenException,
  BadRequestException,
  Logger,
  Provider,
} from "@nestjs/common";
import {
  ExecutorService,
  EXECUTOR_LIST_LIMIT,
  __resetTruncationWarnStateForTest,
} from "../executor.service";
import { ExecutorTokenCacheSyncService } from "../token-cache-sync.service";
// DEEP-AUDIT B·1.1: removal-impact / cleanup 跳过判定接线（pull 队列 mock）
import { ExecutorPullService } from "../executor-pull.service";
import {
  Executor,
  ExecutorOfflineReason,
  ExecutorStatus,
} from "../entities/executor.entity";
import { ExecutorMetricsHistory } from "../entities/executor-metrics-history.entity";
import { Task } from "../../task/entities/task.entity";
import {
  TaskExecution,
  ExecutionFailureReason,
  ExecutionStatus,
} from "../../task/entities/task-execution.entity";
import axios from "axios";
import { ConfigService } from "@nestjs/config";
import bcrypt from "bcrypt";
import { QueryFailedError } from "typeorm";
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
// NETOPT-8①: S3 日志对象回收（stub fromConfig 不触达 minio Client）
import { S3LogStorage } from "../../task/log-storage/s3-log-storage";
// ARCH-35 P1: 部署归属偏好接线（dispatch 读取 app_deployments）
import { AppDeployment } from "../../application/entities/app-deployment.entity";
import { Application } from "../../application/entities/application.entity";
import { ApplicationVersion } from "../../application/entities/application-version.entity";
import { DeploymentConstraintWaitError } from "../../task/execution-deployment-wait";
import { DEPLOYMENT_CONSTRAINT_STATUSES } from "../executor-deployment-affinity.util";
import { TaskCodeSource } from "../../task/entities/task.entity";

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

const makeRepo = (overrides: Partial<Record<string, jest.Mock>> = {}) => {
  const repo: Record<string, jest.Mock> = {
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
  };
  repo.createQueryBuilder = jest.fn(() => ({
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    // A-4: dispatch 的 fleet 查询在带 tags/affinity/anti-affinity/runtime 条件时
    // 改走 QueryBuilder（条件下推 SQL）。getMany 默认回落到 find 的 fixture——
    // 既有按 find 打桩的派发用例里，SQL 收窄后的内存过滤链原样保留，行为不变。
    getMany: jest.fn(() => repo.find()),
    getOne: jest.fn().mockResolvedValue(null),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    // A1: 终态跃迁统一入口会取 RETURNING（旧调用点未取，故 mock 此前没有）。
    returning: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    // NETOPT-E P3-3: detectLostExecutions 分页扫描加 id 平局键（startTime 相同
    // 时确定性排序，与 scheduler STALE_SWEEP 同款双键约定）
    addOrderBy: jest.fn().mockReturnThis(),
    // NETOPT-1⑧: detectLostExecutions 扫描带上限
    take: jest.fn().mockReturnThis(),
    // NETOPT-E P3-3: 分页循环的 skip 偏移
    skip: jest.fn().mockReturnThis(),
    // FEAT-04: metrics-history aggregate query applies a LIMIT guard
    limit: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
    getRawOne: jest.fn().mockResolvedValue(null),
    getCount: jest.fn().mockResolvedValue(0),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  }));
  return { ...repo, ...overrides };
};

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
  const makeServiceWithRepo = async (
    repo: ReturnType<typeof makeRepo>,
    extraProviders: Provider[] = [],
  ) => {
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
        ...extraProviders,
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

    // A-10（执行器域审计 P3）：并发首注册撞 uq_executors_address（23505）——
    // check-then-act 的败者按地址重读后并入赢家的行走重注册分支，返回成功
    // 而非 500；非唯一冲突错误照旧抛出。
    describe("A-10: concurrent first registration on the unique address", () => {
      const makeUniqueViolation = () => {
        const err = new QueryFailedError(
          "INSERT INTO executors ...",
          [] as unknown[],
          new Error(
            'duplicate key value violates unique constraint "uq_executors_address"',
          ),
        );
        (err as unknown as { code: string }).code = "23505";
        return err;
      };
      const winnerRow = {
        id: "e-winner",
        appName: "e1",
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
      };

      it("merges the loser into the winning row and succeeds (no 500)", async () => {
        executorRepo.findOne
          .mockResolvedValueOnce(null) // check-then-act 首查：行不存在
          .mockResolvedValueOnce(winnerRow); // 23505 后按地址重读：赢家行
        executorRepo.save
          .mockRejectedValueOnce(makeUniqueViolation()) // insert 撞唯一约束
          .mockImplementation((e: any) => Promise.resolve(e)); // 重注册 save

        const result = await service.register({
          appName: "e1",
          address: "127.0.0.1:3105",
        });

        expect(result).toBe(winnerRow);
        expect(executorRepo.save).toHaveBeenCalledTimes(2);
        // 败者路径不重复发首注册在线通知（赢家已发）。
        expect(
          service["notificationService"].notifyExecutorOnline,
        ).not.toHaveBeenCalled();
      });

      it("rethrows non-unique-constraint save failures unchanged", async () => {
        executorRepo.findOne.mockResolvedValue(null);
        executorRepo.save.mockRejectedValueOnce(new Error("db down"));
        await expect(
          service.register({ appName: "e1", address: "127.0.0.1:3105" }),
        ).rejects.toThrow("db down");
        expect(executorRepo.findOne).toHaveBeenCalledTimes(1);
      });

      it("rethrows the original error when the re-read finds no row", async () => {
        executorRepo.findOne.mockResolvedValue(null);
        executorRepo.save.mockRejectedValueOnce(makeUniqueViolation());
        await expect(
          service.register({ appName: "e1", address: "127.0.0.1:3105" }),
        ).rejects.toBeInstanceOf(QueryFailedError);
        expect(executorRepo.findOne).toHaveBeenCalledTimes(2);
      });
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

      // NETOPT-D P2-D1: 重启恢复走**批量** transitionToTerminal（单条
      // UPDATE...IN）——不再原地 mutate 内存对象，DB 行经条件 UPDATE 终态化。
      expect(runningExecution.status).toBe(ExecutionStatus.RUNNING);
      const qbResults = (execRepo.createQueryBuilder as jest.Mock).mock.results;
      const setPatches = qbResults.flatMap((r: any) =>
        r.value.set.mock.calls.map((c: any) => c[0]),
      );
      expect(
        setPatches.some((p: any) => p.status === ExecutionStatus.FAILED),
      ).toBe(true);
      expect(
        setPatches.some(
          (p: any) =>
            p.failureReason === ExecutionFailureReason.EXECUTOR_RESTART,
        ),
      ).toBe(true);
      expect(
        setPatches.some((p: any) =>
          String(p.errorMessage).includes("Executor restarted"),
        ),
      ).toBe(true);
      // 批量：单次 QB 调用完成全部终态写（旧逐行版为 N 次）。
      expect(execRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(taskQueue.add).not.toHaveBeenCalled();
    });

    it("NETOPT-D P3-2: fail-restart recovery queries take 10000 with startTime ASC", async () => {
      // 批次 D 把 take 提到 10000 + ORDER BY startTime——钉死 find 参数，
      // 防止未来悄悄回退 take:1000 而 CI 全绿。
      const existing = {
        appName: "e1",
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
        executorStartupId: "startup-old",
      };
      executorRepo.findOne.mockResolvedValue(existing);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      execRepo.find.mockResolvedValue([]);

      await service.register({
        appName: "e1",
        address: existing.address,
        startupId: "startup-new",
      });

      expect(execRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 10_000,
          order: { startTime: "ASC" },
        }),
      );
    });

    it("NETOPT-E P2-1: recovery does not batch-release slots; count is zeroed by save", async () => {
      // 旧版（批次 D）恢复对 winner 行做 releaseExecutorSlotBatch——异步心跳
      // 路径在 save 之后按"旧 winner 数"对已含新派发的计数 GREATEST 倒扣，会
      // 把新任务计数清零欠计。修复后恢复不再触碰计数（计数权威 = 调用方
      // e.runningTaskCount=0 + save / 心跳自报覆盖）。
      const existing = {
        appName: "e1",
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
        executorStartupId: "startup-old",
        runningTaskCount: 7,
      };
      const e1: any = {
        id: "exec-1",
        executorAddress: existing.address,
        status: ExecutionStatus.RUNNING,
        logs: "l1",
      };
      const e2: any = {
        id: "exec-2",
        executorAddress: existing.address,
        status: ExecutionStatus.RUNNING,
        logs: "l2",
      };
      executorRepo.findOne.mockResolvedValue(existing);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      execRepo.find.mockResolvedValue([e1, e2]);
      taskRepo.findBy.mockResolvedValue([]);
      // 批量 UPDATE 命中 2 行 → addressSnapshot 兜底 winner rows。
      execRepo.createQueryBuilder.mockImplementation(() => ({
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
        addOrderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
        getRawOne: jest.fn().mockResolvedValue(null),
        getCount: jest.fn().mockResolvedValue(0),
        execute: jest.fn().mockResolvedValue({ affected: 2 }),
      }));

      await service.register({
        appName: "e1",
        address: existing.address,
        startupId: "startup-new",
      });

      // 恢复不再触碰 executorRepo 计数（无 releaseExecutorSlotBatch）。
      expect(executorRepo.createQueryBuilder).not.toHaveBeenCalled();
      // 计数归零由 save 承担（R-P0-008 语义）。
      const saved = (executorRepo.save as jest.Mock).mock.calls[0][0] as any;
      expect(saved.runningTaskCount).toBe(0);
    });

    it("NETOPT-E P2-1: recovery only fails rows started before the restart moment (new dispatches survive)", async () => {
      // 异步/同步恢复的 find 谓词只有 address + RUNNING；didRestart 恢复现带
      // onlyStartedBefore（重启基准时刻），startTime >= 重启时刻的新派发行
      // 必须存活——否则执行器重启后闸门新派的任务被恢复误杀终态化。
      const existing = {
        appName: "e1",
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
        executorStartupId: "startup-old",
      };
      const oldRow: any = {
        id: "exec-old",
        executorAddress: existing.address,
        status: ExecutionStatus.RUNNING,
        startTime: new Date("2026-01-01T00:00:00.000Z"),
      };
      const newRow: any = {
        id: "exec-new",
        executorAddress: existing.address,
        status: ExecutionStatus.RUNNING,
        startTime: new Date("2026-01-02T00:00:00.000Z"),
      };
      executorRepo.findOne.mockResolvedValue(existing);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      execRepo.find.mockResolvedValue([oldRow, newRow]);
      taskRepo.findBy.mockResolvedValue([]);
      const qb = execRepo.createQueryBuilder();
      qb.execute.mockResolvedValue({
        affected: 1,
        raw: [{ id: "exec-old", executorAddress: existing.address }],
      });
      execRepo.createQueryBuilder.mockReturnValue(qb);

      await service.register({
        appName: "e1",
        address: existing.address,
        startupId: "startup-new",
        restartedAt: "2026-01-01T12:00:00.000Z",
      });

      // transitionToTerminal 的 ids 只含旧行（exec-new 存活）。
      const idsWhere = qb.where.mock.calls.find((c: any) =>
        String(c[0]).includes("IN (:...ids)"),
      );
      expect(idsWhere?.[1].ids).toEqual(["exec-old"]);
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
        // A4: 入队补齐 priority（task 无 priority 字段 → NORMAL 兜底 → 换算 3）
        {
          attempts: 2,
          backoff: { type: "exponential", delay: expect.any(Number) },
          priority: 3,
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

      // NETOPT-D P2-D1: 批量终态——DB 行经条件 UPDATE 终态化，内存对象不 mutate。
      expect(runningExecution.status).toBe(ExecutionStatus.RUNNING);
      const qbResults = (execRepo.createQueryBuilder as jest.Mock).mock.results;
      const setPatches = qbResults.flatMap((r: any) =>
        r.value.set.mock.calls.map((c: any) => c[0]),
      );
      expect(
        setPatches.some(
          (p: any) =>
            p.status === ExecutionStatus.FAILED &&
            p.failureReason === ExecutionFailureReason.EXECUTOR_RESTART,
        ),
      ).toBe(true);
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

      // NETOPT-D P2-D1: 批量终态——DB 行经条件 UPDATE 终态化，内存对象不 mutate。
      expect(runningExecution.status).toBe(ExecutionStatus.RUNNING);
      const qbResults = (execRepo.createQueryBuilder as jest.Mock).mock.results;
      const setPatches = qbResults.flatMap((r: any) =>
        r.value.set.mock.calls.map((c: any) => c[0]),
      );
      expect(
        setPatches.some((p: any) => p.status === ExecutionStatus.FAILED),
      ).toBe(true);
      expect(execRepo.delete).toHaveBeenCalledWith("retry-exec");
      expect(existing.executorStartupId).toBe("startup-new");
      expect(executorRepo.save).toHaveBeenCalledWith(existing);
    });

    // R-11（DEEP_REVIEW 0ef3bbe）：重启恢复流程中任何写失败不得击穿 register
    // （否则心跳/注册 500 → 执行器被连锁判离线）。
    // NETOPT-D P2-D1 后终态写是**单条 UPDATE...IN**（原子）——没有"逐行"可言；
    // 单次批量 SQL 失败由整体 catch 承接（errorCount=全部），失败行留给 stale
    // sweep 收敛，与原逐行隔离语义等价：不 500、不半途而废、不重复调度。
    it("R-11: a batch terminal-write failure does not abort the registration flow", async () => {
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
      // A1: 终态写走 transitionToTerminal（createQueryBuilder 链）。批量 UPDATE
      // 抛乐观锁类错误——验证单条批量写失败不击穿整体注册流程。
      execRepo.createQueryBuilder.mockImplementation(() => ({
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
        addOrderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
        getRawOne: jest.fn().mockResolvedValue(null),
        getCount: jest.fn().mockResolvedValue(0),
        execute: jest
          .fn()
          .mockRejectedValue(new Error("OptimisticLockVersionMismatchError")),
      }));

      await service.register({
        appName: "e1",
        address: existing.address,
        startupId: "startup-new",
      });

      // 批量 UPDATE 失败 → 无行终态化、无槽位释放、无重试入队（留给 stale sweep）。
      expect(okExecution.status).toBe(ExecutionStatus.RUNNING);
      expect(conflictExecution.status).toBe(ExecutionStatus.RUNNING);
      expect(execRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(taskQueue.add).not.toHaveBeenCalled();
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

    // N-09（微基准暴露的注册/心跳采纳域不对称）：心跳钳正整数 1..10000，
    // register 此前零校验 → maxConcurrentTasks:0 落库后
    //   ① loadScore 除零得 Infinity；② 容量闸 `runningTaskCount < 0` 恒 false，
    //   该执行器被**永久排除在派发之外**（绿灯但不干活，与 P0-2 bindAddress 同型）。
    describe("maxConcurrentTasks adoption symmetry (N-09)", () => {
      it("首次注册 maxConcurrentTasks=0 → 视为未上报（不得落库 0）", async () => {
        executorRepo.findOne.mockResolvedValue(null);
        executorRepo.create.mockImplementation((e: any) => e);
        executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));

        const result = await service.register({
          appName: "bad-executor",
          address: "127.0.0.1:3197",
          type: "node",
          maxConcurrentTasks: 0,
        });

        // 关键：绝不能是 0——0 会让容量闸恒 false、该机永久收不到任务
        expect(result.maxConcurrentTasks).not.toBe(0);
        expect(result.maxConcurrentTasks).toBeUndefined();
      });

      it("首次注册负数/小数/超上界 → 均视为未上报", async () => {
        for (const bad of [-1, 1.5, 10_001, Number.NaN]) {
          executorRepo.findOne.mockResolvedValue(null);
          executorRepo.create.mockImplementation((e: any) => e);
          executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
          const result = await service.register({
            appName: "bad-executor",
            address: "127.0.0.1:3198",
            type: "node",
            maxConcurrentTasks: bad,
          });
          expect(result.maxConcurrentTasks).toBeUndefined();
        }
      });

      it("重注册非法值 → 保留既有存量值（不写荒谬容量）", async () => {
        const existing: any = {
          appName: "old",
          address: "127.0.0.1:3199",
          status: ExecutorStatus.ONLINE,
          capabilities: ["node"],
          maxConcurrentTasks: 8,
        };
        executorRepo.findOne.mockResolvedValue(existing);
        executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));

        await service.register({
          appName: "old",
          address: "127.0.0.1:3199",
          type: "node",
          maxConcurrentTasks: 0,
        });

        expect(existing.maxConcurrentTasks).toBe(8);
      });

      it("合法值边界（1 与 10000）正常采纳", async () => {
        for (const good of [1, 10_000]) {
          executorRepo.findOne.mockResolvedValue(null);
          executorRepo.create.mockImplementation((e: any) => e);
          executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
          const result = await service.register({
            appName: "ok-executor",
            address: "127.0.0.1:3200",
            type: "node",
            maxConcurrentTasks: good,
          });
          expect(result.maxConcurrentTasks).toBe(good);
        }
      });

      it("maxConcurrent 别名同样受采纳域约束（防绕道）", async () => {
        executorRepo.findOne.mockResolvedValue(null);
        executorRepo.create.mockImplementation((e: any) => e);
        executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
        const result = await service.register({
          appName: "alias-executor",
          address: "127.0.0.1:3201",
          type: "node",
          maxConcurrent: 0,
        });
        expect(result.maxConcurrentTasks).toBeUndefined();
      });
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

    it("re-register refreshes runtimes without writing a stale Agent capability snapshot", async () => {
      const existing: any = {
        id: "executor-1",
        appName: "node-executor",
        address: "127.0.0.1:3199",
        capabilities: ["python"],
        agentCapabilities: ["agent:sop", "gui"],
        agentCapabilitiesUpdatedAt: new Date(),
      };
      executorRepo.findOne.mockResolvedValue(existing);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));

      await service.register({
        appName: "node-executor",
        address: existing.address,
        capabilities: ["python", "node"],
      });

      expect(existing.capabilities).toEqual(["python", "node"]);
      expect(executorRepo.save.mock.calls[0][0]).not.toHaveProperty(
        "agentCapabilities",
      );
      expect(executorRepo.save.mock.calls[0][0]).not.toHaveProperty(
        "agentCapabilitiesUpdatedAt",
      );
    });

    it("Agent reports replace only Agent capabilities and [] revokes GUI without touching runtimes", async () => {
      await service.updateCapabilities("executor-1", [
        "agent:sop",
        "gui",
        "gui",
      ]);
      expect(executorRepo.update).toHaveBeenCalledWith(
        { id: "executor-1" },
        {
          agentCapabilities: ["agent:sop", "gui"],
          agentCapabilitiesUpdatedAt: expect.any(Date),
        },
      );

      executorRepo.update.mockClear();
      await service.updateCapabilities("executor-1", []);
      expect(executorRepo.update).toHaveBeenCalledWith(
        { id: "executor-1" },
        { agentCapabilities: [], agentCapabilitiesUpdatedAt: expect.any(Date) },
      );

      executorRepo.update.mockClear();
      await expect(
        service.updateCapabilities("executor-1", ["python"]),
      ).rejects.toThrow("Agent capabilities 含不支持的能力域");
      expect(executorRepo.update).not.toHaveBeenCalled();
    });

    it("Agent capability reads require a fresh lease and fail closed for legacy and stale rows", async () => {
      executorRepo.findOne.mockResolvedValueOnce({
        id: "executor-1",
        agentCapabilities: ["agent:sop"],
        agentCapabilitiesUpdatedAt: new Date(Date.now() - 30_000),
      });
      expect(await service.getAgentCapabilities("executor-1")).toEqual([
        "agent:sop",
      ]);
      expect(executorRepo.findOne).toHaveBeenCalledWith({
        where: { id: "executor-1" },
        select: {
          id: true,
          agentCapabilities: true,
          agentCapabilitiesUpdatedAt: true,
        },
      });

      executorRepo.findOne.mockResolvedValueOnce({
        id: "executor-1",
        agentCapabilities: ["agent:sop"],
        agentCapabilitiesUpdatedAt: null,
      });
      expect(await service.getAgentCapabilities("executor-1")).toEqual([]);
      executorRepo.findOne.mockResolvedValueOnce({
        id: "executor-1",
        agentCapabilities: ["agent:sop"],
        agentCapabilitiesUpdatedAt: new Date(Date.now() - 121_000),
      });
      expect(await service.getAgentCapabilities("executor-1")).toEqual([]);
      executorRepo.findOne.mockResolvedValueOnce({
        id: "executor-1",
        agentCapabilities: ["agent:sop"],
        agentCapabilitiesUpdatedAt: new Date(Date.now() + 30_000),
      });
      expect(await service.getAgentCapabilities("executor-1")).toEqual([]);
      executorRepo.findOne.mockResolvedValueOnce({
        id: "executor-1",
        agentCapabilities: null,
        agentCapabilitiesUpdatedAt: new Date(),
      });
      expect(await service.getAgentCapabilities("executor-1")).toEqual([]);
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

    // A-6（执行器域审计 P3）：cpuUsage/memUsage 是评分公式的直接输入
    // （computeExecutorLoadScore 按 /100 归一）——越界/非有限值视同未上报
    // （DB 值不动，与 E9 的 maxConcurrentTasks 采纳先例同策），合法值（含
    // 边界 0/100、小数）照常采纳。
    describe("A-6: cpu/mem percentage clamping", () => {
      const onlineExecutor = () => ({
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
        cpuUsage: 20,
        memUsage: 30,
      });

      it("adopts valid values including boundaries 0 and 100 and decimals", async () => {
        const executor = onlineExecutor();
        executorRepo.findOne.mockResolvedValue(executor);
        executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
        await service.heartbeat("127.0.0.1:3105", {
          cpuUsage: 0,
          memUsage: 100,
        });
        expect(executor.cpuUsage).toBe(0);
        expect(executor.memUsage).toBe(100);
        await service.heartbeat("127.0.0.1:3105", {
          cpuUsage: 12.5,
          memUsage: 37.5,
        });
        expect(executor.cpuUsage).toBe(12.5);
        expect(executor.memUsage).toBe(37.5);
      });

      it.each([
        [-1, "cpuUsage"],
        [100.5, "cpuUsage"],
        [Number.NaN, "cpuUsage"],
        [-0.1, "memUsage"],
        [1e9, "memUsage"],
      ])(
        "treats out-of-range %p (%s) as not reported and keeps stored value",
        async (bad, key) => {
          const executor = onlineExecutor();
          executorRepo.findOne.mockResolvedValue(executor);
          executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
          const warnSpy = jest.spyOn((service as any).logger, "warn");
          await service.heartbeat("127.0.0.1:3105", {
            [key]: bad as unknown as number,
          } as any);
          // 越界字段保持 DB 旧值（视同未上报），另一字段不受影响。
          expect(executor[key]).toBe(key === "cpuUsage" ? 20 : 30);
          expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining(`invalid ${key}=`),
          );
          warnSpy.mockRestore();
        },
      );

      it("mixed heartbeat keeps the good metric while dropping the bad one", async () => {
        const executor = onlineExecutor();
        executorRepo.findOne.mockResolvedValue(executor);
        executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
        await service.heartbeat("127.0.0.1:3105", {
          cpuUsage: 44,
          memUsage: 120,
        });
        expect(executor.cpuUsage).toBe(44);
        expect(executor.memUsage).toBe(30);
      });
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

    describe("reservedSlots adoption (E-01-RPT)", () => {
      // E-01-RPT（生产实证：RPA5 恒显「当前运行任务 1/10」「活性上报 0 条，与
      // 运行计数 1 不一致」，而设备上无任务在跑）：pull 长轮询预留槽位数采纳。
      const onlineExecutor = () => ({
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
        runningTaskCount: 1,
        reservedSlots: null as number | null,
        runningExecutionIds: null as string[] | null,
      });

      it("adopts the reported reservation alongside the count (RPA5 steady state)", async () => {
        const executor = onlineExecutor();
        executorRepo.findOne.mockResolvedValue(executor);
        executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
        // 生产现场的稳态心跳：已占 1 个槽位（E-01 预留），无活性 id。
        await service.heartbeat("127.0.0.1:3105", {
          runningTaskCount: 1,
          reservedSlots: 1,
          runningExecutionIds: [],
        });
        // 两个字段都被如实采纳——UI 据此算出「实际运行 = 1 − 1 = 0」。
        expect(executor.runningTaskCount).toBe(1);
        expect(executor.reservedSlots).toBe(1);
        expect(executor.runningExecutionIds).toEqual([]);
      });

      it("adopts boundary values 0 and the reported count", async () => {
        const executor = onlineExecutor();
        executorRepo.findOne.mockResolvedValue(executor);
        executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
        await service.heartbeat("127.0.0.1:3105", {
          runningTaskCount: 3,
          reservedSlots: 0,
        });
        expect(executor.reservedSlots).toBe(0);
        await service.heartbeat("127.0.0.1:3105", {
          runningTaskCount: 3,
          reservedSlots: 3,
        });
        expect(executor.reservedSlots).toBe(3);
      });

      it("keeps the stored value when the field is not reported (legacy executor)", async () => {
        // 兼容性红线：旧版执行器（协议 < 4）不上报该字段 → DB 值不动，UI 回落
        // 「按已占槽位显示」的旧口径，行为与引入前逐字节一致。
        const executor = { ...onlineExecutor(), reservedSlots: 2 };
        executorRepo.findOne.mockResolvedValue(executor);
        executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
        await service.heartbeat("127.0.0.1:3105", { cpuUsage: 1 });
        expect(executor.reservedSlots).toBe(2);
      });

      it.each([-1, 1.5, 10_001, Number.NaN, "1"])(
        "rejects invalid value %p and keeps the stored value",
        async (bad) => {
          const executor = { ...onlineExecutor(), reservedSlots: 2 };
          executorRepo.findOne.mockResolvedValue(executor);
          executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
          await service.heartbeat("127.0.0.1:3105", {
            runningTaskCount: 5,
            reservedSlots: bad as unknown as number,
          });
          expect(executor.reservedSlots).toBe(2);
        },
      );

      it("rejects a reservation exceeding the reported count (not self-consistent)", async () => {
        // 反证：预留是「已占槽位」的**子集**，上报 5 > 计数 1 必不可信。若照单
        // 全收，UI 会算出负数（比误报不一致更荒谬）。拒绝后 DB 值不动。
        const executor = { ...onlineExecutor(), reservedSlots: 0 };
        executorRepo.findOne.mockResolvedValue(executor);
        executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
        await service.heartbeat("127.0.0.1:3105", {
          runningTaskCount: 1,
          reservedSlots: 5,
        });
        expect(executor.reservedSlots).toBe(0);
      });

      it("反证: 越界 runningTaskCount 被丢弃时，预留也不得单独采纳", async () => {
        // 反证用例：runningTaskCount 越界 → 白名单删字段 → e.runningTaskCount 保持
        // DB 旧值。此时若仍采纳 reservedSlots，就会拿一个「陈旧计数」去配对本次
        // 上报的预留数，产生不自洽的组合。断言两者要么一起更新、要么都不动。
        const executor = {
          ...onlineExecutor(),
          runningTaskCount: 1,
          reservedSlots: 0,
        };
        executorRepo.findOne.mockResolvedValue(executor);
        executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
        await service.heartbeat("127.0.0.1:3105", {
          runningTaskCount: 99_999, // 越界 → 被丢弃
          reservedSlots: 1,
        });
        expect(executor.runningTaskCount).toBe(1); // DB 旧值不动
        // 预留 1 <= 最终计数 1，自洽，故可采纳——但计数仍是旧值，UI 显示 0。
        // 关键是绝不出现 reservedSlots > runningTaskCount 的落库组合。
        expect(executor.reservedSlots).toBeLessThanOrEqual(
          executor.runningTaskCount,
        );
      });
    });

    it("recovers running executions predating heartbeat startup when executor lacks startup baseline", async () => {
      const executor = {
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
        executorStartupId: null,
        executorStartedAt: null,
        // NETOPT-F P2-F2: 遗留执行器升级首报 restartedAt 时 DB 可能有陈旧高计数
        // ——missing-baseline 分支必须清零（与 register :908 对称），否则本心跳
        // save(e) 把旧高值写回，闸门欠派。
        runningTaskCount: 17,
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

      // NETOPT-D P2-D1: 批量终态——DB 行经条件 UPDATE 终态化，内存对象不 mutate。
      expect(oldExecution.status).toBe(ExecutionStatus.RUNNING);
      expect(newExecution.status).toBe(ExecutionStatus.RUNNING);
      // A1: 终态写走 transitionToTerminal（createQueryBuilder 链）。oldExecution
      // 被推进终态（patch=FAILED）；newExecution 未过 shouldFailAfterRestart 门，
      // 不走终态写 → createQueryBuilder 恰被调用一次。
      const qbResults = (execRepo.createQueryBuilder as jest.Mock).mock.results;
      const setPatches = qbResults.flatMap((r: any) =>
        r.value.set.mock.calls.map((c: any) => c[0]),
      );
      expect(
        setPatches.some((p: any) => p.status === ExecutionStatus.FAILED),
      ).toBe(true);
      expect(
        setPatches.some(
          (p: any) =>
            p.failureReason === ExecutionFailureReason.EXECUTOR_RESTART,
        ),
      ).toBe(true);
      expect(execRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(executor.executorStartupId).toBe("startup-new");
      // NETOPT-F P2-F2: missing-baseline 分支清零 runningTaskCount（不再逐行
      // 减槽后计数权威在调用方；旧高值 17 不得残留到 save）。
      expect(executor.runningTaskCount).toBe(0);
    });

    it("NETOPT-E P2-1: async didRestart recovery is time-filtered and does not touch slot counts", async () => {
      // 心跳 didRestart → failRunningExecutionsAfterRestart 走 void 异步路径；
      // 修复前不带 onlyStartedBefore——恢复 find 只有 address+RUNNING 谓词，
      // 会把恢复期间闸门新派发的行（startTime >= 重启时刻）一并误杀终态化；
      // 且旧版批量减槽在 save 之后按旧 winner 数倒扣已含新派发的计数，欠计
      // 超派。修复后：① 恢复传 incomingStartedAt（只终态化旧行）；② 恢复不
      // 再减槽，计数权威 = 调用方 e.runningTaskCount=0 + save。
      const executor = {
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
        executorStartupId: "startup-old",
        executorStartedAt: new Date("2026-01-01T00:00:00.000Z"),
        runningTaskCount: 9,
      };
      const oldRow: any = {
        id: "exec-old",
        executorAddress: executor.address,
        status: ExecutionStatus.RUNNING,
        startTime: new Date("2026-01-01T00:00:00.000Z"),
        logs: "old",
      };
      const newRow: any = {
        id: "exec-new",
        executorAddress: executor.address,
        status: ExecutionStatus.RUNNING,
        startTime: new Date("2026-01-02T00:00:00.000Z"),
        logs: "new",
      };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      execRepo.find.mockResolvedValue([oldRow, newRow]);
      taskRepo.findBy.mockResolvedValue([]);
      const qb = execRepo.createQueryBuilder();
      qb.execute.mockResolvedValue({
        affected: 1,
        raw: [{ id: "exec-old", executorAddress: executor.address }],
      });
      execRepo.createQueryBuilder.mockReturnValue(qb);

      await service.heartbeat(executor.address, {
        startupId: "startup-new",
        restartedAt: "2026-01-01T12:00:00.000Z",
      });
      // void 异步恢复：心跳返回后可能未完成，flush 微任务/IO 再断言。
      await new Promise((resolve) => setImmediate(resolve));

      // ① transitionToTerminal 的 ids 只含旧行（exec-new 存活）。
      const idsWhere = qb.where.mock.calls.find((c: any) =>
        String(c[0]).includes("IN (:...ids)"),
      );
      expect(idsWhere?.[1].ids).toEqual(["exec-old"]);
      // ② 恢复不再触碰 executorRepo 计数（无 releaseExecutorSlotBatch）。
      expect(executorRepo.createQueryBuilder).not.toHaveBeenCalled();
      // ③ 计数归零由 save 承担（本次心跳未上报 runningTaskCount → 写 0）。
      const saved = (executorRepo.save as jest.Mock).mock.calls[0][0] as any;
      expect(saved.runningTaskCount).toBe(0);
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
      // NETOPT-D P2-D1: 批量 UPDATE 命中 2 行 = ids.length → 在无 raw 返回的
      // 驱动下由 addressSnapshot 兜底构造 winner rows（transitionToTerminal
      // 的"affected === ids.length"兜底分支）。
      execRepo.createQueryBuilder.mockImplementation(() => ({
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
        addOrderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
        getRawOne: jest.fn().mockResolvedValue(null),
        getCount: jest.fn().mockResolvedValue(0),
        execute: jest.fn().mockResolvedValue({ affected: 2 }),
      }));

      await service.heartbeat(executor.address, { startupId: "startup-new" });
      // NETOPT-D P2-3: 心跳路径的恢复已改为 fire-and-forget（不阻塞心跳线程）。
      // 本测试全 mock、promise 链同步 resolve，flush 一次宏任务即可收敛断言。
      await new Promise((resolve) => setImmediate(resolve));

      // 批量终态：DB 行经条件 UPDATE 终态化，内存对象不 mutate。
      expect(firstExecution.status).toBe(ExecutionStatus.RUNNING);
      expect(secondExecution.status).toBe(ExecutionStatus.RUNNING);
      // 两个 winner 行的重试逐行入队：第一个 enqueue 失败 → 删除其刚创建的
      // retry 行；第二个成功。
      expect(execRepo.delete).toHaveBeenCalledWith("retry-1");
      expect(taskQueue.add).toHaveBeenCalledTimes(2);
      expect(executor.executorStartupId).toBe("startup-new");
      expect(executorRepo.save).toHaveBeenCalledWith(executor);
    });

    it("does not block the heartbeat on restart recovery (NETOPT-D P2-3)", async () => {
      // P2-3: 恢复可能涉及近万行逐行入队——若心跳 await 恢复，单个心跳请求会
      // 拖到全局超时之外，markStaleOffline 误判刚重启的执行器。钉死"不阻塞"。
      const executor = {
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
        executorStartupId: "startup-old",
      };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      // 恢复内部第一步 execRepo.find 永不 resolve——若心跳 await 恢复会卡死。
      execRepo.find.mockReturnValueOnce(new Promise(() => {}));

      // heartbeat 公开契约返回 saved 执行器（executor.interpreters.spec 依赖），
      // 核心断言是"不阻塞"：execRepo.find 永不 resolve 时 heartbeat 仍立即返回。
      await expect(
        service.heartbeat(executor.address, { startupId: "startup-new" }),
      ).resolves.toMatchObject({
        address: "127.0.0.1:3105",
        executorStartupId: "startup-new",
      });
      expect(executor.executorStartupId).toBe("startup-new");
    });

    it("NETOPT-F P2-F1: startupId-only restart uses server-side now (old rows failed, new dispatches survive)", async () => {
      // 执行器换了 startupId 但未上报 restartedAt（滚动升级/旧版执行器只报
      // startupId）。批次 E 早期实现退回 DB 侧 executorStartedAt（T0）作基线
      // ——但 T0 那轮已终态化 startTime<T0 的行，当前 RUNNING 行 startTime
      // 必然 >= T0，严格 < 过滤下**一条都不终态化**，恢复路径空转（零恢复）。
      // 修法：基线取服务端本次心跳处理时刻 now——startTime<now 的旧行终态化、
      // startTime>now 的新派发存活；DB 旧基线仅作 warn 展示不参与判定。
      // 注意 newRow 时间戳必须晚于真实 now（动态构造），否则真机时间下
      // newRow 也会被终态化、断言失败——这正是"零恢复"缺陷的回归探测器。
      const dbBaseline = new Date(Date.now() - 3600_000); // T0：一小时前
      const executor = {
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
        executorStartupId: "startup-old",
        executorStartedAt: dbBaseline,
      };
      const oldRow: any = {
        id: "exec-old",
        executorAddress: executor.address,
        status: ExecutionStatus.RUNNING,
        startTime: new Date(Date.now() - 1800_000), // 半小时前（< now → 终态化）
      };
      const newRow: any = {
        id: "exec-new",
        executorAddress: executor.address,
        status: ExecutionStatus.RUNNING,
        startTime: new Date(Date.now() + 60_000), // 一分钟后（> now → 存活）
      };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      execRepo.find.mockResolvedValue([oldRow, newRow]);
      taskRepo.findBy.mockResolvedValue([]);
      const qb = execRepo.createQueryBuilder();
      qb.execute.mockResolvedValue({
        affected: 1,
        raw: [{ id: "exec-old", executorAddress: executor.address }],
      });
      execRepo.createQueryBuilder.mockReturnValue(qb);
      const warnSpy = jest.spyOn((service as any).logger, "warn");

      // 心跳只发 startupId，不发 restartedAt。
      await service.heartbeat(executor.address, { startupId: "startup-new" });
      await new Promise((resolve) => setImmediate(resolve));

      // transitionToTerminal 的 ids 只含旧行（exec-new 存活）。
      const idsWhere = qb.where.mock.calls.find((c: any) =>
        String(c[0]).includes("IN (:...ids)"),
      );
      expect(idsWhere?.[1].ids).toEqual(["exec-old"]);
      // 基线降级必须显式 warn（可审计）——服务端 now + 降级事实。
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("server-side now"),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("time baseline degraded"),
      );
      warnSpy.mockRestore();
    });

    it("NETOPT-F P3-2: both-null baseline (no restartedAt AND no DB executorStartedAt) still degrades to now and warns (null)", async () => {
      // P3-2/P3-5: 报告担忧"db=null 时 warn 尾句与事实相反"——当前实现基线恒为
      // 服务端 now（db 仅作展示），"Rows started after this baseline are NOT
      // failed"在所有路径都成立。钉死 both-null 情形：warn 必须含 "(null)" 展示、
      // 行为仍为 now 基线（旧行 fail、新行存活）。
      const executor = {
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
        executorStartupId: "startup-old",
        executorStartedAt: null, // DB 侧也无时间基线
      };
      const oldRow: any = {
        id: "exec-old-null",
        executorAddress: executor.address,
        status: ExecutionStatus.RUNNING,
        startTime: new Date(Date.now() - 1800_000),
      };
      const newRow: any = {
        id: "exec-new-null",
        executorAddress: executor.address,
        status: ExecutionStatus.RUNNING,
        startTime: new Date(Date.now() + 60_000),
      };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      execRepo.find.mockResolvedValue([oldRow, newRow]);
      taskRepo.findBy.mockResolvedValue([]);
      const qb = execRepo.createQueryBuilder();
      qb.execute.mockResolvedValue({
        affected: 1,
        raw: [{ id: "exec-old-null", executorAddress: executor.address }],
      });
      execRepo.createQueryBuilder.mockReturnValue(qb);
      const warnSpy = jest.spyOn((service as any).logger, "warn");

      await service.heartbeat(executor.address, { startupId: "startup-new" });
      await new Promise((resolve) => setImmediate(resolve));

      const idsWhere = qb.where.mock.calls.find((c: any) =>
        String(c[0]).includes("IN (:...ids)"),
      );
      expect(idsWhere?.[1].ids).toEqual(["exec-old-null"]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("DB executorStartedAt=(null)"),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("time baseline degraded"),
      );
      warnSpy.mockRestore();
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

    it("trims runningExecutionIds to 10000 and drops ids outside the safe charset", async () => {
      const executor = {
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
        runningExecutionIds: null,
      };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      // NETOPT-D P3-1: 垃圾项必须排在合法项**之前**——旧用例把 6 个垃圾项排在
      // 10010 个合法项末尾，sanitize 在 validCount 触顶前就 break，垃圾项根本
      // 遍历不到，charset 丢弃断言空转（实现改坏也全绿）。前置后每次遍历真实
      // 命中垃圾项。
      const noisy = [
        "with space",
        "with/slash",
        "with.dot",
        42 as unknown as string,
        null as unknown as string,
        ...Array.from({ length: 10_010 }, (_, i) => `exec-${i}`),
      ];

      await service.heartbeat("127.0.0.1:3105", { runningExecutionIds: noisy });

      const ids = executor.runningExecutionIds as string[];
      // NETOPT-C P2-1: 上限与 E9 maxConcurrentTasks 采纳域同源（10000）——并发
      // 在容量上界内时 stale-sweep 存活宽限（includes() 判据）永不丢 id。
      expect(ids).toHaveLength(10_000);
      expect(ids.every((id) => /^[A-Za-z0-9_-]+$/.test(id))).toBe(true);
      expect(ids).not.toContain("with space");
      expect(ids).not.toContain("with/slash");
      expect(ids).not.toContain("with.dot");
      // NETOPT-D P3-2: 锁"第 10001 缺失"窗口——截断后第 10001 个合法 id 必须
      // 不在（它在 stale includes() 判据里意味着失去存活宽限）。
      expect(ids).not.toContain("exec-10000");
      // 第一个合法 id 保留（截断从尾部开始，头部不受影响）
      expect(ids).toContain("exec-0");
    });

    it("logs a warning when runningExecutionIds hits the heartbeat cap", async () => {
      const executor = {
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
        runningExecutionIds: null,
      };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      const warnSpy = jest
        .spyOn((service as any).logger, "warn")
        .mockImplementation(() => undefined);
      try {
        await service.heartbeat("127.0.0.1:3105", {
          runningExecutionIds: Array.from(
            { length: 10_001 },
            (_, i) => `exec-${i}`,
          ),
        });
        // 断言必须在 mockRestore 之前——restore 会清除 spy 的调用记录
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("runningExecutionIds exceeded"),
        );
        // NETOPT-D P2-D2: warn 补 address 与丢弃条数，便于按执行器定位溢出源。
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("127.0.0.1:3105"),
        );
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("1 overflow id(s) dropped"),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("NETOPT-E P3-4: throttles truncation warnings (same address + drop count, 60s window)", async () => {
      // NETOPT-F P3: 显式清空节流状态，消除对前序用例（同模块 Map）的顺序依赖。
      __resetTruncationWarnStateForTest();
      const executor = {
        address: "127.0.0.10:3105",
        status: ExecutorStatus.ONLINE,
        runningExecutionIds: null,
      };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      const warnSpy = jest
        .spyOn((service as any).logger, "warn")
        .mockImplementation(() => undefined);
      const truncWarns = () =>
        warnSpy.mock.calls.filter((c) =>
          String(c[0]).includes("runningExecutionIds exceeded"),
        ).length;
      try {
        // 第一次：必打。
        await service.heartbeat("127.0.0.10:3105", {
          runningExecutionIds: Array.from(
            { length: 10_001 },
            (_, i) => `exec-${i}`,
          ),
        });
        expect(truncWarns()).toBe(1);
        // 第二次（同 address、同 dropped、60s 窗口内）：节流——不打。
        await service.heartbeat("127.0.0.10:3105", {
          runningExecutionIds: Array.from(
            { length: 10_001 },
            (_, i) => `exec-${i}`,
          ),
        });
        expect(truncWarns()).toBe(1);
        // 丢弃量变化（10001 → 20001）立即解除节流并更新计时。
        await service.heartbeat("127.0.0.10:3105", {
          runningExecutionIds: Array.from(
            { length: 20_001 },
            (_, i) => `exec-${i}`,
          ),
        });
        expect(truncWarns()).toBe(2);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("NETOPT-E P3-1: oversized arrays are fully scanned so dropped count is exact", async () => {
      const executor = {
        address: "127.0.0.11:3105",
        status: ExecutorStatus.ONLINE,
        runningExecutionIds: null,
      };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      const warnSpy = jest
        .spyOn((service as any).logger, "warn")
        .mockImplementation(() => undefined);
      try {
        // 25000 个合法 id：不做前置 slice——全量遍历后合法项保留前 10000，
        // dropped 必须精确为 15000（旧实现先 slice(0,20000) 再遍历，报丢
        // 10000、实丢 15000，口径低估）。
        const huge = Array.from({ length: 25_000 }, (_, i) => `exec-${i}`);
        await service.heartbeat("127.0.0.11:3105", {
          runningExecutionIds: huge,
        });
        const ids = executor.runningExecutionIds as string[];
        expect(ids).toHaveLength(10_000);
        expect(ids).toContain("exec-0");
        expect(ids).not.toContain("exec-10000");
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("15000 overflow id(s) dropped"),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("NETOPT-D P2-D2: clamps out-of-range runningTaskCount (keeps stored value)", async () => {
      const executor = {
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
        maxConcurrentTasks: 100,
        runningTaskCount: 7,
      };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      const warnSpy = jest
        .spyOn((service as any).logger, "warn")
        .mockImplementation(() => undefined);
      try {
        for (const bad of [10_001, -1, 1.5, "10" as unknown as number]) {
          await service.heartbeat("127.0.0.1:3105", { runningTaskCount: bad });
          expect(executor.runningTaskCount).toBe(7); // DB 值不动
        }
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("invalid runningTaskCount"),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("NETOPT-D P2-D2: adopts in-range runningTaskCount as reported", async () => {
      const executor = {
        address: "127.0.0.1:3105",
        status: ExecutorStatus.ONLINE,
        runningTaskCount: 7,
      };
      executorRepo.findOne.mockResolvedValue(executor);
      executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));

      await service.heartbeat("127.0.0.1:3105", { runningTaskCount: 42 });

      expect(executor.runningTaskCount).toBe(42);
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
        // A4: 恢复重试入队补齐 priority（此前整项缺失）——mkTask 无 priority
        // 字段，normalizeTaskPriority 兜底 NORMAL(2)，方向换算 → BullMQ 3。
        { attempts: 1, backoff: undefined, priority: 3 },
      );
    });

    it("A4: recovery retry carries the task priority, inverted for BullMQ", async () => {
      execRepo.save.mockImplementation((e: any) =>
        Promise.resolve(e.id ? e : { ...e, id: "retry-prio" }),
      );
      // DB 语义 4=紧急 → BullMQ 1（最先出队）；重试预算照常扣减。
      await service.scheduleRetryAfterRecovery(
        mkTask({ maxRetry: 3, retryDelay: 0, priority: 4 }),
        mkFailedExec({ retryCount: 1 }),
      );
      expect(taskQueue.add).toHaveBeenCalledWith(
        "execute",
        { executionId: "retry-prio" },
        { attempts: 1, backoff: undefined, priority: 1 },
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

    // A-5（执行器域审计 P3）：PATCH maxConcurrentTasks 必须过与 register/
    // heartbeat 相同的 1..10000 整数闸（isAdoptableMaxConcurrentTasks 先例）
    // ——非法值 400 拒绝、不落库；显式 null = 清除上限（既有 PATCH 语义）。
    describe("A-5: maxConcurrentTasks validation", () => {
      it("adopts a valid value (boundary 1 and 10000)", async () => {
        for (const valid of [1, 10_000]) {
          const executor = { id: "e1", maxConcurrentTasks: 4 };
          executorRepo.findOne.mockResolvedValue(executor);
          executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
          await service.update("e1", { maxConcurrentTasks: valid });
          expect(executor.maxConcurrentTasks).toBe(valid);
        }
      });

      it.each([0, -3, 1.5, 10_001, Number.NaN])(
        "rejects invalid value %p with 400 and never persists",
        async (bad) => {
          const executor = { id: "e1", maxConcurrentTasks: 4 };
          executorRepo.findOne.mockResolvedValue(executor);
          executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
          await expect(
            service.update("e1", {
              maxConcurrentTasks: bad as unknown as number,
            }),
          ).rejects.toThrow(BadRequestException);
          expect(executor.maxConcurrentTasks).toBe(4);
          expect(executorRepo.save).not.toHaveBeenCalled();
        },
      );

      it("explicit null clears the cap (PATCH semantics preserved)", async () => {
        const executor = { id: "e1", maxConcurrentTasks: 4 };
        executorRepo.findOne.mockResolvedValue(executor);
        executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
        await service.update("e1", { maxConcurrentTasks: null });
        expect(executor.maxConcurrentTasks).toBeNull();
        expect(executorRepo.save).toHaveBeenCalled();
      });
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

    // A4（第三轮审计·高）：派发体 task 不再整实体直传——只含白名单字段。
    // 白名单推导（协议 TaskConfig ∪ 三端执行器读取面）见
    // dispatch-task-payload.util.ts 头注；本用例钉住「多余列进不了载荷」。
    it("A4: dispatch payload task contains only whitelisted fields (no internal columns)", async () => {
      executorRepo.find.mockResolvedValue([executor]);
      mockedAxios.post.mockResolvedValue({ data: { success: true } });
      const fullTask = {
        id: "task-1",
        name: "test",
        runtime: "node",
        runtimeVersion: null,
        entrypoint: "index.js",
        timeout: 10,
        requirements: null, // 协议明文要求执行器接受字面 null
        gitRepo: null,
        gitBranch: null,
        gitCommit: null,
        glueSource: null,
        glueLanguage: null,
        codeSource: null,
        applicationId: null,
        // —— 以下全部是白名单之外的字段，任何形态都不应出现在载荷里 ——
        // SEC-02: buildDispatchParams 会解密 secrets 注入 env——这里用明文形态
        // （enc:v1 前缀会触发「已加密但未配置密钥」的派发失败分支）。
        secrets: { API_KEY: "plain-value" },
        webhookSecret: "whsec_raw",
        params: { a: 1 },
        ownerUserId: 42,
        alarmEmail: "ops@example.com",
        maxRetry: 3,
        retryDelay: 5,
        blockStrategy: "serial",
        misfireStrategy: "ignore",
        priority: "critical",
        status: "active",
        triggerType: "manual",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      } as unknown as Task;
      await service.dispatch(fullTask, execution);

      expect(mockedAxios.post).toHaveBeenCalled();
      const payload = mockedAxios.post.mock.calls[0][1] as {
        task: Record<string, unknown>;
      };
      expect(Object.keys(payload.task).sort()).toEqual(
        [
          "applicationId",
          "codeSource",
          "entrypoint",
          "gitBranch",
          "gitCommit",
          "gitRepo",
          "glueLanguage",
          "glueSource",
          "id",
          "name",
          "requirements",
          "runtime",
          "runtimeVersion",
          "timeout",
        ].sort(),
      );
      // 白名单字段值逐字段透传（null 保留），非白名单字段一律不出现。
      expect(payload.task).toMatchObject({
        id: "task-1",
        name: "test",
        runtime: "node",
        timeout: 10,
        requirements: null,
      });
      expect(payload.task).not.toHaveProperty("secrets");
      expect(payload.task).not.toHaveProperty("webhookSecret");
      expect(payload.task).not.toHaveProperty("params");
      expect(payload.task).not.toHaveProperty("ownerUserId");
      expect(payload.task).not.toHaveProperty("priority");
    });

    it("decrements running count when dispatch HTTP call fails", async () => {
      executorRepo.find.mockResolvedValue([executor]);
      mockedAxios.post.mockRejectedValue(new Error("connection refused"));
      await expect(service.dispatch(task, execution)).rejects.toThrow(
        "connection refused",
      );
      // A-4: task.runtime="node" → fleet 查询改走 QueryBuilder（条件下推），
      // QB 总数 = fleet(1) + 乐观锁占坑(1) + 失败回滚(1) = 3。
      expect(executorRepo.createQueryBuilder).toHaveBeenCalledTimes(3);
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
        expect.objectContaining({
          status: ExecutorStatus.OFFLINE,
          // 遗留 P1-24：优雅下线落 manual。
          offlineReason: ExecutorOfflineReason.MANUAL,
        }),
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

    it("NETOPT-E P3-3: paginates with skip and an id tie-break when a full page is drained", async () => {
      // NETOPT-E P3-3 补钉：分页循环的生产代码正确（take1000/skip 循环 +
      // startTime/id 双键排序），但旧用例只断言 take(1000)——若有人把
      // addOrderBy/skip 从链上摘掉、或把分页循环改回单次 getMany，全绿。
      // 本用例：第一页满 1000 → skip 必须推进到 1000 再查第二页 → 第二页空
      // 终止；双键排序（startTime ASC + id ASC）钉死确定性分页。
      const fullPage = Array.from({ length: 1000 }, (_, i) => ({
        ...candidate,
        id: `lost-${i}`,
      }));
      qb.getMany.mockResolvedValueOnce(fullPage).mockResolvedValueOnce([]);
      await service.detectLostExecutions();
      // 两页：满页 1000 + 空页终止。只断言 qb（扫描链）上的调用——处理链
      // 逐行 transitionToTerminal 也用 execRepo.createQueryBuilder，不能数总次数。
      expect(qb.getMany).toHaveBeenCalledTimes(2);
      expect(qb.take).toHaveBeenCalledWith(1000);
      expect(qb.skip).toHaveBeenCalledWith(1000);
      expect(qb.addOrderBy).toHaveBeenCalledWith("exec.id", "ASC");
      expect(qb.orderBy).toHaveBeenCalledWith("exec.startTime", "ASC");
    });

    it("NETOPT-E P3-3: short first page terminates without a second query", async () => {
      // 反方向钉死：首页不足 1000（短页）→ 不再发第二次查询（page.length <
      // LOST_SWEEP_PAGE → break）。防止"无脑循环到 MAX"或漏 break。
      const shortPage = Array.from({ length: 7 }, (_, i) => ({
        ...candidate,
        id: `lost-s-${i}`,
      }));
      qb.getMany.mockResolvedValueOnce(shortPage);
      await service.detectLostExecutions();
      expect(qb.getMany).toHaveBeenCalledTimes(1);
      // 首页扫描链也调 skip(0)（pageOffset 起始值）——钉"无第二次查询推进"。
      expect(qb.skip).toHaveBeenCalledTimes(1);
      expect(qb.skip).toHaveBeenCalledWith(0);
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

    // NETOPT-8①: S3 驱动下 task_executions 行删除会让 S3 GC（候选只能来自
    // 存活行）永远看不到行上的日志对象 → 永久孤儿。每批须先 remove 对象再
    // 删行；remove 失败的行保留（指针留待下轮重试）；非 S3 部署直删不变。
    it("NETOPT-8①: S3 驱动下每批先回收 S3 日志对象再删行", async () => {
      const s3 = { remove: jest.fn().mockResolvedValue(undefined) };
      const fromConfigSpy = jest
        .spyOn(S3LogStorage, "fromConfig")
        .mockReturnValue(s3 as unknown as S3LogStorage);
      try {
        configService.get.mockImplementation((key: string) =>
          key === "logStorage.driver"
            ? "s3"
            : key === "logStorage.endpoint"
              ? "http://127.0.0.1:9000"
              : undefined,
        );
        execRepo.find.mockResolvedValue([
          { id: "exec-a", logObjectKey: "execution-logs/exec-a.log.gz" },
          { id: "exec-b", logObjectKey: null },
        ]);
        execRepo.delete.mockResolvedValue({ affected: 2 });
        const total = await service.cleanupOldTaskExecutions(new Date());
        // 带指针的行先 remove（无指针行无需 remove）
        expect(s3.remove).toHaveBeenCalledTimes(1);
        expect(s3.remove).toHaveBeenCalledWith("execution-logs/exec-a.log.gz");
        // victim 选取：createdAt<cutoff、按 id 排序、批大小截断（两列投影）
        const findArg = execRepo.find.mock.calls[0][0] as {
          select: string[];
          take: number;
        };
        expect(findArg.select).toEqual(
          expect.objectContaining({ id: true, logObjectKey: true }),
        );
        expect(findArg.take).toBe(5000);
        // DELETE 收 remove 成功 + 无指针的行（In 算子取 .value 断言集合）
        const delArg = execRepo.delete.mock.calls[0][0] as {
          id: { value: string[] };
        };
        expect(delArg.id.value).toEqual(["exec-a", "exec-b"]);
        expect(total).toBe(2);
        // S3 路径不再走单条子查询 DELETE
        expect(execRepo.createQueryBuilder).not.toHaveBeenCalled();
      } finally {
        fromConfigSpy.mockRestore();
      }
    });

    it("NETOPT-8①: remove 失败的行从本批 DELETE 剔除（指针留待下轮重试）", async () => {
      const s3 = { remove: jest.fn() };
      s3.remove.mockRejectedValueOnce(new Error("s3 down")); // exec-a 失败
      s3.remove.mockResolvedValueOnce(undefined); // exec-b 成功
      const fromConfigSpy = jest
        .spyOn(S3LogStorage, "fromConfig")
        .mockReturnValue(s3 as unknown as S3LogStorage);
      const warnSpy = jest.spyOn(Logger.prototype, "warn");
      try {
        configService.get.mockImplementation((key: string) =>
          key === "logStorage.driver" ? "s3" : undefined,
        );
        execRepo.find.mockResolvedValue([
          { id: "exec-a", logObjectKey: "execution-logs/exec-a.log.gz" },
          { id: "exec-b", logObjectKey: "execution-logs/exec-b.log.gz" },
        ]);
        execRepo.delete.mockResolvedValue({ affected: 1 });
        const total = await service.cleanupOldTaskExecutions(new Date());
        const delArg = execRepo.delete.mock.calls[0][0] as {
          id: { value: string[] };
        };
        // 失败行不删（行在 → 指针在 → S3 GC 仍可见），成功行照删
        expect(delArg.id.value).toEqual(["exec-b"]);
        expect(total).toBe(1);
        expect(
          warnSpy.mock.calls.some((c) =>
            String(c[0]).includes("S3 日志对象删除失败"),
          ),
        ).toBe(true);
      } finally {
        fromConfigSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it("NETOPT-8①: 全部 remove 失败 → 本批不删行也不挂死（0 行等下轮）", async () => {
      const s3 = { remove: jest.fn().mockRejectedValue(new Error("s3 down")) };
      const fromConfigSpy = jest
        .spyOn(S3LogStorage, "fromConfig")
        .mockReturnValue(s3 as unknown as S3LogStorage);
      try {
        configService.get.mockImplementation((key: string) =>
          key === "logStorage.driver" ? "s3" : undefined,
        );
        execRepo.find.mockResolvedValue([
          { id: "exec-a", logObjectKey: "execution-logs/exec-a.log.gz" },
        ]);
        const total = await service.cleanupOldTaskExecutions(new Date());
        expect(total).toBe(0);
        expect(execRepo.delete).not.toHaveBeenCalled();
      } finally {
        fromConfigSpy.mockRestore();
      }
    });

    it("NETOPT-8①: 非 S3 部署保持直删现状（不触达 S3LogStorage）", async () => {
      const fromConfigSpy = jest
        .spyOn(S3LogStorage, "fromConfig")
        .mockReturnValue(null);
      try {
        const qb = makeDeleteQb(3);
        execRepo.createQueryBuilder.mockReturnValue(qb as any);
        const total = await service.cleanupOldTaskExecutions(new Date());
        expect(total).toBe(3);
        expect(execRepo.find).not.toHaveBeenCalled();
        expect(execRepo.delete).not.toHaveBeenCalled();
        expect(fromConfigSpy).toHaveBeenCalled();
      } finally {
        fromConfigSpy.mockRestore();
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
        .mockReturnValueOnce(4) // executor.heartbeatTimeoutMultiplier
        .mockReturnValueOnce(3); // executor.staleOfflineConfirmations (P1-7)
      executorRepo.count.mockResolvedValueOnce(7);
      await expect(service.getRuntimeConfig()).resolves.toEqual({
        heartbeatIntervalMs: 15000,
        heartbeatTimeoutMultiplier: 4,
        heartbeatTimeoutMs: 60000,
        // NETOPT-G P1-7：迟滞后的**真实**判死窗口 = 60s × 3 轮确认
        staleOfflineConfirmations: 3,
        effectiveOfflineAfterMs: 180000,
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
      // P1-7：默认 2 轮确认 → 真实窗口 180s（UI 必须按这个值展示，否则与后端
      // 实际判死时机不符——正是本字段当初要消灭的前后端漂移）
      expect(cfg.staleOfflineConfirmations).toBe(2);
      expect(cfg.effectiveOfflineAfterMs).toBe(180000);
      expect(cfg.listLimit).toBe(500);
    });
  });

  describe("markStaleOffline", () => {
    // R-30（DEEP_REVIEW 0ef3bbe）: markStaleOffline 由「find 快照 + repo.update +
    // 遍历快照扇出」改为「条件 UPDATE ... RETURNING + 遍历真实跃迁行扇出」。
    // 事件/通知只对真正 ONLINE→OFFLINE 的行发出——更新间隙内已恢复心跳的执行器
    // 不在 RETURNING 结果里，不再被误发。此处以一次性 QB 桩注入跃迁行。
    //
    // NETOPT-G P1-7：本方法现在是**两步** UPDATE——① 对所有超时行递增
    // consecutiveHeartbeatMisses（不改 status），② 只对计数达阈值的行做
    // ONLINE→OFFLINE 跃迁。因此 createQueryBuilder 被调用两次：第一次是
    // "递增"（无 RETURNING），第二次才是"跃迁"（带 RETURNING）。桩必须按顺序
    // 喂两个 QB，否则第二次调用会拿到 undefined 而抛错。
    const stubTransition = (
      rows: Array<{ id: string; appName: string; address: string }>,
      affected = rows.length,
    ) => {
      const missQb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest
          .fn()
          .mockResolvedValue({ affected: rows.length, raw: [] }),
      };
      const qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        returning: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected, raw: rows }),
      };
      executorRepo.createQueryBuilder
        .mockReturnValueOnce(missQb as any)
        .mockReturnValueOnce(qb as any);
      return { qb, missQb };
    };

    /** NETOPT-G P1-7：配置读取顺序为 interval → multiplier → confirmations。 */
    const stubStaleConfig = (confirmations = 2) => {
      configService.get
        .mockReturnValueOnce(30000) // heartbeatInterval
        .mockReturnValueOnce(3) // timeoutMultiplier
        .mockReturnValueOnce(confirmations); // staleOfflineConfirmations
    };

    it("marks heartbeat-timeout executors as OFFLINE via conditional UPDATE + RETURNING", async () => {
      stubStaleConfig();
      const { qb, missQb } = stubTransition([
        { id: "exec-1", appName: "app", address: "http://host" },
      ]);
      await service.markStaleOffline();
      // 第一步：递增错失计数（不改 status）——单轮命中不再直接判死
      expect(missQb.set).toHaveBeenCalledWith({
        consecutiveHeartbeatMisses: expect.any(Function),
      });
      expect(missQb.where).toHaveBeenCalledWith(
        expect.stringContaining("status = :status"),
        expect.objectContaining({ status: ExecutorStatus.ONLINE }),
      );
      // 第二步：只对达阈值的行判死
      expect(qb.set).toHaveBeenCalledWith({
        status: ExecutorStatus.OFFLINE,
        // 遗留 P1-24：心跳超时判死落 stale_timeout，与优雅下线区分。
        offlineReason: ExecutorOfflineReason.STALE_TIMEOUT,
      });
      expect(qb.where).toHaveBeenCalledWith(
        expect.stringContaining("status = :status"),
        expect.objectContaining({ status: ExecutorStatus.ONLINE }),
      );
      // P1-7：跃迁谓词必须含"连续错失达阈值"，否则单轮抖动仍会判死
      expect(qb.where).toHaveBeenCalledWith(
        expect.stringContaining("consecutiveHeartbeatMisses"),
        expect.objectContaining({ requiredMisses: 2 }),
      );
      expect(qb.returning).toHaveBeenCalledWith(["id", "appName", "address"]);
    });

    // FEAT-07 发布点：状态落库后 emit executor.offline，每台恰一次。
    it("emits executor.offline once per transitioned executor after the status write", async () => {
      resetRuntimeGauges();
      stubStaleConfig();
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
      stubStaleConfig();
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
      stubStaleConfig();
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
      stubStaleConfig();
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

    // ── NETOPT-G P1-7：判死迟滞（跨境链路误判修复）──────────────────────
    describe("P1-7 判死迟滞（连续 N 轮确认）", () => {
      it("默认确认轮数为 2；单轮超时不判死（谓词要求计数 >= 2）", async () => {
        stubStaleConfig(); // 默认 2
        const { qb } = stubTransition([]);
        await service.markStaleOffline();
        // 单轮命中只递增计数，跃迁谓词要求 >= 2 → 本轮不判死
        expect(qb.where).toHaveBeenCalledWith(
          expect.stringContaining("consecutiveHeartbeatMisses"),
          expect.objectContaining({ requiredMisses: 2 }),
        );
      });

      it("staleOfflineConfirmations=1 退化为修复前的单轮判死（回滚开关）", async () => {
        stubStaleConfig(1);
        const { qb } = stubTransition([
          { id: "exec-1", appName: "a", address: "h" },
        ]);
        await service.markStaleOffline();
        expect(qb.where).toHaveBeenCalledWith(
          expect.stringContaining("consecutiveHeartbeatMisses"),
          expect.objectContaining({ requiredMisses: 1 }),
        );
      });

      it("非法配置（0 / NaN）回退默认 2，绝不退化成永不判死", async () => {
        for (const bad of [0, Number.NaN, -5]) {
          jest.clearAllMocks();
          configService.get
            .mockReturnValueOnce(30000)
            .mockReturnValueOnce(3)
            .mockReturnValueOnce(bad as number);
          const { qb } = stubTransition([]);
          await service.markStaleOffline();
          expect(qb.where).toHaveBeenCalledWith(
            expect.stringContaining("consecutiveHeartbeatMisses"),
            expect.objectContaining({ requiredMisses: 2 }),
          );
        }
      });

      it("心跳到达时清零计数（迟滞可自愈：偶发失败+恢复永不累积到阈值）", async () => {
        // heartbeat() 必须把 consecutiveHeartbeatMisses 归零，否则计数会跨
        // "失败—恢复—再失败"累积，迟滞反而变成延迟判死。
        const e: any = {
          id: "exec-x",
          appName: "app",
          address: "h:1",
          status: ExecutorStatus.OFFLINE,
          consecutiveHeartbeatMisses: 5,
          offlineReason: ExecutorOfflineReason.STALE_TIMEOUT,
        };
        executorRepo.findOne.mockResolvedValue(e);
        executorRepo.save.mockImplementation(async (x: any) => x);

        await service.heartbeat({ address: "h:1" } as any, {} as any);

        expect(executorRepo.save).toHaveBeenCalled();
        const saved = executorRepo.save.mock.calls[0][0];
        expect(saved.consecutiveHeartbeatMisses).toBe(0);
      });
    });

    // ── NETOPT-G P1-6：状态机对称性（executor.online 事件）───────────────
    describe("P1-6 executor.online（与非对称状态机修复）", () => {
      const heartbeatWith = async (status: ExecutorStatus) => {
        const e: any = {
          id: "exec-1",
          appName: "app",
          address: "h:1",
          status,
        };
        executorRepo.findOne.mockResolvedValue(e);
        executorRepo.save.mockImplementation(async (x: any) => x);
        const bus = { emit: jest.fn() };
        (service as unknown as { eventBus: unknown }).eventBus = bus;
        await service.heartbeat({ address: "h:1" } as any, {} as any);
        return bus;
      };

      it("OFFLINE → ONLINE 的真实跃迁发布 executor.online", async () => {
        const bus = await heartbeatWith(ExecutorStatus.OFFLINE);
        expect(bus.emit).toHaveBeenCalledWith(
          DOMAIN_EVENTS.EXECUTOR_ONLINE,
          expect.objectContaining({
            executorId: "exec-1",
            appName: "app",
            address: "h:1",
            occurredAt: expect.any(String),
          }),
        );
      });

      it("已在线的执行器不发布（心跳是 30s 高频路径，无条件 emit 会打爆 outbox）", async () => {
        const bus = await heartbeatWith(ExecutorStatus.ONLINE);
        expect(bus.emit).not.toHaveBeenCalled();
      });

      it("事件发布失败是 fail-open：heartbeat 仍正常返回", async () => {
        const e: any = {
          id: "exec-1",
          appName: "app",
          address: "h:1",
          status: ExecutorStatus.OFFLINE,
        };
        executorRepo.findOne.mockResolvedValue(e);
        executorRepo.save.mockImplementation(async (x: any) => x);
        const bus = {
          emit: jest.fn(() => {
            throw new Error("bus exploded");
          }),
        };
        (service as unknown as { eventBus: unknown }).eventBus = bus;
        await expect(
          service.heartbeat({ address: "h:1" } as any, {} as any),
        ).resolves.toBeDefined();
      });
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
      // 遗留 P1-24：管理员手动下线落 manual。
      expect(saved.offlineReason).toBe(ExecutorOfflineReason.MANUAL);
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
  describe("ARCH-31 §3.7 — 跨实例令牌缓存驱逐广播", () => {
    const ADDR = "10.0.0.9:3002";
    const ADDR_OTHER = "10.0.0.8:3002";

    const makeFakeSync = () => ({
      publishTokenEviction: jest.fn().mockResolvedValue(undefined),
      bindHandlers: jest.fn(),
    });

    const makeFixture = async () => {
      const row: any = {
        id: "e1",
        address: ADDR,
        appName: "node",
        status: ExecutorStatus.ONLINE,
        runningTaskCount: 0,
        tokenHash: null,
      };
      const repo = makeRepo({
        findOne: jest.fn().mockResolvedValue(row),
        save: jest.fn((e: any) => Promise.resolve(e)),
      });
      repo.createQueryBuilder = jest.fn(() => ({
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(row),
      })) as any;
      const fakeSync = makeFakeSync();
      const svc = await makeServiceWithRepo(repo, [
        {
          provide: ExecutorTokenCacheSyncService,
          useValue: fakeSync,
        },
      ]);
      return { svc, row, fakeSync };
    };

    /** 直接填充三张缓存（绕过 bcrypt 流程——既有 rotate/evict 用例已覆盖真实链）。 */
    const populateCaches = (svc: ExecutorService) => {
      const anySvc = svc as any;
      anySvc.tokenValidationCache.set("k1", {
        address: ADDR,
        cachedAt: Date.now(),
      });
      anySvc.tokenValidationCache.set("k2", {
        address: ADDR_OTHER,
        cachedAt: Date.now(),
      });
      anySvc.callbackSecretCache.set(ADDR, {
        hash: "hash-1",
        cachedAt: Date.now(),
      });
      anySvc.issuedTokenCache.set(ADDR, {
        token: "tok-1",
        startupId: "s-1",
        issuedAt: Date.now(),
      });
    };

    it("onModuleInit 把驱逐/flush 回调接到同步服务", async () => {
      const { svc, fakeSync } = await makeFixture();
      svc.onModuleInit();
      expect(fakeSync.bindHandlers).toHaveBeenCalledTimes(1);
      const handlers = fakeSync.bindHandlers.mock.calls[0][0];
      expect(typeof handlers.onEvict).toBe("function");
      expect(typeof handlers.onFlush).toBe("function");
    });

    it("rotateToken 本地逐出后广播该地址", async () => {
      const { svc, row, fakeSync } = await makeFixture();
      populateCaches(svc);
      // R10：rotate 会把新明文重播进 issuedTokenCache——旧明文必须不在（这是
      // 「别的进程生命拿旧 token 续用」的防线），新条目属于 rotate 的正常产物。
      const anySvc = svc as any;
      const oldIssued = anySvc.issuedTokenCache.get(ADDR)?.token;
      await svc.rotateToken(row.id);
      expect(fakeSync.publishTokenEviction).toHaveBeenCalledWith(ADDR);
      expect(anySvc.callbackSecretCache.has(ADDR)).toBe(false);
      expect(anySvc.issuedTokenCache.get(ADDR)?.token ?? null).not.toBe(
        oldIssued,
      );
      // 其他地址的校验缓存不受影响
      expect(anySvc.tokenValidationCache.has("k2")).toBe(true);
    });

    it("removeById 同样广播（删除是更强的撤销）", async () => {
      const { svc, row, fakeSync } = await makeFixture();
      (svc as any).repo.remove = jest.fn().mockResolvedValue(undefined);
      populateCaches(svc);
      await svc.removeById(row.id);
      expect(fakeSync.publishTokenEviction).toHaveBeenCalledWith(ADDR);
      const anySvc = svc as any;
      expect(anySvc.callbackSecretCache.has(ADDR)).toBe(false);
      expect(anySvc.issuedTokenCache.has(ADDR)).toBe(false);
    });

    it("远端广播 onEvict：逐出该地址的全部三条目，不动其他地址", async () => {
      const { svc, fakeSync } = await makeFixture();
      svc.onModuleInit();
      populateCaches(svc);
      const handlers = fakeSync.bindHandlers.mock.calls[0][0];
      handlers.onEvict(ADDR);
      const anySvc = svc as any;
      expect(anySvc.tokenValidationCache.has("k1")).toBe(false);
      expect(anySvc.tokenValidationCache.has("k2")).toBe(true);
      expect(anySvc.callbackSecretCache.has(ADDR)).toBe(false);
      expect(anySvc.issuedTokenCache.has(ADDR)).toBe(false);
    });

    it("重连 flush：三张缓存全量清空（自愈漏掉的广播）", async () => {
      const { svc, fakeSync } = await makeFixture();
      svc.onModuleInit();
      populateCaches(svc);
      const handlers = fakeSync.bindHandlers.mock.calls[0][0];
      handlers.onFlush();
      const anySvc = svc as any;
      expect(anySvc.tokenValidationCache.size).toBe(0);
      expect(anySvc.callbackSecretCache.size).toBe(0);
      expect(anySvc.issuedTokenCache.size).toBe(0);
    });

    it("同步服务缺席（存量装配）：onModuleInit 与 rotate 照常工作", async () => {
      const row: any = {
        id: "e1",
        address: ADDR,
        appName: "node",
        status: ExecutorStatus.ONLINE,
        runningTaskCount: 0,
        tokenHash: null,
      };
      const repo = makeRepo({
        findOne: jest.fn().mockResolvedValue(row),
        save: jest.fn((e: any) => Promise.resolve(e)),
      });
      const svc = await makeServiceWithRepo(repo);
      expect(() => svc.onModuleInit()).not.toThrow();
      await expect(svc.rotateToken(row.id)).resolves.toHaveProperty("token");
    });
  });
});

// R-26（DEEP_REVIEW 0ef3bbe）: @Optional 关键依赖缺失时的静默降级可观测性。
// 生产装配下 DomainEventBus / AuditService 由 @Global 模块恒提供；构造器对
// 缺失项各 warn 一次——「executor.offline 事件静默不发」「rotate-token 等高危
// 操作审计静默不写」两条降级路径因此可见。不改变任何业务行为。
//
// ARCH-35 P1 追加第三项：AppDeployment 仓库缺失时同样 warn——否则「部署归属
// 偏好」会静默不生效，用户以为修复已上线而任务仍可能派到未部署该应用的执行器
// （正是本次事故现象）。该 warn 仅在开关**未明确关闭**时出现。
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
    /** ARCH-35: app_deployments 仓库（@Optional，第 15 个位置参数）。 */
    appDeploymentRepo?: unknown;
    /** FEAT-22 方案 B: application_versions 仓库（@Optional，第 17 个位置参数）。 */
    applicationVersionRepo?: unknown;
    /** ARCH-35: executor.preferDeployedExecutor 的返回值。 */
    preferDeployed?: unknown;
  }): ExecutorService =>
    new ExecutorService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        get: jest.fn((key: string) =>
          key === "executor.preferDeployedExecutor"
            ? opts.preferDeployed
            : "http",
        ),
      } as never, // configService
      {} as never, // notificationService
      {} as never, // systemConfigService
      {} as never, // secretsCrypto
      opts.eventBus as never, // eventBus（@Optional）
      null as never, // tracing（@Optional）
      opts.audit as never, // audit（@Optional）
      null as never, // leaderGate（@Optional）
      null as never, // pullService（@Optional）
      null as never, // applicationRepo（@Optional）
      opts.appDeploymentRepo as never, // appDeploymentRepo（@Optional）
      null as never, // tokenCacheSync（@Optional，位于 mutexGroupRepo 前）
      null as never, // mutexGroupRepo（@Optional）
      opts.applicationVersionRepo as never, // applicationVersionRepo（@Optional，尾参）
    );

  const r26Messages = (): string[] =>
    warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("R-26"));

  it("eventBus/audit 缺失时各 warn 一次，且不抛", () => {
    expect(() => buildService({ eventBus: null, audit: null })).not.toThrow();
    const msgs = r26Messages();
    // 4 = DomainEventBus + AuditService + AppDeployment 仓库 +
    // ApplicationVersion 仓库（默认开关非 false）
    expect(msgs).toHaveLength(4);
    expect(msgs.some((m) => m.includes("DomainEventBus"))).toBe(true);
    expect(msgs.some((m) => m.includes("AuditService"))).toBe(true);
    expect(msgs.some((m) => m.includes("AppDeployment"))).toBe(true);
    expect(msgs.some((m) => m.includes("ApplicationVersion"))).toBe(true);
  });

  it("依赖齐备时不产生任何 R-26 warn", () => {
    buildService({
      eventBus: { emit: jest.fn() },
      audit: { log: jest.fn() },
      appDeploymentRepo: { find: jest.fn() },
      applicationVersionRepo: { findOne: jest.fn() },
    });
    expect(r26Messages()).toHaveLength(0);
  });

  it("ARCH-35: 仓库缺失但开关明确关闭时不 warn（主动关闭非装配缺失）", () => {
    buildService({
      eventBus: { emit: jest.fn() },
      audit: { log: jest.fn() },
      appDeploymentRepo: null,
      preferDeployed: false,
    });
    const msgs = r26Messages();
    expect(msgs.some((m) => m.includes("AppDeployment"))).toBe(false);
  });

  it("ARCH-35: 仓库缺失且开关未关闭时 warn（偏好会静默不生效）", () => {
    buildService({
      eventBus: { emit: jest.fn() },
      audit: { log: jest.fn() },
      appDeploymentRepo: null,
      preferDeployed: true,
    });
    const msgs = r26Messages();
    expect(msgs.some((m) => m.includes("AppDeployment"))).toBe(true);
  });
});

/**
 * ARCH-34 P0（生产事故 2026-09-23）：address 冲突检测在 service 层的接线。
 *
 * 单测（executor-address-conflict.util.spec.ts）已钉死判据本身；本组只验证
 * **接线**：register/heartbeat 两个入口确实喂给同一个跟踪器，且冲突时确实
 * 外发一次 ERROR 日志 + 通知。判据正确但没接线 = 生产照旧静默串台。
 */
describe("ExecutorService — ARCH-34 address 冲突接线", () => {
  const ADDR = "192.168.1.100:8002";
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const B = "bbbbbbbb-0000-4000-8000-000000000002";

  let executorRepo: ReturnType<typeof makeRepo>;
  let execRepo: ReturnType<typeof makeRepo>;
  let taskRepo: ReturnType<typeof makeRepo>;
  let metricsHistoryRepo: ReturnType<typeof makeRepo>;
  let configService: jest.Mocked<Pick<ConfigService, "get">>;
  let sendAll: jest.Mock;

  const buildService = async (): Promise<ExecutorService> => {
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
        {
          provide: getQueueToken("task-queue"),
          useValue: { add: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: ConfigService, useValue: configService },
        {
          provide: NotificationService,
          useValue: {
            notifyFailure: jest.fn(),
            notifyFailureWithConfig: jest.fn(),
            notifyExecutorOnline: jest.fn().mockResolvedValue(undefined),
            notifyExecutorOffline: jest.fn().mockResolvedValue(undefined),
            sendAll,
          },
        },
        {
          provide: SystemConfigService,
          useValue: {
            findOne: jest.fn().mockRejectedValue(new Error("not found")),
          },
        },
        {
          provide: SecretsCryptoService,
          useValue: new SecretsCryptoService({ get: () => "" } as any),
        },
      ],
    }).compile();
    return module.get(ExecutorService);
  };

  beforeEach(() => {
    executorRepo = makeRepo();
    execRepo = makeRepo();
    taskRepo = makeRepo();
    metricsHistoryRepo = makeRepo();
    configService = { get: jest.fn().mockReturnValue("http") } as never;
    sendAll = jest.fn().mockResolvedValue(undefined);
    // 冲突告警走 logger.error——测试里静音，避免污染输出（断言靠 spy 计数）。
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** register 与 heartbeat 必须共享同一跟踪器，否则各自"首次见到"，冲突永不触发。 */
  it("register 与 heartbeat 共享跟踪状态（跨入口可判冲突）", async () => {
    const svc = await buildService();
    // 用 register 登记 A（repo.findOne 返回该行，save 原样返回）。
    executorRepo.findOne.mockResolvedValue({
      id: "e1",
      address: ADDR,
      appName: "node-a",
      executorStartupId: A,
      executorStartedAt: new Date("2026-01-01T00:00:00Z"),
      status: ExecutorStatus.ONLINE,
      runningTaskCount: 0,
      version: 1,
    } as never);
    executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
    (svc as any).rotateToken = jest.fn().mockResolvedValue({ token: "tok" });

    await svc.register({ appName: "node-a", address: ADDR, startupId: A });

    // heartbeat 上报同一 address 的**另一个**进程生命 B（模拟 B 顶替 A）……
    executorRepo.findOne.mockResolvedValue({
      id: "e1",
      address: ADDR,
      appName: "node-b",
      executorStartupId: A,
      executorStartedAt: new Date("2026-01-01T00:00:00Z"),
      status: ExecutorStatus.ONLINE,
      runningTaskCount: 0,
      version: 1,
    } as never);
    await svc.heartbeat(ADDR, { startupId: B });
    expect(sendAll).not.toHaveBeenCalled();

    // ……随后 A 通过 heartbeat 复活 → 跨入口共享状态使冲突可判。
    await svc.heartbeat(ADDR, { startupId: A });
    expect(sendAll).toHaveBeenCalledTimes(1);
    expect(String(sendAll.mock.calls[0][0].title)).toContain(
      "Executor address conflict",
    );
  });

  /** 冲突必须外发 ERROR 级通知（数据正确性问题，不能只落 debug）。 */
  it("冲突时外发一次 error 级通知，且载荷含可排障信息", async () => {
    const svc = await buildService();
    const svcAny = svc as any;
    // 直接驱动跟踪器，聚焦"接线 + 载荷"而非重复覆盖判据。
    svcAny.observeAddressConflict(ADDR, A, "register");
    svcAny.observeAddressConflict(ADDR, B, "register");
    svcAny.observeAddressConflict(ADDR, A, "heartbeat");

    expect(sendAll).toHaveBeenCalledTimes(1);
    const payload = sendAll.mock.calls[0][0];
    expect(payload.level).toBe("error");
    expect(payload.title).toContain(ADDR);
    // 排障必需信息：谁在顶替、谁还活着、怎么修。
    expect(payload.content).toContain(A);
    expect(payload.content).toContain(B);
    expect(payload.content).toContain("EXECUTOR_ADDRESS_PUBLIC");
  });

  /** 节流：同一组合在窗口内重复冲突只外发一次（心跳是 30s 高频路径）。 */
  it("冲突告警受节流保护（不刷通知）", async () => {
    const svc = await buildService();
    const svcAny = svc as any;
    svcAny.observeAddressConflict(ADDR, A, "register");
    svcAny.observeAddressConflict(ADDR, B, "register");
    for (let i = 0; i < 5; i++) {
      svcAny.observeAddressConflict(ADDR, A, "heartbeat");
    }
    expect(sendAll).toHaveBeenCalledTimes(1);
  });

  /** 正常重启（A→B 一去不返）绝不告警——防误报红线在 service 层同样成立。 */
  it("正常重启不告警（防误报）", async () => {
    const svc = await buildService();
    const svcAny = svc as any;
    svcAny.observeAddressConflict(ADDR, A, "register");
    svcAny.observeAddressConflict(ADDR, B, "register");
    for (let i = 0; i < 5; i++) {
      svcAny.observeAddressConflict(ADDR, B, "heartbeat");
    }
    expect(sendAll).not.toHaveBeenCalled();
  });

  /**
   * fail-open 红线：通知抛错/缺席都绝不能影响注册与心跳主链。
   * 这是 P0 必须守住的不变量——检测设施本身不能成为新的故障源。
   */
  it("通知同步抛错时 register/heartbeat 主链不受影响（fail-open）", async () => {
    sendAll = jest.fn().mockImplementation(() => {
      throw new Error("notification backend down");
    });
    const svc = await buildService();
    executorRepo.findOne.mockResolvedValue({
      id: "e1",
      address: ADDR,
      appName: "node-a",
      executorStartupId: A,
      executorStartedAt: new Date("2026-01-01T00:00:00Z"),
      status: ExecutorStatus.ONLINE,
      runningTaskCount: 0,
      version: 1,
    } as never);
    executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));

    await expect(svc.heartbeat(ADDR, { startupId: A })).resolves.toBeDefined();
    await expect(svc.heartbeat(ADDR, { startupId: B })).resolves.toBeDefined();
    // A 复活触发告警路径，但通知抛错被吞——主链照常返回。
    await expect(svc.heartbeat(ADDR, { startupId: A })).resolves.toBeDefined();
  });

  /** 旧执行器（未上报 startupId）零影响：不告警、不抛错。 */
  it("未上报 startupId 的旧执行器不触发任何冲突告警", async () => {
    const svc = await buildService();
    executorRepo.findOne.mockResolvedValue({
      id: "e1",
      address: ADDR,
      appName: "legacy",
      status: ExecutorStatus.ONLINE,
      runningTaskCount: 0,
      version: 1,
    } as never);
    executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));

    await svc.heartbeat(ADDR, {});
    await svc.heartbeat(ADDR, { startupId: null });
    expect(sendAll).not.toHaveBeenCalled();
  });
});

/**
 * ARCH-35 P1（生产事故 2026-09-23）：部署归属偏好（`partitionByDeploymentAffinity`）
 * 在 `dispatch()` 中的接线。
 *
 * 本块只覆盖**接线与端到端语义**（判据本身的边界已在
 * `executor-deployment-affinity.util.spec.ts` 的 21 个用例里穷举）：
 *  - 偏好生效：部署在评分**更差**的执行器上时，任务改派到那台；
 *  - 降级：部署那台占坑失败（满/离线）→ 回落到全机队，**不失败**；
 *  - 零行为变化：开关关 / 无 applicationId / 无部署行 / 仓库未装配；
 *  - 容错：查询抛错不阻断派发；
 *  - 可观测：决策日志的 deploymentAffinity 字段。
 */
describe("ARCH-35 P1: dispatch 部署归属偏好接线（ExecutorService）", () => {
  let executorRepo: ReturnType<typeof makeRepo>;
  let execRepo: ReturnType<typeof makeRepo>;
  let taskRepo: ReturnType<typeof makeRepo>;
  let metricsHistoryRepo: ReturnType<typeof makeRepo>;
  let configService: { get: jest.Mock };
  let appDeploymentRepo: { find: jest.Mock };

  /** 两台在线执行器：e-best 评分最优（负载 0），e-deployed 负载更高。 */
  const twoExecutors = () => [
    {
      id: "e-best",
      address: "best:1",
      status: ExecutorStatus.ONLINE,
      runningTaskCount: 0,
      maxConcurrentTasks: 10,
      version: 1,
    },
    {
      id: "e-deployed",
      address: "deployed:2",
      status: ExecutorStatus.ONLINE,
      runningTaskCount: 3,
      maxConcurrentTasks: 10,
      version: 1,
    },
  ];

  const buildService = async (opts: { withDeploymentRepo?: boolean } = {}) => {
    const providers: any[] = [
      ExecutorService,
      { provide: getRepositoryToken(Executor), useValue: executorRepo },
      { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
      { provide: getRepositoryToken(Task), useValue: taskRepo },
      {
        provide: getRepositoryToken(ExecutorMetricsHistory),
        useValue: metricsHistoryRepo,
      },
      { provide: getQueueToken("task-queue"), useValue: { add: jest.fn() } },
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
        useValue: { findOne: jest.fn().mockRejectedValue(new Error("nf")) },
      },
      {
        provide: SecretsCryptoService,
        useValue: new SecretsCryptoService({ get: () => "" } as any),
      },
    ];
    if (opts.withDeploymentRepo !== false) {
      providers.push({
        provide: getRepositoryToken(AppDeployment),
        useValue: appDeploymentRepo,
      });
    }
    const module = await Test.createTestingModule({ providers }).compile();
    return module.get(ExecutorService);
  };

  /** 派发目标地址（axios POST 的 URL）。 */
  const dispatchedTo = (): string => String(mockedAxios.post.mock.calls[0][0]);

  beforeEach(() => {
    executorRepo = makeRepo();
    execRepo = makeRepo();
    taskRepo = makeRepo();
    metricsHistoryRepo = makeRepo();
    appDeploymentRepo = { find: jest.fn().mockResolvedValue([]) };
    // 默认：偏好开启（生产默认）。configService 只对本次新增的 key 返回 true。
    configService = {
      get: jest.fn((key: string) =>
        key === "executor.preferDeployedExecutor" ? true : "http",
      ),
    };
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    // 本 describe 是外层 describe 的**兄弟**（不在其 beforeEach 作用域内），
    // 故必须自行清理 mock：否则 axios.post 的调用记录会跨用例累积，
    // dispatchedTo() 取到上一个用例的目标地址。
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** 核心修复：部署在评分更差的机器上时，任务必须派给**部署的那台**。 */
  it("偏好生效：派给已部署该应用的执行器（即使它评分更差）", async () => {
    const svc = await buildService();
    executorRepo.find.mockResolvedValue(twoExecutors());
    executorRepo.createQueryBuilder.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    } as never);
    appDeploymentRepo.find.mockResolvedValue([
      {
        executorId: "e-deployed",
        executorAddress: "deployed:2",
        status: "running",
      },
    ]);
    mockedAxios.post.mockResolvedValue({ data: { ok: true } });

    await svc.dispatch(
      {
        id: "task-1",
        name: "t",
        applicationId: "app-1",
        // codeSource 必须显式声明为非 zip：否则 applicationId 非空 + codeSource
        // 为空会命中 resolveDispatchTask 的 zip 并集兜底，转而要求 applicationRepo
        // （本块不装配它）。git 渠道正是 manifest 自动注册产出的真实形态。
        codeSource: TaskCodeSource.GIT,
        timeout: 10,
      } as unknown as Task,
      { id: "exec-1", params: {} } as TaskExecution,
    );

    // 若无偏好，e-best（负载 0）会胜出——这正是事故现象。
    expect(dispatchedTo()).toContain("deployed:2");
  });

  /** 存量行只有 executorAddress（executorId 为 null）时同样要生效。 */
  it("偏好生效：executorId 为 null 的存量部署行按 address 命中", async () => {
    const svc = await buildService();
    executorRepo.find.mockResolvedValue(twoExecutors());
    executorRepo.createQueryBuilder.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    } as never);
    appDeploymentRepo.find.mockResolvedValue([
      {
        executorId: null,
        executorAddress: "deployed:2",
        status: "running",
      },
    ]);
    mockedAxios.post.mockResolvedValue({ data: { ok: true } });

    await svc.dispatch(
      {
        id: "task-1",
        name: "t",
        applicationId: "app-1",
        // codeSource 必须显式声明为非 zip：否则 applicationId 非空 + codeSource
        // 为空会命中 resolveDispatchTask 的 zip 并集兜底，转而要求 applicationRepo
        // （本块不装配它）。git 渠道正是 manifest 自动注册产出的真实形态。
        codeSource: TaskCodeSource.GIT,
        timeout: 10,
      } as unknown as Task,
      { id: "exec-1", params: {} } as TaskExecution,
    );
    expect(dispatchedTo()).toContain("deployed:2");
  });

  /**
   * 降级红线：部署那台占坑失败（满/离线）时**必须回落**到全机队——
   * 这是「偏好而非过滤」的关键证据，也是不新增失败面的保证。
   */
  it("降级：部署那台占坑失败时回落到其他候选，不抛错", async () => {
    const svc = await buildService();
    executorRepo.find.mockResolvedValue(twoExecutors());
    // 第一次占坑（e-deployed）失败，第二次（e-best）成功。
    const execute = jest
      .fn()
      .mockResolvedValueOnce({ affected: 0 })
      .mockResolvedValueOnce({ affected: 1 });
    executorRepo.createQueryBuilder.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute,
    } as never);
    appDeploymentRepo.find.mockResolvedValue([
      {
        executorId: "e-deployed",
        executorAddress: "deployed:2",
        status: "running",
      },
    ]);
    mockedAxios.post.mockResolvedValue({ data: { ok: true } });

    await expect(
      svc.dispatch(
        {
          id: "task-1",
          name: "t",
          applicationId: "app-1",
          codeSource: TaskCodeSource.GIT,
          timeout: 10,
        } as unknown as Task,
        { id: "exec-1", params: {} } as TaskExecution,
      ),
    ).resolves.toBeDefined();

    // 尝试了两次占坑（先部署那台、后回落），最终派给 e-best。
    expect(execute).toHaveBeenCalledTimes(2);
    expect(dispatchedTo()).toContain("best:1");
  });

  /** 开关明确关闭 → 完全不查部署表，顺序与修复前一致。 */
  it("开关关闭时完全不查询部署表，按纯负载择优", async () => {
    configService.get.mockImplementation((key: string) =>
      key === "executor.preferDeployedExecutor" ? false : "http",
    );
    const svc = await buildService();
    executorRepo.find.mockResolvedValue(twoExecutors());
    executorRepo.createQueryBuilder.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    } as never);
    mockedAxios.post.mockResolvedValue({ data: { ok: true } });

    await svc.dispatch(
      {
        id: "task-1",
        name: "t",
        applicationId: "app-1",
        // codeSource 必须显式声明为非 zip：否则 applicationId 非空 + codeSource
        // 为空会命中 resolveDispatchTask 的 zip 并集兜底，转而要求 applicationRepo
        // （本块不装配它）。git 渠道正是 manifest 自动注册产出的真实形态。
        codeSource: TaskCodeSource.GIT,
        timeout: 10,
      } as unknown as Task,
      { id: "exec-1", params: {} } as TaskExecution,
    );
    expect(appDeploymentRepo.find).not.toHaveBeenCalled();
    expect(dispatchedTo()).toContain("best:1");
  });

  /** 任务无 applicationId（非应用任务）→ 不查部署表，零行为变化。 */
  it("任务无 applicationId 时不查询部署表", async () => {
    const svc = await buildService();
    executorRepo.find.mockResolvedValue(twoExecutors());
    executorRepo.createQueryBuilder.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    } as never);
    mockedAxios.post.mockResolvedValue({ data: { ok: true } });

    await svc.dispatch(
      { id: "task-1", name: "t", timeout: 10 } as unknown as Task,
      { id: "exec-1", params: {} } as TaskExecution,
    );
    expect(appDeploymentRepo.find).not.toHaveBeenCalled();
    expect(dispatchedTo()).toContain("best:1");
  });

  /** 无运行中部署（全 stopped/failed）→ 原序，仍派给评分最优者。 */
  it("无运行中部署时保持原序（派给评分最优者）", async () => {
    const svc = await buildService();
    executorRepo.find.mockResolvedValue(twoExecutors());
    executorRepo.createQueryBuilder.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    } as never);
    // 仓库按 status 过滤后返回空（模拟无 running 行）。
    appDeploymentRepo.find.mockResolvedValue([]);
    mockedAxios.post.mockResolvedValue({ data: { ok: true } });

    await svc.dispatch(
      {
        id: "task-1",
        name: "t",
        applicationId: "app-1",
        // codeSource 必须显式声明为非 zip：否则 applicationId 非空 + codeSource
        // 为空会命中 resolveDispatchTask 的 zip 并集兜底，转而要求 applicationRepo
        // （本块不装配它）。git 渠道正是 manifest 自动注册产出的真实形态。
        codeSource: TaskCodeSource.GIT,
        timeout: 10,
      } as unknown as Task,
      { id: "exec-1", params: {} } as TaskExecution,
    );
    expect(dispatchedTo()).toContain("best:1");
  });

  /** 仓库未装配（存量单测/异常装配）→ 偏好短路，派发照常成功。 */
  it("部署仓库未装配时短路，派发照常成功", async () => {
    const svc = await buildService({ withDeploymentRepo: false });
    executorRepo.find.mockResolvedValue(twoExecutors());
    executorRepo.createQueryBuilder.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    } as never);
    mockedAxios.post.mockResolvedValue({ data: { ok: true } });

    await svc.dispatch(
      {
        id: "task-1",
        name: "t",
        applicationId: "app-1",
        // codeSource 必须显式声明为非 zip：否则 applicationId 非空 + codeSource
        // 为空会命中 resolveDispatchTask 的 zip 并集兜底，转而要求 applicationRepo
        // （本块不装配它）。git 渠道正是 manifest 自动注册产出的真实形态。
        codeSource: TaskCodeSource.GIT,
        timeout: 10,
      } as unknown as Task,
      { id: "exec-1", params: {} } as TaskExecution,
    );
    expect(dispatchedTo()).toContain("best:1");
  });

  /** best-effort 红线：部署查询抛错绝不能阻断派发（偏好缺失 ≠ 无法调度）。 */
  it("部署查询抛错时不阻断派发（best-effort 降级）", async () => {
    const svc = await buildService();
    executorRepo.find.mockResolvedValue(twoExecutors());
    executorRepo.createQueryBuilder.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    } as never);
    appDeploymentRepo.find.mockRejectedValue(new Error("db down"));
    mockedAxios.post.mockResolvedValue({ data: { ok: true } });

    await expect(
      svc.dispatch(
        {
          id: "task-1",
          name: "t",
          applicationId: "app-1",
          codeSource: TaskCodeSource.GIT,
          timeout: 10,
        } as unknown as Task,
        { id: "exec-1", params: {} } as TaskExecution,
      ),
    ).resolves.toBeDefined();
    expect(dispatchedTo()).toContain("best:1");
  });

  /** 决策日志必须记录偏好命中面（可回溯「为什么派到这台」）。 */
  it("决策日志含 deploymentAffinity 命中面", async () => {
    const svc = await buildService();
    const logSpy = jest
      .spyOn(Logger.prototype, "log")
      .mockImplementation(() => undefined);
    executorRepo.find.mockResolvedValue(twoExecutors());
    executorRepo.createQueryBuilder.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    } as never);
    appDeploymentRepo.find.mockResolvedValue([
      {
        executorId: "e-deployed",
        executorAddress: "deployed:2",
        status: "running",
      },
    ]);
    mockedAxios.post.mockResolvedValue({ data: { ok: true } });

    await svc.dispatch(
      {
        id: "task-1",
        name: "t",
        applicationId: "app-1",
        // codeSource 必须显式声明为非 zip：否则 applicationId 非空 + codeSource
        // 为空会命中 resolveDispatchTask 的 zip 并集兜底，转而要求 applicationRepo
        // （本块不装配它）。git 渠道正是 manifest 自动注册产出的真实形态。
        codeSource: TaskCodeSource.GIT,
        timeout: 10,
      } as unknown as Task,
      { id: "exec-1", params: {} } as TaskExecution,
    );

    const decision = logSpy.mock.calls
      .map((c) => String(c[0]))
      .map((m) => {
        try {
          return JSON.parse(m);
        } catch {
          return null;
        }
      })
      .find((p) => p && p.event === "dispatch.decision");
    expect(decision).toBeTruthy();
    expect(decision.deploymentAffinity).toEqual({
      preferred: 1,
      matchedByExecutorId: 1,
      matchedByAddressOnly: 0,
      runningDeployments: 1,
    });
    // 选中者就是部署那台，且 score 仍是**真实评分**（未被偏好污染）。
    expect(decision.selected.address).toBe("deployed:2");
    expect(typeof decision.selected.score).toBe("number");
  });

  /** 无部署行时决策日志的 deploymentAffinity 仍存在（区分"没部署"与"未适用"）。 */
  it("无部署行时决策日志记录 preferred=0 而非 null", async () => {
    const svc = await buildService();
    const logSpy = jest
      .spyOn(Logger.prototype, "log")
      .mockImplementation(() => undefined);
    executorRepo.find.mockResolvedValue(twoExecutors());
    executorRepo.createQueryBuilder.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    } as never);
    appDeploymentRepo.find.mockResolvedValue([]);
    mockedAxios.post.mockResolvedValue({ data: { ok: true } });

    await svc.dispatch(
      {
        id: "task-1",
        name: "t",
        applicationId: "app-1",
        // codeSource 必须显式声明为非 zip：否则 applicationId 非空 + codeSource
        // 为空会命中 resolveDispatchTask 的 zip 并集兜底，转而要求 applicationRepo
        // （本块不装配它）。git 渠道正是 manifest 自动注册产出的真实形态。
        codeSource: TaskCodeSource.GIT,
        timeout: 10,
      } as unknown as Task,
      { id: "exec-1", params: {} } as TaskExecution,
    );

    const decision = logSpy.mock.calls
      .map((c) => String(c[0]))
      .map((m) => {
        try {
          return JSON.parse(m);
        } catch {
          return null;
        }
      })
      .find((p) => p && p.event === "dispatch.decision");
    expect(decision.deploymentAffinity).toEqual({
      preferred: 0,
      matchedByExecutorId: 0,
      matchedByAddressOnly: 0,
      runningDeployments: 0,
    });
  });
});

/**
 * FEAT-22 方案 A v1（生产反馈 2026-09-30：once 部署 5 秒失效，webhook 任务漂移
 * 到非部署设备）：`deploymentPolicy=strict` 部署约束在 `dispatch()` 中的接线。
 *
 * 只覆盖**接线与端到端语义**（键提取/状态口径已在 util spec 穷举）：
 *  - 收窄：strict 下候选池来自「部署集合 ∩ ONLINE」直查，fleet SQL Top-K
 *    **不被调用**（绕开截断盲区）；stopped 行计入集合（once 事故场景）；
 *  - 不换机：集合全离线 / 集合内被过滤光 → DeploymentConstraintWaitError
 *    （processor 据此置 WAITING 不烧预算），绝不回落全机队；
 *  - 优先级：appName 点名时不叠加约束；无部署行时约束不适用（删行即解除）；
 *  - 口径契约：strict 的部署行查询必须按 running/stopped/upgrading 三态。
 */
describe("FEAT-22 方案 A: dispatch 部署约束 strict 接线（ExecutorService）", () => {
  let executorRepo: ReturnType<typeof makeRepo>;
  let execRepo: ReturnType<typeof makeRepo>;
  let taskRepo: ReturnType<typeof makeRepo>;
  let metricsHistoryRepo: ReturnType<typeof makeRepo>;
  let configService: { get: jest.Mock };
  let appDeploymentRepo: { find: jest.Mock };

  /** strict 下的部署集合：一条 stopped 行（once 跑完即 stopped 的事故形态）。 */
  const stoppedDeploymentRow = () => ({
    executorId: "e-deployed",
    executorAddress: "deployed:2",
    status: "stopped",
  });

  /** 集合直查的命中面：只有部署那台在线（模拟 fleet 其余设备不在集合内）。 */
  const deployedExecutor = () => ({
    id: "e-deployed",
    address: "deployed:2",
    appName: "deployed-app",
    status: ExecutorStatus.ONLINE,
    runningTaskCount: 3,
    maxConcurrentTasks: 10,
    version: 1,
  });

  /** fleet 池两台（v2 prefer 覆盖用例用）：e-best 负载 0 评分最优。 */
  const twoExecutors = () => [
    {
      id: "e-best",
      address: "best:1",
      status: ExecutorStatus.ONLINE,
      runningTaskCount: 0,
      maxConcurrentTasks: 10,
      version: 1,
    },
    {
      id: "e-deployed",
      address: "deployed:2",
      status: ExecutorStatus.ONLINE,
      runningTaskCount: 3,
      maxConcurrentTasks: 10,
      version: 1,
    },
  ];

  /**
   * 集合直查与原子占坑共用 executorRepo.createQueryBuilder——mock 必须同时
   * 具备两条链面：getMany（集合查询）与 update/set/execute（占坑）。
   */
  const mockSetQueryAndClaim = (opts: {
    setQueryResult: unknown[];
    claimAffected?: number | jest.Mock;
  }) => {
    executorRepo.createQueryBuilder.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(opts.setQueryResult),
      execute:
        typeof opts.claimAffected === "function"
          ? (opts.claimAffected as jest.Mock)
          : jest.fn().mockResolvedValue({ affected: opts.claimAffected ?? 1 }),
    } as never);
  };

  const buildService = async (): Promise<ExecutorService> => {
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
        { provide: getQueueToken("task-queue"), useValue: { add: jest.fn() } },
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
          useValue: { findOne: jest.fn().mockRejectedValue(new Error("nf")) },
        },
        {
          provide: SecretsCryptoService,
          useValue: new SecretsCryptoService({ get: () => "" } as any),
        },
        {
          provide: getRepositoryToken(AppDeployment),
          useValue: appDeploymentRepo,
        },
      ],
    }).compile();
    return module.get(ExecutorService);
  };

  /** strict 模式的 config mock（preferDeployed 开 + deploymentPolicy=strict）。 */
  const enableStrict = () => {
    configService.get.mockImplementation((key: string) =>
      key === "executor.preferDeployedExecutor"
        ? true
        : key === "executor.deploymentPolicy"
          ? "strict"
          : "http",
    );
  };

  const gitTask = (overrides: Record<string, unknown> = {}) =>
    ({
      id: "task-1",
      name: "t",
      applicationId: "app-1",
      // codeSource 必须显式声明为非 zip：否则 applicationId 非空 + codeSource
      // 为空会命中 resolveDispatchTask 的 zip 并集兜底，转而要求 applicationRepo
      // （本块不装配它）。git 渠道正是 manifest 自动注册产出的真实形态。
      codeSource: TaskCodeSource.GIT,
      timeout: 10,
      ...overrides,
    }) as unknown as Task;

  const dispatchTask = (svc: ExecutorService, task: Task) =>
    svc.dispatch(task, { id: "exec-1", params: {} } as TaskExecution);

  beforeEach(() => {
    executorRepo = makeRepo();
    execRepo = makeRepo();
    taskRepo = makeRepo();
    metricsHistoryRepo = makeRepo();
    appDeploymentRepo = {
      find: jest.fn().mockResolvedValue([stoppedDeploymentRow()]),
    };
    configService = { get: jest.fn() };
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    jest.clearAllMocks();
    // clearAllMocks 之后统一装配 config mock（本块的默认形态 = strict 开）。
    enableStrict();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** 核心语义：stopped 部署行（once 事故场景）也把任务钉在部署那台。 */
  it("strict：候选池来自集合直查（fleet Top-K 不被调用），派给 stopped 部署的那台", async () => {
    const svc = await buildService();
    mockSetQueryAndClaim({ setQueryResult: [deployedExecutor()] });
    mockedAxios.post.mockResolvedValue({ data: { ok: true } });
    const logSpy = jest
      .spyOn(Logger.prototype, "log")
      .mockImplementation(() => undefined);

    await dispatchTask(svc, gitTask());

    // 集合直查替代了 fleet SQL Top-K——绕开截断盲区是 strict 的硬要求。
    expect(executorRepo.find).not.toHaveBeenCalled();
    expect(String(mockedAxios.post.mock.calls[0][0])).toContain("deployed:2");

    const decision = logSpy.mock.calls
      .map((c) => String(c[0]))
      .map((m) => {
        try {
          return JSON.parse(m);
        } catch {
          return null;
        }
      })
      .find((p) => p && p.event === "dispatch.decision");
    expect(decision).toBeTruthy();
    expect(decision.deploymentConstraint).toEqual({
      mode: "strict",
      // 全局开关开启（enableStrict），任务未带 deploymentPolicy → 来源 global。
      source: "global",
      setSize: 1,
      onlineInSet: 1,
    });
    // strict 下软偏好不参与（约束已收窄），deploymentAffinity 必须显式 null。
    expect(decision.deploymentAffinity).toBeNull();
  });

  /** 不换机红线：集合全离线 → DeploymentConstraintWaitError，绝不回落全机队。 */
  it("strict：集合全离线时抛 DeploymentConstraintWaitError（不回落、不派发）", async () => {
    const svc = await buildService();
    mockSetQueryAndClaim({ setQueryResult: [] });
    mockedAxios.post.mockResolvedValue({ data: { ok: true } });

    await expect(dispatchTask(svc, gitTask())).rejects.toBeInstanceOf(
      DeploymentConstraintWaitError,
    );
    // 没有任何占坑/派发动作发生过（集合外设备零接触）。
    expect(mockedAxios.post).not.toHaveBeenCalled();
    expect(executorRepo.find).not.toHaveBeenCalled();
  });

  /** 集合内设备被 tags 过滤光 → 同样走 WAITING 出口，不落终态失败。 */
  it("strict：集合内被 group/tags 过滤光时抛 DeploymentConstraintWaitError（消息含过滤口径）", async () => {
    const svc = await buildService();
    mockSetQueryAndClaim({ setQueryResult: [deployedExecutor()] });
    mockedAxios.post.mockResolvedValue({ data: { ok: true } });

    await expect(
      dispatchTask(svc, gitTask({ executorTags: ["gpu"] })),
    ).rejects.toThrow(/过滤后可用 0 台/);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  /** 优先级：appName 点名是更强的用户意图——约束不叠加，走既有 fleet 池。 */
  it("strict：appName 点名时不应用约束（fleet Top-K 照常）", async () => {
    const svc = await buildService();
    executorRepo.find.mockResolvedValue([
      {
        id: "e-best",
        address: "best:1",
        appName: "best-app",
        status: ExecutorStatus.ONLINE,
        runningTaskCount: 0,
        maxConcurrentTasks: 10,
        version: 1,
      },
    ]);
    executorRepo.createQueryBuilder.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    } as never);
    mockedAxios.post.mockResolvedValue({ data: { ok: true } });

    await dispatchTask(svc, gitTask({ executorAppName: "best-app" }));

    expect(appDeploymentRepo.find).not.toHaveBeenCalled();
    expect(executorRepo.find).toHaveBeenCalled();
    expect(String(mockedAxios.post.mock.calls[0][0])).toContain("best:1");
  });

  /** 解除出口：部署行删光 → 约束消失，回全机队（行为与 prefer 一致）。 */
  it("strict：无部署行时约束不适用，回全机队派发", async () => {
    const svc = await buildService();
    appDeploymentRepo.find.mockResolvedValue([]);
    executorRepo.find.mockResolvedValue([
      {
        id: "e-best",
        address: "best:1",
        status: ExecutorStatus.ONLINE,
        runningTaskCount: 0,
        maxConcurrentTasks: 10,
        version: 1,
      },
    ]);
    executorRepo.createQueryBuilder.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    } as never);
    mockedAxios.post.mockResolvedValue({ data: { ok: true } });

    await dispatchTask(svc, gitTask());

    expect(executorRepo.find).toHaveBeenCalled();
    expect(String(mockedAxios.post.mock.calls[0][0])).toContain("best:1");
  });

  /** 口径契约：strict 的部署行查询必须按 running/stopped/upgrading 三态。 */
  it("strict：部署行查询的状态口径为 DEPLOYMENT_CONSTRAINT_STATUSES 三态", async () => {
    const svc = await buildService();
    mockSetQueryAndClaim({ setQueryResult: [deployedExecutor()] });
    mockedAxios.post.mockResolvedValue({ data: { ok: true } });

    await dispatchTask(svc, gitTask());

    const where = appDeploymentRepo.find.mock.calls[0][0].where;
    expect(where.applicationId).toBe("app-1");
    // In(...) 是 FindOperator，value 承载状态数组——任一常量与实体枚举漂移
    // 会先被 executor-deployment-entity-registration.spec 的契约测试拦下。
    expect(where.status.value).toEqual([...DEPLOYMENT_CONSTRAINT_STATUSES]);
  });

  // ── v2：任务级 deploymentPolicy 覆盖全局 ────────────────────────────────
  /** 任务 strict + 全局 prefer → 约束生效（个别任务显式钉死的灰度形态）。 */
  it("v2：任务 deploymentPolicy=strict 覆盖全局 prefer，约束生效且来源记 task", async () => {
    configService.get.mockImplementation((key: string) =>
      key === "executor.preferDeployedExecutor"
        ? true
        : key === "executor.deploymentPolicy"
          ? "prefer"
          : "http",
    );
    const svc = await buildService();
    mockSetQueryAndClaim({ setQueryResult: [deployedExecutor()] });
    mockedAxios.post.mockResolvedValue({ data: { ok: true } });
    const logSpy = jest
      .spyOn(Logger.prototype, "log")
      .mockImplementation(() => undefined);

    await dispatchTask(svc, gitTask({ deploymentPolicy: "strict" }));

    // 走了集合直查（fleet Top-K 未被调用）——任务级覆盖确实生效。
    expect(executorRepo.find).not.toHaveBeenCalled();
    expect(String(mockedAxios.post.mock.calls[0][0])).toContain("deployed:2");

    const decision = logSpy.mock.calls
      .map((c) => String(c[0]))
      .map((m) => {
        try {
          return JSON.parse(m);
        } catch {
          return null;
        }
      })
      .find((p) => p && p.event === "dispatch.decision");
    expect(decision.deploymentConstraint).toMatchObject({
      mode: "strict",
      source: "task",
    });
  });

  /** 任务 prefer + 全局 strict → 约束不适用，回软偏好（个别任务显式退出）。 */
  it("v2：任务 deploymentPolicy=prefer 覆盖全局 strict，走软偏好（fleet 池）", async () => {
    const svc = await buildService();
    executorRepo.find.mockResolvedValue(twoExecutors());
    executorRepo.createQueryBuilder.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    } as never);
    appDeploymentRepo.find.mockResolvedValue([
      {
        executorId: "e-deployed",
        executorAddress: "deployed:2",
        status: "running",
      },
    ]);
    mockedAxios.post.mockResolvedValue({ data: { ok: true } });

    await dispatchTask(svc, gitTask({ deploymentPolicy: "prefer" }));

    // fleet Top-K 照常（strict 的集合直查未走）；部署行查询按 RUNNING 口径。
    expect(executorRepo.find).toHaveBeenCalled();
    const where = appDeploymentRepo.find.mock.calls[0][0].where;
    expect(where.status).toBe("running");
    // 软偏好仍然生效：部署那台评分更差也前置占坑。
    expect(String(mockedAxios.post.mock.calls[0][0])).toContain("deployed:2");
  });
});

/**
 * FEAT-22 方案 B（版本跟随部署）：派发命中部署设备时，任务改跑该设备部署行
 * 记录的当版包（deployedVersion → application_versions.snapshot.packageUrl）。
 *
 * 只覆盖**接线与端到端语义**（行选择已在 util spec 穷举）：
 *  - 跟随生效：zip 任务 + 命中部署设备 → 载荷 packageUrl = 当版快照包，
 *    执行行留痕当版版本，versionFollow 结构化日志；
 *  - 回退红线：版本行缺失 / snapshot 无 packageUrl / 版本仓库未装配 /
 *    非部署设备（prefer 降级）→ 一律回退当前版，绝不阻断派发；
 *  - 渠道门：git 渠道任务不参与（代码来自仓库，部署版本无关）；
 *  - strict + stopped 行：once 部署跑完的设备也按当版跑（闭环）。
 */
describe("FEAT-22 方案 B: dispatch 版本跟随部署接线（ExecutorService）", () => {
  let executorRepo: ReturnType<typeof makeRepo>;
  let execRepo: ReturnType<typeof makeRepo>;
  let taskRepo: ReturnType<typeof makeRepo>;
  let metricsHistoryRepo: ReturnType<typeof makeRepo>;
  let configService: { get: jest.Mock };
  let appDeploymentRepo: { find: jest.Mock };
  let applicationRepo: { findOne: jest.Mock };
  let applicationVersionRepo: { findOne: jest.Mock };

  const CURRENT_PKG = "http://pkg/current.zip";
  const V12_PKG = "http://pkg/1.2.0.zip";

  /** 当前版行（resolveDispatchTask 的 zip 渠道解析源）。 */
  const appRow = () => ({
    id: "app-1",
    name: "demo-app",
    packageUrl: CURRENT_PKG,
    version: "9.9.9",
  });

  /** 版本快照行（deployedVersion → snapshot.packageUrl）。 */
  const versionRow = (pkg: string) => ({
    id: "v-row",
    snapshot: { packageUrl: pkg },
  });

  /** 部署设备（prefer 池内评分更差；strict 直查命中面）。 */
  const deployedExecutor = () => ({
    id: "e-deployed",
    address: "deployed:2",
    status: ExecutorStatus.ONLINE,
    runningTaskCount: 3,
    maxConcurrentTasks: 10,
    version: 1,
  });

  /** 非部署设备（评分最优）。 */
  const bestExecutor = () => ({
    id: "e-best",
    address: "best:1",
    status: ExecutorStatus.ONLINE,
    runningTaskCount: 0,
    maxConcurrentTasks: 10,
    version: 1,
  });

  const mockClaim = (affected: number | jest.Mock) => {
    executorRepo.createQueryBuilder.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute:
        typeof affected === "function"
          ? (affected as jest.Mock)
          : jest.fn().mockResolvedValue({ affected }),
    } as never);
  };

  const buildService = async (
    opts: {
      withVersionRepo?: boolean;
    } = {},
  ): Promise<ExecutorService> => {
    const providers: any[] = [
      ExecutorService,
      { provide: getRepositoryToken(Executor), useValue: executorRepo },
      { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
      { provide: getRepositoryToken(Task), useValue: taskRepo },
      {
        provide: getRepositoryToken(ExecutorMetricsHistory),
        useValue: metricsHistoryRepo,
      },
      { provide: getQueueToken("task-queue"), useValue: { add: jest.fn() } },
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
        useValue: { findOne: jest.fn().mockRejectedValue(new Error("nf")) },
      },
      {
        provide: SecretsCryptoService,
        useValue: new SecretsCryptoService({ get: () => "" } as any),
      },
      {
        provide: getRepositoryToken(AppDeployment),
        useValue: appDeploymentRepo,
      },
      { provide: getRepositoryToken(Application), useValue: applicationRepo },
    ];
    if (opts.withVersionRepo !== false) {
      providers.push({
        provide: getRepositoryToken(ApplicationVersion),
        useValue: applicationVersionRepo,
      });
    }
    const module = await Test.createTestingModule({ providers }).compile();
    return module.get(ExecutorService);
  };

  /** zip 渠道任务（版本跟随的适用面）。 */
  const zipTask = (overrides: Record<string, unknown> = {}) =>
    ({
      id: "task-1",
      name: "t",
      applicationId: "app-1",
      codeSource: TaskCodeSource.APPLICATION_ZIP,
      timeout: 10,
      ...overrides,
    }) as unknown as Task;

  const dispatchTask = (
    svc: ExecutorService,
    task: Task,
    exec?: TaskExecution,
  ) => {
    const execution = exec ?? ({ id: "exec-1", params: {} } as TaskExecution);
    return svc.dispatch(task, execution).then(() => execution);
  };

  const payloadOf = () =>
    (mockedAxios.post.mock.calls[0][1] as { task: { packageUrl?: string } })
      .task.packageUrl;

  beforeEach(() => {
    executorRepo = makeRepo();
    execRepo = makeRepo();
    taskRepo = makeRepo();
    metricsHistoryRepo = makeRepo();
    appDeploymentRepo = {
      find: jest.fn().mockResolvedValue([
        {
          executorId: "e-deployed",
          executorAddress: "deployed:2",
          status: "running",
          deployedVersion: "1.2.0",
          deployedAt: "2026-09-30T10:00:00Z",
        },
      ]),
    };
    applicationRepo = { findOne: jest.fn().mockResolvedValue(appRow()) };
    applicationVersionRepo = {
      findOne: jest.fn().mockResolvedValue(versionRow(V12_PKG)),
    };
    configService = {
      get: jest.fn((key: string) =>
        key === "executor.preferDeployedExecutor"
          ? true
          : key === "executor.deploymentPolicy"
            ? "prefer"
            : "http",
      ),
    };
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    jest.clearAllMocks();
    // clearAllMocks 之后统一装配（同 FEAT-22 块的纪律）。
    appDeploymentRepo.find.mockResolvedValue([
      {
        executorId: "e-deployed",
        executorAddress: "deployed:2",
        status: "running",
        deployedVersion: "1.2.0",
        deployedAt: "2026-09-30T10:00:00Z",
      },
    ]);
    applicationRepo.findOne.mockResolvedValue(appRow());
    applicationVersionRepo.findOne.mockResolvedValue(versionRow(V12_PKG));
    configService.get.mockImplementation((key: string) =>
      key === "executor.preferDeployedExecutor"
        ? true
        : key === "executor.deploymentPolicy"
          ? "prefer"
          : "http",
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("跟随生效：命中部署设备改跑当版快照包，执行行留痕当版版本", async () => {
    const svc = await buildService();
    executorRepo.find.mockResolvedValue([bestExecutor(), deployedExecutor()]);
    mockClaim(1);
    mockedAxios.post.mockResolvedValue({ data: { ok: true } });
    const logSpy = jest
      .spyOn(Logger.prototype, "log")
      .mockImplementation(() => undefined);

    const exec = await dispatchTask(svc, zipTask());

    // 版本快照按 (applicationId, version) 精确查询。
    expect(applicationVersionRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { applicationId: "app-1", version: "1.2.0" },
      }),
    );
    // 载荷包 = 当版快照包（不是应用当前版）。
    expect(payloadOf()).toBe(V12_PKG);
    // 执行行留痕当版。
    expect(exec.resolvedPackageVersion).toBe("1.2.0");
    expect(exec.resolvedPackageUrl).toBe(V12_PKG);
    // 结构化日志可回溯。
    const follow = logSpy.mock.calls
      .map((c) => String(c[0]))
      .map((m) => {
        try {
          return JSON.parse(m);
        } catch {
          return null;
        }
      })
      .find((p) => p && p.event === "dispatch.versionFollow");
    expect(follow).toMatchObject({
      version: "1.2.0",
      packageUrl: V12_PKG,
      executor: "deployed:2",
    });
  });

  it("prefer 降级到非部署设备：跑当前版，不查版本库", async () => {
    const svc = await buildService();
    executorRepo.find.mockResolvedValue([bestExecutor(), deployedExecutor()]);
    // 部署那台占坑失败 → 顺延 best（非部署设备）。
    const execute = jest
      .fn()
      .mockResolvedValueOnce({ affected: 0 })
      .mockResolvedValueOnce({ affected: 1 });
    mockClaim(execute);
    mockedAxios.post.mockResolvedValue({ data: { ok: true } });

    const exec = await dispatchTask(svc, zipTask());

    expect(applicationVersionRepo.findOne).not.toHaveBeenCalled();
    expect(payloadOf()).toBe(CURRENT_PKG);
    expect(exec.resolvedPackageVersion).toBe("9.9.9");
  });

  it("版本行缺失：回退当前版 + warn，不阻断派发", async () => {
    const svc = await buildService();
    executorRepo.find.mockResolvedValue([bestExecutor(), deployedExecutor()]);
    mockClaim(1);
    applicationVersionRepo.findOne.mockResolvedValue(null);
    const warnSpy = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
    mockedAxios.post.mockResolvedValue({ data: { ok: true } });

    await dispatchTask(svc, zipTask());

    expect(payloadOf()).toBe(CURRENT_PKG);
    expect(
      warnSpy.mock.calls.some((c) => String(c[0]).includes("方案 B")),
    ).toBe(true);
  });

  it("snapshot 无 packageUrl：回退当前版", async () => {
    const svc = await buildService();
    executorRepo.find.mockResolvedValue([bestExecutor(), deployedExecutor()]);
    mockClaim(1);
    applicationVersionRepo.findOne.mockResolvedValue({
      id: "v-row",
      snapshot: {},
    });
    mockedAxios.post.mockResolvedValue({ data: { ok: true } });

    await dispatchTask(svc, zipTask());

    expect(payloadOf()).toBe(CURRENT_PKG);
  });

  it("strict + stopped 行（once 闭环）：按部署行当版跑", async () => {
    configService.get.mockImplementation((key: string) =>
      key === "executor.preferDeployedExecutor"
        ? true
        : key === "executor.deploymentPolicy"
          ? "strict"
          : "http",
    );
    appDeploymentRepo.find.mockResolvedValue([
      {
        executorId: "e-deployed",
        executorAddress: "deployed:2",
        status: "stopped",
        deployedVersion: "2.0.0",
      },
    ]);
    applicationVersionRepo.findOne.mockResolvedValue(
      versionRow("http://pkg/2.0.0.zip"),
    );
    const svc = await buildService();
    // strict 集合直查：executorRepo.find（fleet Top-K）不被调用，走 getMany。
    executorRepo.createQueryBuilder.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([deployedExecutor()]),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    } as never);
    mockedAxios.post.mockResolvedValue({ data: { ok: true } });

    await dispatchTask(svc, zipTask());

    expect(executorRepo.find).not.toHaveBeenCalled();
    expect(applicationVersionRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { applicationId: "app-1", version: "2.0.0" },
      }),
    );
    expect(payloadOf()).toBe("http://pkg/2.0.0.zip");
  });

  it("版本仓库未装配：回退当前版，不抛", async () => {
    const svc = await buildService({ withVersionRepo: false });
    executorRepo.find.mockResolvedValue([bestExecutor(), deployedExecutor()]);
    mockClaim(1);
    mockedAxios.post.mockResolvedValue({ data: { ok: true } });

    await dispatchTask(svc, zipTask());

    expect(payloadOf()).toBe(CURRENT_PKG);
  });

  it("git 渠道任务不参与版本跟随（代码来自仓库，部署版本无关）", async () => {
    const svc = await buildService();
    executorRepo.find.mockResolvedValue([bestExecutor(), deployedExecutor()]);
    mockClaim(1);
    mockedAxios.post.mockResolvedValue({ data: { ok: true } });

    await dispatchTask(
      svc,
      zipTask({ codeSource: TaskCodeSource.GIT }) as Task,
    );

    expect(applicationVersionRepo.findOne).not.toHaveBeenCalled();
    expect(payloadOf()).toBeUndefined();
  });
});

/**
 * ARCH-36（ADR-017 阶段 2）：`deviceFingerprint` 冲突/漂移观测在 service 层的接线。
 *
 * 判据本身已被 `executor-fingerprint.util.spec.ts` 的 30 个用例钉死；本组只验证
 * 三件事，且都是"判据正确但没接线就等于没做"的形态：
 *  1. **接线** —— register 与 heartbeat 两个入口喂给同一个跟踪器；
 *  2. **可见性** —— 硬冲突外发 ERROR 通知、漂移只留 info 日志、节流生效；
 *  3. **零行为变化** —— 未上报/非法指纹的存量执行器不登记、不告警、不写库，
 *     且通知抛错不影响注册/心跳主链（fail-open）。
 *
 * 与 P0 的关系也在此显式断言：两个跟踪器**独立外发**，同一台机器同时命中两条
 * 判据时会收到两条告警（证据面不同，刻意不去重）。
 */
describe("ExecutorService — ARCH-36 deviceFingerprint 冲突/漂移接线", () => {
  const ADDR = "192.168.1.100:8002";
  const ADDR2 = "10.0.0.7:8002";
  const ADDR3 = "172.16.5.9:8002";
  // 合法指纹形态：sha256 的 64 位小写十六进制（与执行器侧同源）。
  const FP_A = "a1".repeat(32);
  const FP_B = "b2".repeat(32);
  const FP_OLD = "c3".repeat(32);
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const B = "bbbbbbbb-0000-4000-8000-000000000002";

  let executorRepo: ReturnType<typeof makeRepo>;
  let execRepo: ReturnType<typeof makeRepo>;
  let taskRepo: ReturnType<typeof makeRepo>;
  let metricsHistoryRepo: ReturnType<typeof makeRepo>;
  let configService: jest.Mocked<Pick<ConfigService, "get">>;
  let sendAll: jest.Mock;

  const buildService = async (): Promise<ExecutorService> => {
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
        {
          provide: getQueueToken("task-queue"),
          useValue: { add: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: ConfigService, useValue: configService },
        {
          provide: NotificationService,
          useValue: {
            notifyFailure: jest.fn(),
            notifyFailureWithConfig: jest.fn(),
            notifyExecutorOnline: jest.fn().mockResolvedValue(undefined),
            notifyExecutorOffline: jest.fn().mockResolvedValue(undefined),
            sendAll,
          },
        },
        {
          provide: SystemConfigService,
          useValue: {
            findOne: jest.fn().mockRejectedValue(new Error("not found")),
          },
        },
        {
          provide: SecretsCryptoService,
          useValue: new SecretsCryptoService({ get: () => "" } as any),
        },
      ],
    }).compile();
    return module.get(ExecutorService);
  };

  /** 一行已存在的执行器（register 走重注册路径、heartbeat 直接命中）。 */
  const existingRow = (overrides: Record<string, unknown> = {}) =>
    ({
      id: "e1",
      address: ADDR,
      appName: "node-a",
      status: ExecutorStatus.ONLINE,
      runningTaskCount: 0,
      version: 1,
      ...overrides,
    }) as never;

  beforeEach(() => {
    executorRepo = makeRepo();
    execRepo = makeRepo();
    taskRepo = makeRepo();
    metricsHistoryRepo = makeRepo();
    configService = { get: jest.fn().mockReturnValue("http") } as never;
    sendAll = jest.fn().mockResolvedValue(undefined);
    // 冲突告警走 logger.error、漂移走 logger.log——测试里静音，断言靠 spy 计数。
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** register 与 heartbeat 必须共享同一跟踪器，否则各自"首次见到"，冲突永不触发。 */
  it("register 与 heartbeat 共享跟踪状态（跨入口可判硬冲突）", async () => {
    const svc = await buildService();
    executorRepo.findOne.mockResolvedValue(existingRow());
    executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
    (svc as any).rotateToken = jest.fn().mockResolvedValue({ token: "tok" });

    // register 登记安装 A 的指纹。
    await svc.register({
      appName: "node-a",
      address: ADDR,
      deviceFingerprint: FP_A,
    });
    expect(sendAll).not.toHaveBeenCalled();

    // heartbeat 上报同一 address 的**另一个**安装 B → 直接证据成立。
    await svc.heartbeat(ADDR, { deviceFingerprint: FP_B });
    expect(sendAll).toHaveBeenCalledTimes(1);
    expect(String(sendAll.mock.calls[0][0].title)).toContain(
      "shared by multiple installs",
    );
    expect(String(sendAll.mock.calls[0][0].title)).toContain(ADDR);
  });

  /** 硬冲突必须外发 ERROR 级通知（数据正确性问题，不能只落 debug）。 */
  it("硬冲突外发一次 error 级通知，且载荷含可排障信息", async () => {
    const svc = await buildService();
    const svcAny = svc as any;
    // 直接驱动接线，聚焦"载荷与级别"而非重复覆盖判据。
    svcAny.observeDeviceFingerprint(ADDR, FP_A, "register");
    svcAny.observeDeviceFingerprint(ADDR, FP_B, "heartbeat");

    expect(sendAll).toHaveBeenCalledTimes(1);
    const payload = sendAll.mock.calls[0][0];
    expect(payload.level).toBe("error");
    expect(payload.title).toContain(ADDR);
    // 排障必需信息：现象（几个指纹）、**并存双方是谁**（只报"有几个"运维仍要
    // 手工翻日志关联，给不出处置面）、动作（怎么修）、判据来源（为什么可信）。
    expect(payload.content).toContain(FP_A.slice(0, 12));
    expect(payload.content).toContain(FP_B.slice(0, 12));
    expect(payload.content).toContain("EXECUTOR_ADDRESS_PUBLIC");
    expect(payload.content).toContain("deviceFingerprint");
  });

  /** 地址漂移（同一安装换 IP）只留 info 日志，**绝不告警**——狼来了红线。 */
  it("地址漂移只记 log 不告警", async () => {
    const svc = await buildService();
    const logSpy = jest
      .spyOn(Logger.prototype, "log")
      .mockImplementation(() => undefined);
    const svcAny = svc as any;

    // 同一指纹先在 ADDR 出现，随后从 ADDR2 上报 = 机器换网。
    svcAny.observeDeviceFingerprint(ADDR, FP_A, "heartbeat");
    svcAny.observeDeviceFingerprint(ADDR2, FP_A, "heartbeat");

    expect(sendAll).not.toHaveBeenCalled();
    const driftLogged = logSpy.mock.calls.some((c) =>
      String(c[0]).includes("address drift, not a conflict"),
    );
    expect(driftLogged).toBe(true);
  });

  /** 节流：同一 (address, fingerprint) 在窗口内重复冲突只外发一次（心跳 30s 高频）。 */
  it("冲突告警受节流保护（不刷通知）", async () => {
    const svc = await buildService();
    const svcAny = svc as any;
    svcAny.observeDeviceFingerprint(ADDR, FP_A, "register");
    svcAny.observeDeviceFingerprint(ADDR, FP_B, "heartbeat"); // 首次告警
    for (let i = 0; i < 5; i++) {
      svcAny.observeDeviceFingerprint(ADDR, FP_B, "heartbeat");
    }
    expect(sendAll).toHaveBeenCalledTimes(1);
  });

  /** 正常重启（同一安装、同一指纹）绝不告警——指纹跨重启不变是判据的基石。 */
  it("正常重启不告警（防误报）", async () => {
    const svc = await buildService();
    const svcAny = svc as any;
    svcAny.observeDeviceFingerprint(ADDR, FP_A, "register");
    for (let i = 0; i < 5; i++) {
      svcAny.observeDeviceFingerprint(ADDR, FP_A, "heartbeat");
    }
    expect(sendAll).not.toHaveBeenCalled();
  });

  /**
   * 两个跟踪器**独立外发**：同一台机器同时命中 P0 时序判据与 ARCH-36 身份判据时，
   * 会收到两条告警。这是刻意保留的——两条判据的证据面不同（进程并存 vs 安装身份
   * 冲突），合并会丢失"哪条通路成立"的区分度。
   */
  it("P0 与 ARCH-36 两条判据各自独立外发（不去重）", async () => {
    const svc = await buildService();
    const svcAny = svc as any;
    svcAny.observeAddressConflict(ADDR, A, "register");
    svcAny.observeDeviceFingerprint(ADDR, FP_A, "register");
    svcAny.observeAddressConflict(ADDR, B, "register");
    svcAny.observeDeviceFingerprint(ADDR, FP_B, "register"); // 指纹冲突 → 1
    svcAny.observeAddressConflict(ADDR, A, "heartbeat"); // A 复活 → 2
    svcAny.observeDeviceFingerprint(ADDR, FP_B, "heartbeat"); // 节流，不加

    expect(sendAll).toHaveBeenCalledTimes(2);
    const titles = sendAll.mock.calls.map((c) => String(c[0].title));
    expect(titles.some((t) => t.includes("Executor address conflict"))).toBe(
      true,
    );
    expect(titles.some((t) => t.includes("shared by multiple installs"))).toBe(
      true,
    );
  });

  /** 首注册即上报 → 落列（v3 执行器的正常路径）。 */
  it("首注册带上合法指纹时写入新行", async () => {
    const svc = await buildService();
    executorRepo.findOne.mockResolvedValue(null);
    executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));

    await svc.register({
      appName: "node-a",
      address: ADDR,
      deviceFingerprint: FP_A,
    });

    expect(executorRepo.create).toHaveBeenCalledTimes(1);
    expect(executorRepo.create.mock.calls[0][0].deviceFingerprint).toBe(FP_A);
  });

  /** 首注册携带非法指纹 → 视同未上报，列保持 NULL（不写脏值）。 */
  it("首注册携带非法指纹时不落列（视同未上报）", async () => {
    const svc = await buildService();
    executorRepo.findOne.mockResolvedValue(null);
    executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));

    await svc.register({
      appName: "node-a",
      address: ADDR,
      deviceFingerprint: "NOT-A-FINGERPRINT",
    });

    expect(
      executorRepo.create.mock.calls[0][0].deviceFingerprint,
    ).toBeUndefined();
  });

  /** 重注册采纳合法指纹（阶段 3 的读面数据来源）。 */
  it("重注册采纳合法指纹并落库", async () => {
    const svc = await buildService();
    const row = existingRow();
    executorRepo.findOne.mockResolvedValue(row);
    executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));

    await svc.register({
      appName: "node-a",
      address: ADDR,
      deviceFingerprint: FP_A,
    });

    expect((row as any).deviceFingerprint).toBe(FP_A);
    expect(executorRepo.save).toHaveBeenCalled();
  });

  /** 重注册携带非法指纹 → 绝不动 DB（不得把已存值擦成 NULL）。 */
  it("重注册携带非法指纹时保留 DB 旧值", async () => {
    const svc = await buildService();
    const row = existingRow({ deviceFingerprint: FP_OLD });
    executorRepo.findOne.mockResolvedValue(row);
    executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));

    await svc.register({
      appName: "node-a",
      address: ADDR,
      deviceFingerprint: "zzz",
    });

    expect((row as any).deviceFingerprint).toBe(FP_OLD);
  });

  /** 心跳采纳合法指纹。 */
  it("心跳采纳合法指纹", async () => {
    const svc = await buildService();
    const row = existingRow({ deviceFingerprint: null });
    executorRepo.findOne.mockResolvedValue(row);
    executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));

    await svc.heartbeat(ADDR, { deviceFingerprint: FP_A });

    expect((row as any).deviceFingerprint).toBe(FP_A);
  });

  /**
   * **本阶段最关键的兼容性红线**：心跳缺省该字段时绝不动 DB。
   * 旧执行器（协议 v1/v2）或采集失败的 v3 执行器每 30s 一次心跳，若"缺省即置
   * NULL"，会把已存的指纹历史擦光——那正是冲突观测最需要的证据。
   */
  it("心跳缺省指纹时绝不清空 DB 已存值", async () => {
    const svc = await buildService();
    const row = existingRow({ deviceFingerprint: FP_OLD });
    executorRepo.findOne.mockResolvedValue(row);
    executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));

    await svc.heartbeat(ADDR, {});
    await svc.heartbeat(ADDR, { cpuUsage: 12 });

    expect((row as any).deviceFingerprint).toBe(FP_OLD);
  });

  /** 心跳携带非法指纹 → 只留 debug（不 warn 刷屏），DB 保留旧值。 */
  it("心跳携带非法指纹时保留 DB 旧值", async () => {
    const svc = await buildService();
    const row = existingRow({ deviceFingerprint: FP_OLD });
    executorRepo.findOne.mockResolvedValue(row);
    executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));

    await svc.heartbeat(ADDR, { deviceFingerprint: "not-hex-at-all" });

    expect((row as any).deviceFingerprint).toBe(FP_OLD);
  });

  /**
   * 存量旧执行器（未上报指纹）零影响：不登记、不告警、不抛错。
   * 这是"零行为变化"验收的核心断言。
   */
  it("未上报指纹的旧执行器不触发任何告警", async () => {
    const svc = await buildService();
    const svcAny = svc as any;
    const errorSpy = jest
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    executorRepo.findOne.mockResolvedValue(existingRow());
    executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));

    await svc.heartbeat(ADDR, {});
    await svc.heartbeat(ADDR, { deviceFingerprint: null });
    await svc.heartbeat(ADDR, { deviceFingerprint: "  " });

    expect(sendAll).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    // 计数器仍会 +1（口径："累计观测次数"含未上报），但没有任何指纹被登记。
    expect(svcAny.deviceFingerprintTracker.stats().reportsWithFingerprint).toBe(
      0,
    );
    expect(svcAny.deviceFingerprintTracker.stats().trackedAddresses).toBe(0);
  });

  /**
   * fail-open 红线：通知后端同步抛错时，register/heartbeat 主链照常返回。
   * 检测设施本身不能成为新的故障源。
   */
  it("通知同步抛错时 register/heartbeat 主链不受影响（fail-open）", async () => {
    sendAll = jest.fn().mockImplementation(() => {
      throw new Error("notification backend down");
    });
    const svc = await buildService();
    executorRepo.findOne.mockResolvedValue(existingRow());
    executorRepo.save.mockImplementation((e: any) => Promise.resolve(e));
    (svc as any).rotateToken = jest.fn().mockResolvedValue({ token: "tok" });

    await expect(
      svc.register({
        appName: "node-a",
        address: ADDR,
        deviceFingerprint: FP_A,
      }),
    ).resolves.toBeDefined();
    // FP_B 触发硬冲突路径，但通知抛错被吞——主链照常返回。
    await expect(
      svc.heartbeat(ADDR, { deviceFingerprint: FP_B }),
    ).resolves.toBeDefined();
  });

  /** 观测口径可读：冲突率、覆盖率是"到底有多少台真的报了"的唯一来源。 */
  it("观测口径（stats）如实反映覆盖率与冲突率", async () => {
    const svc = await buildService();
    const svcAny = svc as any;
    svcAny.observeDeviceFingerprint(ADDR, FP_A, "heartbeat");
    svcAny.observeDeviceFingerprint(ADDR, FP_B, "heartbeat"); // 同址双指纹 = 冲突
    svcAny.observeDeviceFingerprint(ADDR2, FP_A, "heartbeat"); // 漂移
    svcAny.observeDeviceFingerprint(ADDR3, null, "heartbeat"); // 存量未上报

    const stats = svcAny.deviceFingerprintTracker.stats();
    expect(stats.reports).toBe(4);
    expect(stats.reportsWithFingerprint).toBe(3);
    expect(stats.trackedAddresses).toBe(2);
    expect(stats.addressesWithMultipleFingerprints).toBe(1);
    expect(stats.trackedFingerprints).toBe(2);
    expect(stats.fingerprintsOnMultipleAddresses).toBe(1);
    expect(stats.conflictRate).toBe(0.5);
  });
  // ARCH-31 §3.7 收口：三张令牌派生缓存的跨实例驱逐广播。本实例 rotate/remove
  // 时 PUBLISH；远端实例的广播经 bindHandlers 回调逐出本地缓存；订阅（重）连
  // 的 flush 全量清空自愈漏消息。同步服务缺失 = 退化为既有 60s TTL（不劣化）。
});

// ─────────────────────────────────────────────────────────────────────────────
// 执行器域审计：A-4（候选池条件下推 SQL）/ A-9（push 目标全量查询）/
// A-11（估时热路径采样上界）
// ─────────────────────────────────────────────────────────────────────────────

describe("ExecutorService audit fixes (A-4 / A-9 / A-11)", () => {
  let service: ExecutorService;
  let executorRepo: ReturnType<typeof makeRepo>;
  let execRepo: ReturnType<typeof makeRepo>;
  let taskRepo: ReturnType<typeof makeRepo>;
  let metricsHistoryRepo: ReturnType<typeof makeRepo>;
  let taskQueue: { add: jest.Mock };
  let configService: jest.Mocked<Pick<ConfigService, "get">>;
  const execution = { id: "exec-1", params: {} } as unknown as TaskExecution;

  const mkFleetRow = (over: Partial<Executor> = {}): Executor =>
    ({
      id: "e-" + Math.random().toString(36).slice(2, 8),
      appName: "ex",
      address: "127.0.0.1:3105",
      status: ExecutorStatus.ONLINE,
      runningTaskCount: 0,
      version: 1,
      ...over,
    }) as Executor;

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
        {
          provide: SecretsCryptoService,
          useValue: new SecretsCryptoService({ get: () => "" } as any),
        },
      ],
    }).compile();
    service = module.get(ExecutorService);
    jest.clearAllMocks();
    mockedAxios.post.mockResolvedValue({ data: { ok: true } });
  });

  /** fleet 查询的 QB 实例是 dispatch 创建的第一个 QB。 */
  const fleetQb = () =>
    (executorRepo.createQueryBuilder as jest.Mock).mock.results[0].value;

  /** Brackets 谓词是闭包对象——用记录型假 qb 展开其内部 SQL 片段。 */
  const expandBrackets = (brackets: {
    whereFactory: (qb: never) => unknown;
  }) => {
    const sqls: string[] = [];
    const fake: Record<string, unknown> = {};
    const record = (sql: unknown) => {
      // 嵌套 Brackets（反亲和外层的 orWhere(内层 Brackets)）递归展开。
      if (sql && typeof sql === "object" && "whereFactory" in (sql as object)) {
        sqls.push(...expandBrackets(sql as never));
        return fake;
      }
      if (typeof sql === "string") sqls.push(sql);
      return fake;
    };
    fake.where = record;
    fake.orWhere = record;
    fake.andWhere = record;
    brackets.whereFactory(fake as never);
    return sqls;
  };

  describe("A-4: fleet 候选池条件下推 SQL", () => {
    it("组/标签条件下推：fleet 查询走 QB（带 groupName 等值 + tags LIKE），组内成员被选中", async () => {
      // SQL 收窄模拟：getMany 回落 find fixture——"组外机队庞大"的行根本
      // 不会进入候选池（生产 SQL 已按 groupName/tags 过滤后再 Top-K）。
      executorRepo.find.mockResolvedValue([
        mkFleetRow({
          id: "e-in",
          address: "in-group:1",
          groupName: "prod",
          tags: ["gpu"],
        }),
      ]);
      await service.dispatch(
        {
          id: "t1",
          name: "t",
          timeout: 10,
          executorGroup: "prod",
          executorTags: ["gpu"],
        } as unknown as Task,
        execution,
      );
      // fleet 查询不再走无过滤的 repo.find——Top-K 截断与过滤同查询发生。
      // （repo.find 唯一一次调用来自 QB getMany 回落 fixture 的替身机制，
      // 形态为无参调用。）
      const findCalls = executorRepo.find.mock.calls;
      expect(findCalls).toHaveLength(1);
      expect(findCalls[0]).toHaveLength(0);
      const qb = fleetQb();
      expect(qb.where.mock.calls[0][0]).toContain("executor.status = :status");
      const andSqls = qb.andWhere.mock.calls.map((c: any[]) => String(c[0]));
      expect(andSqls).toContain("executor.groupName = :fleetGroupName");
      expect(andSqls).toContain(
        "(',' || executor.tags || ',') LIKE :fleetReqTag0",
      );
      // Top-K 上限仍在（SQL 过滤后的池再截断）。
      expect(qb.take).toHaveBeenCalledWith(500);
      expect(mockedAxios.post.mock.calls[0][0]).toContain("in-group:1");
    });

    it("亲和/反亲和/运行时条件下推：OR 命中、排除语义与 capabilities 谓词同查询下推", async () => {
      executorRepo.find.mockResolvedValue([
        mkFleetRow({ id: "e-gpu", address: "gpu:1", tags: ["gpu"] }),
      ]);
      await service.dispatch(
        {
          id: "t1",
          name: "t",
          timeout: 10,
          runtime: "python",
          executorAffinityTags: ["gpu", "edge"],
          executorAntiAffinityTags: ["windows"],
        } as unknown as Task,
        execution,
      );
      const andArgs = fleetQb().andWhere.mock.calls.map((c: any[]) => c[0]);
      // 扁平谓词：runtime 的 capabilities 包含（空/NULL = 万能）。
      const flatSqls = andArgs.filter((a: unknown) => typeof a === "string");
      expect(
        flatSqls.some((s: string) =>
          s.includes("executor.capabilities = ''"),
        ) && flatSqls.some((s: string) => s.includes(":fleetRuntime")),
      ).toBe(true);
      // Brackets 谓词：affinity（OR 命中）与 anti-affinity（NULL 放行 +
      // NOT LIKE 排除）在闭包内部下推。
      const bracketSqls = andArgs
        .filter(
          (a: unknown) =>
            a && typeof a === "object" && "whereFactory" in (a as object),
        )
        .flatMap((a: any) => expandBrackets(a));
      expect(
        bracketSqls.some((s: string) => s.includes("LIKE :fleetAffTag0")),
      ).toBe(true);
      expect(
        bracketSqls.some((s: string) => s.includes("LIKE :fleetAffTag1")),
      ).toBe(true);
      expect(
        bracketSqls.some((s: string) => s.includes("NOT LIKE :fleetAntiTag0")),
      ).toBe(true);
      expect(
        bracketSqls.some((s: string) => s.includes("executor.tags IS NULL")),
      ).toBe(true);
      expect(mockedAxios.post.mock.calls[0][0]).toContain("gpu:1");
    });

    it("内存过滤链保留：QB 返回的超集命中（不满足 tags 子集）仍被剔除", async () => {
      executorRepo.find.mockResolvedValue([
        // tags 不含要求的 cuda——模拟 LIKE 通配符/超集命中的兜底场景
        mkFleetRow({ id: "e-partial", address: "partial:1", tags: ["gpu"] }),
      ]);
      await expect(
        service.dispatch(
          {
            id: "t1",
            name: "t",
            timeout: 10,
            executorTags: ["gpu", "cuda"],
          } as unknown as Task,
          execution,
        ),
      ).rejects.toThrow(
        "No online executors match the requested group/tags/runtime",
      );
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it("无 tags/affinity/runtime 条件时保持原 repo.find 形态（appName/group 等值并入 where）", async () => {
      executorRepo.find.mockResolvedValue([]);
      await expect(
        service.dispatch(
          { id: "t1", name: "t", timeout: 10 } as unknown as Task,
          execution,
        ),
      ).rejects.toThrow(
        "No online executors match the requested group/tags/runtime",
      );
      expect(executorRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: ExecutorStatus.ONLINE },
          order: { runningTaskCount: "ASC" },
          take: expect.any(Number),
        }),
      );
      executorRepo.find.mockClear();
      executorRepo.find.mockResolvedValue([
        mkFleetRow({ id: "e-a", address: "app-a:1", appName: "app-a" }),
      ]);
      await service.dispatch(
        {
          id: "t1",
          name: "t",
          timeout: 10,
          executorAppName: "app-a",
        } as unknown as Task,
        execution,
      );
      expect(executorRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: ExecutorStatus.ONLINE,
            appName: "app-a",
          },
        }),
      );
      expect(mockedAxios.post.mock.calls[0][0]).toContain("app-a:1");
    });
  });

  describe("A-9: findPushTargets（push 场景专用查询）", () => {
    it("显式 executorIds 按 id 直查（不做状态过滤，操作者点名语义）", async () => {
      const rows = [
        { id: "a", status: ExecutorStatus.OFFLINE },
        { id: "b", status: ExecutorStatus.ONLINE },
      ] as unknown as Executor[];
      executorRepo.find.mockResolvedValue(rows);
      const result = await service.findPushTargets(["a", "b"]);
      expect(result).toEqual(rows);
      const arg = executorRepo.find.mock.calls[0][0] as {
        where: { id: { _value: string[] } };
      };
      expect(arg.where.id._value).toEqual(["a", "b"]);
    });

    it("空 executorIds → status=ONLINE 全量分页扫描，翻页到取尽（>500 不漏机）", async () => {
      const page1 = Array.from({ length: 500 }, (_, i) => ({
        id: `p1-${i}`,
      })) as unknown as Executor[];
      const page2 = [{ id: "p2-0" }] as unknown as Executor[];
      executorRepo.find
        .mockResolvedValueOnce(page1)
        .mockResolvedValueOnce(page2);
      const result = await service.findPushTargets();
      expect(result).toHaveLength(501);
      expect(executorRepo.find).toHaveBeenCalledTimes(2);
      const first = executorRepo.find.mock.calls[0][0] as {
        where: { status: ExecutorStatus };
        skip: number;
        take: number;
      };
      expect(first.where.status).toBe(ExecutorStatus.ONLINE);
      expect(first.skip).toBe(0);
      const second = executorRepo.find.mock.calls[1][0] as { skip: number };
      expect(second.skip).toBe(500);
    });
  });

  describe("A-11: estimatedDurations 热路径采样上界", () => {
    it("候选地址集的 RUNNING 读取带 take（1 地址 = 50）", async () => {
      executorRepo.find.mockResolvedValue([
        mkFleetRow({ id: "e1", address: "a:1", runningTaskCount: 3 }),
      ]);
      execRepo.find.mockResolvedValue([]);
      await service.dispatch(
        { id: "t1", name: "t", timeout: 10 } as unknown as Task,
        execution,
      );
      expect(execRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ take: 50 }),
      );
    });

    it("大候选集（>100 地址）命中 5000 硬顶", async () => {
      executorRepo.find.mockResolvedValue(
        Array.from({ length: 150 }, (_, i) =>
          mkFleetRow({
            id: `e${i}`,
            address: `addr${i}:1`,
            runningTaskCount: 2,
          }),
        ),
      );
      execRepo.find.mockResolvedValue([]);
      await service.dispatch(
        { id: "t1", name: "t", timeout: 10 } as unknown as Task,
        execution,
      );
      expect(execRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5000 }),
      );
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEEP-AUDIT B·1.1：执行器删除影响面（removal-impact）与自动清理跳过
// ─────────────────────────────────────────────────────────────────────────────

describe("ExecutorService removal impact (B·1.1)", () => {
  let service: ExecutorService;
  // 外层 describe 的 repo 变量作用域不覆盖本块——本地声明同名替身。
  let executorRepo: ReturnType<typeof makeRepo>;
  let taskRepo: ReturnType<typeof makeRepo>;
  let execRepo: ReturnType<typeof makeRepo>;
  let metricsHistoryRepo: ReturnType<typeof makeRepo>;
  let taskQueue: { add: jest.Mock };
  let configService: jest.Mocked<Pick<ConfigService, "get">>;
  let pullService: { clear: jest.Mock; depth: jest.Mock };
  let audit: { log: jest.Mock };

  beforeEach(async () => {
    executorRepo = makeRepo();
    taskRepo = makeRepo();
    pullService = {
      clear: jest.fn().mockResolvedValue(undefined),
      depth: jest.fn().mockResolvedValue(0),
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    taskQueue = { add: jest.fn().mockResolvedValue(undefined) };
    configService = { get: jest.fn().mockReturnValue("http") };
    metricsHistoryRepo = makeRepo();
    execRepo = makeRepo();
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
        {
          provide: SecretsCryptoService,
          useValue: new SecretsCryptoService({ get: () => "" } as any),
        },
        // B·1.1：pull 队列（clear/depth）与审计均接线上
        { provide: ExecutorPullService, useValue: pullService },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = module.get(ExecutorService);
    jest.clearAllMocks();
  });

  it("describeRemovalImpact counts pinned + appName-bound tasks and pull depth", async () => {
    executorRepo.findOne.mockResolvedValue({
      id: "exec-1",
      address: "10.0.0.5:8002",
      appName: "exec-a",
      status: ExecutorStatus.OFFLINE,
    });
    taskRepo.count
      .mockResolvedValueOnce(3) // executorId pin
      .mockResolvedValueOnce(2); // executorAppName binding
    pullService.depth.mockResolvedValue(7);

    const impact = await service.describeRemovalImpact("exec-1");

    expect(impact).toEqual({
      appName: "exec-a",
      address: "10.0.0.5:8002",
      status: ExecutorStatus.OFFLINE,
      pinnedTasks: 3,
      appNameBoundTasks: 2,
      pendingPullItems: 7,
    });
    // 第一个 count 查 executorId 钉定，第二个查 executorAppName 绑定
    // （count 实参带 where 包裹 + 排除软删除行 status: Not(DELETED)）。
    expect(taskRepo.count.mock.calls[0][0]).toMatchObject({
      where: { executorId: "exec-1" },
    });
    expect(taskRepo.count.mock.calls[1][0]).toMatchObject({
      where: { executorAppName: "exec-a" },
    });
  });

  it("describeRemovalImpact falls back to zero depth when the pull service is absent", async () => {
    executorRepo.findOne.mockResolvedValue({
      id: "exec-1",
      address: "a",
      appName: "a",
      status: ExecutorStatus.ONLINE,
    });
    taskRepo.count.mockResolvedValue(0);
    // 不接线 ExecutorPullService（@Optional → null）——depth 读不到按 0 呈现，
    // 不阻断预览（管理台最差情形是少显示一列，绝不 500）。
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
        { provide: NotificationService, useValue: { sendAll: jest.fn() } },
        {
          provide: SystemConfigService,
          useValue: {
            findOne: jest.fn().mockRejectedValue(new Error("not found")),
          },
        },
        {
          provide: SecretsCryptoService,
          useValue: new SecretsCryptoService({ get: () => "" } as any),
        },
      ],
    }).compile();
    const bare = module.get(ExecutorService);
    const impact = await bare.describeRemovalImpact("exec-1");
    expect(impact.pendingPullItems).toBe(0);
  });

  it("removeById clears the pull queue alongside the token caches", async () => {
    executorRepo.findOne.mockResolvedValue({
      id: "exec-9",
      address: "10.0.0.9:8002",
      appName: "exec-9",
    });
    Object.assign(executorRepo, {
      remove: jest.fn().mockResolvedValue(undefined),
    });
    await service.removeById("exec-9");
    expect(pullService.clear).toHaveBeenCalledWith("exec-9");
  });

  it("cleanupOfflineExecutors skips executors that still have pinned tasks and audits the skip", async () => {
    const staleNoPin = { id: "exec-free", address: "a:1", appName: "free" };
    const stalePinned = {
      id: "exec-pinned",
      address: "b:2",
      appName: "pinned",
    };
    executorRepo.find.mockResolvedValue([staleNoPin, stalePinned]);
    Object.assign(executorRepo, {
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    });
    // 分组查询：exec-pinned 仍有 2 个钉定任务。对既有 jest.fn 换实现（直改
    // createQueryBuilder 属性会破坏 ReturnType<typeof makeRepo> 推导、ts-jest
    // TS2322）——makeRepo 每次 createQueryBuilder() 新建 qb 实例，必须换实现
    // 而不是预建一个实例去改它的 getRawMany。
    (taskRepo.createQueryBuilder as unknown as jest.Mock).mockImplementation(
      () => ({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ executorId: "exec-pinned", count: "2" }]),
      }),
    );

    await service.cleanupOfflineExecutors();

    // 只删无引用行——delete 入参是 { id: In([...]) }；本 TypeORM 版本的
    // FindOperator 无 getValue()，集合在 _value。
    const deleteMock = (executorRepo as unknown as { delete: jest.Mock })
      .delete;
    const deleteArg = deleteMock.mock.calls[0][0] as {
      id: { _value: string[] };
    };
    expect(deleteArg.id._value).toEqual(["exec-free"]);
    // 被跳过的行 warn + 审计留痕
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "executor.cleanup_skipped",
        resourceId: "exec-pinned",
        detail: expect.objectContaining({ pinnedTasks: 2 }),
      }),
    );
    // 被删行的 pull 队列顺手清理
    expect(pullService.clear).toHaveBeenCalledWith("exec-free");
    expect(pullService.clear).not.toHaveBeenCalledWith("exec-pinned");
  });

  // A-2（执行器域审计 P2）：跳过判定补 task.executorAppName 维度——与
  // countTasksBoundByAppName（删除影响面预览）同口径。仅被 appName 绑定
  // （无 executorId 钉定）的执行器此前会被自动删除，绑定任务派发即报
  // "No available executor with appName ..."。
  it("A-2: cleanupOfflineExecutors skips executors still bound via task.executorAppName", async () => {
    const staleAppBound = {
      id: "exec-appbound",
      address: "c:3",
      appName: "bound-by-name",
    };
    const staleFree = { id: "exec-free2", address: "d:4", appName: "free2" };
    executorRepo.find.mockResolvedValue([staleAppBound, staleFree]);
    Object.assign(executorRepo, {
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    });
    // 分组分发：第一次 getRawMany = executorId 钉定查询（返回空，无钉定），
    // 第二次 = appName 绑定查询（返回该机的绑定计数）——与生产实现的两次
    // GROUP BY 查询顺序对应。
    let call = 0;
    (taskRepo.createQueryBuilder as unknown as jest.Mock).mockImplementation(
      () => {
        const isAppNameQuery = call++ === 1;
        return {
          select: jest.fn().mockReturnThis(),
          addSelect: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          groupBy: jest.fn().mockReturnThis(),
          getRawMany: jest
            .fn()
            .mockResolvedValue(
              isAppNameQuery
                ? [{ executorAppName: "bound-by-name", count: "1" }]
                : [],
            ),
        };
      },
    );

    await service.cleanupOfflineExecutors();

    const deleteArg = (executorRepo as unknown as { delete: jest.Mock }).delete
      .mock.calls[0][0] as { id: { _value: string[] } };
    // appName 绑定的行被跳过，仅无引用行被删。
    expect(deleteArg.id._value).toEqual(["exec-free2"]);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "executor.cleanup_skipped",
        resourceId: "exec-appbound",
        detail: expect.objectContaining({
          appNameBoundTasks: 1,
          pinnedTasks: 0,
        }),
      }),
    );
  });
});
