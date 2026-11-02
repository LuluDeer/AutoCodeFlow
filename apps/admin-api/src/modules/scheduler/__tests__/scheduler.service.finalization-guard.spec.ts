import { Logger } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { getQueueToken } from "@nestjs/bullmq";
import { DataSource } from "typeorm";
import { ConfigService } from "@nestjs/config";

import { SchedulerService } from "../scheduler.service";
import { SchedulerMetricsService } from "../scheduler-metrics.service";
import { Task } from "../../task/entities/task.entity";
import {
  TaskExecution,
  ExecutionStatus,
  ExecutionFailureReason,
} from "../../task/entities/task-execution.entity";
import { ExecutorService } from "../../executor/executor.service";
import { RedisLockService } from "../../../common/services/redis-lock.service";
import {
  getRuntimeCountersSnapshot,
  resetRuntimeMetrics,
} from "../../metrics/runtime-metrics-entry";
import { RUNTIME_COUNTERS } from "../../metrics/runtime-metrics";

/**
 * S3-C5（P0 · 数据丢失档）：**僵尸执行清扫不得覆盖更新的工作**。
 *
 * ## 本文件测的四件事（对应规格 §6.C5 的验收）
 *
 * ① 旧 run 崩溃（RUNNING、租约过期）+ 新 run 已创建（更新的 createdAt）⇒ 清扫
 *    **不覆盖**新 run：旧行保持 RUNNING 不被置态、不释放槽位、不兑现重试，新 run
 *    的终态/产物逐字节不变，且清扫方留下 warn 日志 + `finalization_deferred` 证据。
 * ② 并发（两个清扫者同时收尾同一条执行 / 清扫与自动重试抢同一条）⇒ **只有一个
 *    winner**，且 `recoveryHistory` 恰好追加一条（`attempt` 恰好 1）。
 * ③ 正常僵尸（无更新 run）仍被清扫——**防空转**：门禁不能把该做的清扫也拦掉。
 * ④ 开关：`STALE_FINALIZATION_GUARD_ENABLED=false` 回到「只记录、不门禁」的形态。
 * ⑤ 监控面：`autoflow_stale_finalization_deferred_total{reason}` 只在**新写入**
 *    一条 deferral 证据时 +1（同一原因+successor 反复被挡不重复计数）——它是
 *    「门禁是否在造成运维积压」的唯一信号，且是告警表达式的分子。
 *
 * ## 测试形态说明（诚实披露）
 *
 * 本文件是**模型级**验证（与仓内既有 scheduler 单测同款：仓储/事务管理器/驱动
 * 全部用替身，不连真库）。内存模型的关键纪律：**判据是否生效取决于生产语句里
 * 是否真的生成了对应谓词文本**——替身用 `whereSql.includes('AS "newer_run"')`
 * 之类的条件决定要不要执行该判据，因此「把判据从 WHERE 里删掉」会让本文件的门禁
 * 用例立刻变红，而不是让模型继续替生产代码兜底。真库语义（PG 的行锁/EPQ 重评估、
 * `jsonb ||` 追加、`ON CONFLICT` 冲突）另外用真 PG 探针独立验证（见报告）。
 */

// ── 内存模型 ────────────────────────────────────────────────────────────────

interface ExecRow {
  id: string;
  taskId: string;
  status: ExecutionStatus;
  createdAt: Date;
  startTime: Date | null;
  executorAddress: string | null;
  executorId: string | null;
  errorMessage?: string | null;
  endTime?: Date | null;
  failureReason?: ExecutionFailureReason | null;
  /** 新 run 的「成果」：门禁用例断言它逐字节不变。 */
  artifacts?: Array<{ name: string; size: number; sha256: string }> | null;
  result?: Record<string, unknown> | null;
}

interface FinalizationRow {
  executionId: string;
  taskId: string;
  attempt: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  controllerBootId: string | null;
  recoveryHistory: Array<Record<string, unknown>>;
}

interface Store {
  executions: ExecRow[];
  finalizations: FinalizationRow[];
}

const OPEN = [
  ExecutionStatus.PENDING,
  ExecutionStatus.RUNNING,
  ExecutionStatus.WAITING,
];

const makeExec = (over: Partial<ExecRow> & { id: string }): ExecRow => ({
  taskId: "task-1",
  status: ExecutionStatus.RUNNING,
  createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
  startTime: new Date(Date.now() - 2 * 60 * 60 * 1000),
  executorAddress: "host:3002",
  executorId: null,
  ...over,
});

/**
 * 条件 UPDATE 的内存模型：把生产语句的 `where`/`params` 存下来，`execute()` 时
 * **按 whereSql 里实际出现的谓词文本**决定执行哪些判据（见文件头「测试形态说明」）。
 */
function makeConditionalQb(store: Store) {
  let setPatch: Record<string, unknown> = {};
  let whereSql = "";
  let params: Record<string, unknown> = {};
  const qb: Record<string, jest.Mock> = {
    update: jest.fn(() => qb),
    set: jest.fn((patch: Record<string, unknown>) => {
      setPatch = patch;
      return qb;
    }),
    where: jest.fn((sql: string, p: Record<string, unknown>) => {
      whereSql = sql;
      params = p;
      return qb;
    }),
    andWhere: jest.fn(() => qb),
    returning: jest.fn(() => qb),
    execute: jest.fn(async () => {
      const ids = (params.ids as string[]) ?? [];
      const gate = (params.gate as string[]) ?? [];
      const guardLease = whereSql.includes('"live_lease"');
      const guardNewer = whereSql.includes('"newer_run"');
      const guardOccupied = whereSql.includes('"open_run"');
      const now = (params.finalizationNow as Date | undefined)?.getTime() ?? 0;
      const winners = ids.filter((id) => {
        const row = store.executions.find((e) => e.id === id);
        if (!row || !gate.includes(row.status)) return false;
        if (
          guardLease &&
          store.finalizations.some(
            (f) =>
              f.executionId === id &&
              f.leaseOwner &&
              f.leaseExpiresAt &&
              f.leaseExpiresAt.getTime() > now &&
              f.leaseOwner !== params.finalizationLeaseOwner,
          )
        ) {
          return false;
        }
        if (
          guardNewer &&
          store.executions.some(
            (n) =>
              n.taskId === row.taskId &&
              n.id !== id &&
              n.createdAt.getTime() >= row.createdAt.getTime(),
          )
        ) {
          return false;
        }
        if (
          guardOccupied &&
          store.executions.some(
            (o) =>
              o.taskId === row.taskId && o.id !== id && OPEN.includes(o.status),
          )
        ) {
          return false;
        }
        return true;
      });
      const saved: Record<string, unknown>[] = [];
      for (const id of winners) {
        const row = store.executions.find((e) => e.id === id)!;
        Object.assign(row, setPatch);
        saved.push({ id, executorAddress: row.executorAddress });
      }
      return { affected: winners.length, raw: saved };
    }),
  };
  return qb;
}

/** 收尾记录 upsert（生产 FINALIZATION_RECORD_SQL）：只为 winner 写。 */
function runRecordUpsert(store: Store, params: unknown[]) {
  const [ids, leaseOwner, leaseExpiresAt, bootId, entryJson] = params as [
    string[],
    string,
    Date,
    string,
    string,
  ];
  const entries = JSON.parse(entryJson) as Array<Record<string, unknown>>;
  for (const id of ids) {
    const exec = store.executions.find((e) => e.id === id);
    if (!exec) continue;
    let row = store.finalizations.find((f) => f.executionId === id);
    if (!row) {
      row = {
        executionId: id,
        taskId: exec.taskId,
        attempt: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        controllerBootId: null,
        recoveryHistory: [],
      };
      store.finalizations.push(row);
    }
    row.attempt += 1;
    row.leaseOwner = leaseOwner;
    row.leaseExpiresAt = leaseExpiresAt;
    row.controllerBootId = bootId;
    row.recoveryHistory = row.recoveryHistory.concat(entries);
  }
  return [ids.map((id) => ({ executionId: id })), ids.length];
}

/** 拒绝收尾证据 upsert（生产 FINALIZATION_DEFERRAL_RECORD_SQL）。 */
function runDeferralUpsert(store: Store, params: unknown[]) {
  const [bootId, entryJson, id, openStatuses, keyJson] = params as [
    string,
    string,
    string,
    string[],
    string,
  ];
  const exec = store.executions.find((e) => e.id === id);
  if (!exec || !openStatuses.includes(exec.status)) return [[], 0];
  const key = JSON.parse(keyJson) as Array<Record<string, unknown>>;
  const contains = (history: Array<Record<string, unknown>>) =>
    key.every((k) =>
      history.some((entry) =>
        Object.entries(k).every(([kk, vv]) => entry[kk] === vv),
      ),
    );
  let row = store.finalizations.find((f) => f.executionId === id);
  if (row && contains(row.recoveryHistory)) return [[], 0];
  if (!row) {
    row = {
      executionId: id,
      taskId: exec.taskId,
      attempt: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      controllerBootId: null,
      recoveryHistory: [],
    };
    store.finalizations.push(row);
  }
  row.controllerBootId = bootId;
  row.recoveryHistory = row.recoveryHistory.concat(JSON.parse(entryJson));
  return [[{ executionId: id }], 1];
}

/** 事务外诊断查询（生产 FINALIZATION_DEFERRAL_DIAGNOSTIC_SQL）。 */
function runDiagnostic(store: Store, params: unknown[]) {
  const [ids, openStatuses] = params as [string[], string[]];
  return ids.map((id) => {
    const exec = store.executions.find((e) => e.id === id)!;
    const fin = store.finalizations.find((f) => f.executionId === id);
    const successor = store.executions
      .filter(
        (n) =>
          n.taskId === exec.taskId &&
          n.id !== id &&
          n.createdAt.getTime() >= exec.createdAt.getTime(),
      )
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() ||
          (a.id < b.id ? -1 : 1),
      )[0];
    return {
      id,
      status: exec.status,
      leaseOwner: fin?.leaseOwner ?? null,
      leaseExpiresAt: fin?.leaseExpiresAt ?? null,
      successorId: successor?.id ?? null,
      taskOccupied: store.executions.some(
        (o) =>
          o.taskId === exec.taskId &&
          o.id !== id &&
          openStatuses.includes(o.status),
      ),
    };
  });
}

// ── 装配 ────────────────────────────────────────────────────────────────────

/** 建过的服务实例：afterEach 统一 onModuleDestroy（清定时器，防句柄泄漏）。 */
const createdServices: SchedulerService[] = [];

interface Harness {
  service: SchedulerService;
  store: Store;
  execRepo: Record<string, jest.Mock>;
  executorService: Record<string, jest.Mock>;
  configService: { get: jest.Mock };
  dataSource: Record<string, jest.Mock>;
  redisLockService: Record<string, jest.Mock>;
}

async function buildHarness(store: Store): Promise<Harness> {
  const execRepo: Record<string, jest.Mock> = {
    find: jest.fn(async (opts: any) => {
      const status = Array.isArray(opts?.where)
        ? opts.where[0]?.status
        : opts?.where?.status;
      if (status !== ExecutionStatus.RUNNING) return [];
      const cutoff =
        (opts?.where?.startTime?.value as Date | undefined) ?? new Date(0);
      return store.executions
        .filter(
          (e) =>
            e.status === ExecutionStatus.RUNNING &&
            (e.startTime ?? e.createdAt).getTime() < cutoff.getTime(),
        )
        .sort(
          (a, b) =>
            (a.startTime ?? a.createdAt).getTime() -
              (b.startTime ?? b.createdAt).getTime() || (a.id < b.id ? -1 : 1),
        )
        .map((e) => ({ ...e }));
    }),
    findOne: jest.fn().mockResolvedValue(null),
    findBy: jest.fn().mockResolvedValue([]),
    save: jest.fn(),
    create: jest.fn((v: unknown) => v),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn(),
  };
  const taskRepo: Record<string, jest.Mock> = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    // 收敛循环需要任务行（timeout/重试预算语义）；timeout 缺省 = 走 STALE_RECOVERED 桶。
    findBy: jest
      .fn()
      .mockResolvedValue([
        { id: "task-1", name: "Test Task", maxRetry: 3, retryDelay: 5 },
      ]),
    save: jest.fn(),
    create: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn(),
  };
  const executorService: Record<string, jest.Mock> = {
    hasRetryBudget: jest.fn().mockReturnValue(true),
    notifyExecutorKill: jest.fn().mockResolvedValue(undefined),
    scheduleRetryAfterRecovery: jest.fn().mockResolvedValue(undefined),
  };
  const redisLockService: Record<string, jest.Mock> = {
    acquireLock: jest.fn().mockResolvedValue({
      key: "scheduler:leader",
      lockId: "leader-lock-id",
      ttlMs: 90000,
      released: false,
      release: jest.fn().mockResolvedValue(true),
    }),
    extendLock: jest.fn().mockResolvedValue(true),
    releaseLock: jest.fn().mockResolvedValue(true),
  };
  const configService = { get: jest.fn() };
  const slotQb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const dataSource: Record<string, jest.Mock> = {
    createQueryBuilder: jest.fn(() => slotQb),
    getRepository: jest.fn(() => ({ find: jest.fn().mockResolvedValue([]) })),
    transaction: jest.fn(async (fn: any) =>
      fn({
        createQueryBuilder: () => makeConditionalQb(store),
        query: jest.fn(async (sql: string, params: unknown[]) => {
          if (sql.includes(", 1, $2, $3, $4,"))
            return runRecordUpsert(store, params);
          throw new Error(
            `unexpected manager.query in test: ${sql.slice(0, 60)}`,
          );
        }),
      }),
    ),
    query: jest.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes(", 0, NULL, NULL,"))
        return runDeferralUpsert(store, params);
      return runDiagnostic(store, params);
    }),
  };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      SchedulerService,
      SchedulerMetricsService,
      { provide: getRepositoryToken(Task), useValue: taskRepo },
      { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
      { provide: getQueueToken("task-queue"), useValue: { add: jest.fn() } },
      { provide: RedisLockService, useValue: redisLockService },
      { provide: DataSource, useValue: dataSource },
      { provide: ExecutorService, useValue: executorService },
      { provide: ConfigService, useValue: configService },
    ],
  }).compile();

  const service = module.get<SchedulerService>(SchedulerService);
  createdServices.push(service);
  // 扫描型 tick 仅 Leader 执行（TASK-006）：本文件全部用例都要求真的跑扫描体。
  await service.initLeaderElection();
  expect(service.getStats().isLeader).toBe(true);
  return {
    service,
    store,
    execRepo,
    executorService,
    configService,
    dataSource,
    redisLockService,
  };
}

const historyOf = (store: Store, executionId: string) =>
  store.finalizations.find((f) => f.executionId === executionId)
    ?.recoveryHistory ?? [];
const finalizationOf = (store: Store, executionId: string) =>
  store.finalizations.find((f) => f.executionId === executionId);

describe("S3-C5: 僵尸执行清扫不得覆盖更新的工作", () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const service of createdServices.splice(0)) service.onModuleDestroy();
    jest.restoreAllMocks();
  });

  it("① 旧 run 崩溃 + 新 run 已创建 ⇒ 清扫不覆盖新 run（no-op + warn + deferred 记录）", async () => {
    const oldRun = makeExec({
      id: "exec-old",
      taskId: "task-1",
      createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      startTime: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    // 新 run：更新的 createdAt，且已经产出成果（终态 + 产物）。
    const newRun = makeExec({
      id: "exec-new",
      taskId: "task-1",
      status: ExecutionStatus.SUCCESS,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      startTime: new Date(Date.now() - 60 * 60 * 1000),
      endTime: new Date(Date.now() - 55 * 60 * 1000),
      artifacts: [{ name: "out.txt", size: 3, sha256: "abc" }],
      result: { version: "v2" },
    });
    const store: Store = { executions: [oldRun, newRun], finalizations: [] };
    const h = await buildHarness(store);

    await h.service.recoverStaleExecutions();

    // 旧行：保持 RUNNING，未被置态（这就是「no-op」）。
    const after = store.executions.find((e) => e.id === "exec-old")!;
    expect(after.status).toBe(ExecutionStatus.RUNNING);
    expect(after.failureReason).toBeUndefined();
    // 新 run 的终态/产物逐字节不变。
    const newAfter = store.executions.find((e) => e.id === "exec-new")!;
    expect(newAfter.status).toBe(ExecutionStatus.SUCCESS);
    expect(newAfter.artifacts).toEqual([
      { name: "out.txt", size: 3, sha256: "abc" },
    ]);
    expect(newAfter.result).toEqual({ version: "v2" });
    // 不兑现重试、不杀执行器进程（否则会用旧快照重跑一遍、覆盖新成果）。
    expect(h.executorService.scheduleRetryAfterRecovery).not.toHaveBeenCalled();
    expect(h.executorService.notifyExecutorKill).not.toHaveBeenCalled();
    // 有日志：warn 里点名原因与 successor 执行 id。
    const warned = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("exec-old"));
    expect(warned.length).toBeGreaterThan(0);
    expect(warned[0]).toContain("newer_execution_exists");
    expect(warned[0]).toContain("exec-new");
    // 有记录：recoveryHistory 恰好一条 deferred 证据，且**没有** stale_finalization。
    const history = historyOf(store, "exec-old");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      kind: "finalization_deferred",
      reason: "newer_execution_exists",
      successorExecutionId: "exec-new",
    });
    // 协调行**没有**租约（deferred 不代表有收尾在进行）。
    expect(finalizationOf(store, "exec-old")).toMatchObject({
      attempt: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  });

  it("①-b 拒绝记录是幂等的：第二个 tick 不重复追加同一条 deferred 证据", async () => {
    const oldRun = makeExec({ id: "exec-old", taskId: "task-1" });
    const newRun = makeExec({
      id: "exec-new",
      taskId: "task-1",
      status: ExecutionStatus.SUCCESS,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      startTime: new Date(Date.now() - 60 * 60 * 1000),
    });
    const store: Store = { executions: [oldRun, newRun], finalizations: [] };
    const h = await buildHarness(store);

    await h.service.recoverStaleExecutions();
    await h.service.recoverStaleExecutions();

    expect(historyOf(store, "exec-old")).toHaveLength(1);
  });

  it("② 并发清扫同一执行 ⇒ 只有一个 winner，recoveryHistory 恰好追加一条", async () => {
    const stale = makeExec({ id: "exec-race", taskId: "task-1" });
    const store: Store = { executions: [stale], finalizations: [] };
    // 两个清扫者（两个实例 / 两个 tick）共享同一份 DB 状态。
    const a = await buildHarness(store);
    const b = await buildHarness(store);

    await Promise.all([
      a.service.recoverStaleExecutions(),
      b.service.recoverStaleExecutions(),
    ]);

    // 只有一个 winner：终态恰好写了一次，且只追加了一条收尾证据 / attempt=1。
    expect(store.executions.find((e) => e.id === "exec-race")!.status).toBe(
      ExecutionStatus.FAILED,
    );
    const fin = finalizationOf(store, "exec-race")!;
    expect(fin.attempt).toBe(1);
    expect(
      fin.recoveryHistory.filter((e) => e.kind === "stale_finalization"),
    ).toHaveLength(1);
    // 输家既不重复追加记录，也不重复兑现重试。
    const retryCalls =
      (a.executorService.scheduleRetryAfterRecovery as jest.Mock).mock.calls
        .length +
      (b.executorService.scheduleRetryAfterRecovery as jest.Mock).mock.calls
        .length;
    expect(retryCalls).toBe(1);
  });

  it("②-b 清扫与自动重试并发（自动重试先写终态）⇒ 清扫 no-op，不重复追加记录", async () => {
    const stale = makeExec({ id: "exec-race", taskId: "task-1" });
    const store: Store = { executions: [stale], finalizations: [] };
    const h = await buildHarness(store);

    // 自动重试/回调先赢得这条执行的终态（模拟并发中的另一方）。
    const { transitionOneToTerminal } =
      await import("../../task/execution-terminal");
    const result = await transitionOneToTerminal(
      { createQueryBuilder: () => makeConditionalQb(store) } as never,
      { id: "exec-race", patch: { status: ExecutionStatus.SUCCESS } },
    );
    expect(result.rows).toHaveLength(1);

    await h.service.recoverStaleExecutions();

    // 清扫方 no-op：终态仍是 success，且**没有**任何收尾记录被追加。
    expect(store.executions.find((e) => e.id === "exec-race")!.status).toBe(
      ExecutionStatus.SUCCESS,
    );
    expect(store.finalizations).toHaveLength(0);
    expect(h.executorService.scheduleRetryAfterRecovery).not.toHaveBeenCalled();
  });

  it("③ 防空转：正常僵尸（无更新 run、无占用）仍被清扫", async () => {
    const stale = makeExec({ id: "exec-zombie", taskId: "task-1" });
    const store: Store = { executions: [stale], finalizations: [] };
    const h = await buildHarness(store);

    await h.service.recoverStaleExecutions();

    const after = store.executions.find((e) => e.id === "exec-zombie")!;
    expect(after.status).toBe(ExecutionStatus.FAILED);
    expect(after.failureReason).toBe(ExecutionFailureReason.STALE_RECOVERED);
    // 收尾记录：attempt=1 + 恰好一条 stale_finalization 证据（没有 deferred）。
    const fin = finalizationOf(store, "exec-zombie")!;
    expect(fin.attempt).toBe(1);
    expect(fin.leaseOwner).toEqual(expect.any(String));
    expect(fin.leaseExpiresAt).toBeInstanceOf(Date);
    expect(fin.controllerBootId).toMatch(/^[0-9a-f]{24}$/);
    expect(fin.recoveryHistory).toHaveLength(1);
    expect(fin.recoveryHistory[0]).toMatchObject({
      kind: "stale_finalization",
      outcome: "stale_recovered",
    });
    // 且正常兑现重试（既有行为不变）。
    expect(h.executorService.scheduleRetryAfterRecovery).toHaveBeenCalledTimes(
      1,
    );
  });

  it("④ 开关关闭：回到「只记录、不门禁」（收尾记录仍写，判据不拦）", async () => {
    const oldRun = makeExec({ id: "exec-old", taskId: "task-1" });
    const newRun = makeExec({
      id: "exec-new",
      taskId: "task-1",
      status: ExecutionStatus.SUCCESS,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      startTime: new Date(Date.now() - 60 * 60 * 1000),
    });
    const store: Store = { executions: [oldRun, newRun], finalizations: [] };
    const h = await buildHarness(store);
    h.configService.get.mockImplementation((key: string) =>
      key === "STALE_FINALIZATION_GUARD_ENABLED" ? false : undefined,
    );

    await h.service.recoverStaleExecutions();

    // 门禁关闭 ⇒ 旧行恢复为 FAILED（引入前行为），但收尾记录照写（审计链不断）。
    expect(store.executions.find((e) => e.id === "exec-old")!.status).toBe(
      ExecutionStatus.FAILED,
    );
    const fin = finalizationOf(store, "exec-old")!;
    expect(fin.attempt).toBe(1);
    expect(fin.recoveryHistory).toHaveLength(1);
    expect(fin.recoveryHistory[0]).toMatchObject({
      kind: "stale_finalization",
    });
    expect(h.executorService.scheduleRetryAfterRecovery).toHaveBeenCalledTimes(
      1,
    );
  });

  it("⑤ 门禁只读谓词在 WHERE 里（不是先读后写）：SQL 文本含全部四条判据", async () => {
    const stale = makeExec({ id: "exec-sql", taskId: "task-1" });
    const store: Store = { executions: [stale], finalizations: [] };
    const h = await buildHarness(store);
    let captured: { sql: string; params: Record<string, unknown> } | null =
      null;
    h.dataSource.transaction.mockImplementation(async (fn: any) =>
      fn({
        createQueryBuilder: () => {
          const qb = makeConditionalQb(store);
          const originalWhere = qb.where as jest.Mock;
          qb.where = jest.fn((sql: string, params: Record<string, unknown>) => {
            captured = { sql, params };
            return originalWhere(sql, params);
          }) as never;
          return qb;
        },
        query: jest.fn(async (sql: string, params: unknown[]) => {
          if (sql.includes(", 1, $2, $3, $4,"))
            return runRecordUpsert(store, params);
          throw new Error("unexpected");
        }),
      }),
    );

    await h.service.recoverStaleExecutions();

    const sql = captured!.sql;
    expect(sql).toContain('"id" IN (:...ids) AND "status" IN (:...gate)');
    expect(sql).toContain('FROM "execution_finalizations" AS "live_lease"');
    expect(sql).toContain('"live_lease"."leaseExpiresAt" > :finalizationNow');
    expect(sql).toContain(
      '"live_lease"."leaseOwner" <> :finalizationLeaseOwner',
    );
    expect(sql).toContain('FROM "task_executions" AS "newer_run"');
    expect(sql).toContain(
      '"newer_run"."createdAt" >= "task_executions"."createdAt"',
    );
    expect(sql).toContain('FROM "task_executions" AS "open_run"');
    expect(sql).toContain('"open_run"."status" IN (:...openStatuses)');
    expect(captured!.params.openStatuses).toEqual(OPEN);
  });

  it("⑤-b 门禁关闭时 SQL 里**没有** G-NEWER/G-OCCUPIED（开关真的改变谓词，非恒真）", async () => {
    const stale = makeExec({ id: "exec-sql", taskId: "task-1" });
    const store: Store = { executions: [stale], finalizations: [] };
    const h = await buildHarness(store);
    h.configService.get.mockImplementation((key: string) =>
      key === "STALE_FINALIZATION_GUARD_ENABLED" ? "false" : undefined,
    );
    let captured: string | null = null;
    h.dataSource.transaction.mockImplementation(async (fn: any) =>
      fn({
        createQueryBuilder: () => {
          const qb = makeConditionalQb(store);
          qb.where = jest.fn((sql: string) => {
            captured = sql;
            return qb;
          }) as never;
          return qb;
        },
        query: jest.fn(async (sql: string, params: unknown[]) =>
          sql.includes(", 1, $2, $3, $4,")
            ? runRecordUpsert(store, params)
            : [[]],
        ),
      }),
    );

    await h.service.recoverStaleExecutions();

    // G-LEASE 仍在（它不属于「更新工作」判据），G-NEWER/G-OCCUPIED 消失。
    expect(captured!).toContain('AS "live_lease"');
    expect(captured!).not.toContain('AS "newer_run"');
    expect(captured!).not.toContain('AS "open_run"');
  });

  it("⑥ 监控面：deferral 计数只在**新**证据写入时 +1，标签取自指标字典登记面", async () => {
    resetRuntimeMetrics();
    const oldRun = makeExec({ id: "exec-old", taskId: "task-1" });
    const newRun = makeExec({
      id: "exec-new",
      taskId: "task-1",
      status: ExecutionStatus.SUCCESS,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      startTime: new Date(Date.now() - 60 * 60 * 1000),
    });
    const store: Store = { executions: [oldRun, newRun], finalizations: [] };
    const h = await buildHarness(store);

    await h.service.recoverStaleExecutions();

    const reason = historyOf(store, "exec-old")[0].reason as string;
    // ① 生产写入的 reason 必须落在指标字典登记面里（防「加了分支没登记标签」）。
    const registered =
      RUNTIME_COUNTERS.autoflow_stale_finalization_deferred_total.labelValueSets.map(
        (s) => s.reason,
      );
    expect(registered).toContain(reason);
    // ② 新证据 ⇒ 计数恰好 +1（告警分子）。
    expect(
      getRuntimeCountersSnapshot()
        .get("autoflow_stale_finalization_deferred_total")
        ?.get(JSON.stringify({ reason })),
    ).toBe(1);

    // ③ 第二个 tick 是同一（reason+successor）的重复拒绝 ⇒ 不重复计数：
    // `increase(...[1h]) > 0` 因此表达「新出现的积压」而不是「积压还在」。
    await h.service.recoverStaleExecutions();
    expect(
      getRuntimeCountersSnapshot()
        .get("autoflow_stale_finalization_deferred_total")
        ?.get(JSON.stringify({ reason })),
    ).toBe(1);
    expect(historyOf(store, "exec-old")).toHaveLength(1);
  });
});
