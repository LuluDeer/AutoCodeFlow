/**
 * timeout policy 真 PG / 真 Redis 进程内集成（第 3 级）。
 *
 * 验证目标：
 *  - kill_retry：超时终态落库后真 PG 新增一条 PENDING 重试执行行并入队；
 *  - notify_only：超时终态落库但不新增执行行；
 *  - 迟到的重复 timeout 回调命中同一 SETNX 一次性闸，不二次释放广播槽位。
 */
process.env.SELFTEST_SKIP_ENV_FILE = "1";
process.env.DB_PASSWORD ||= "test-db-password";
process.env.JWT_SECRET ||= "test-jwt-secret-0123456789abcdef0123";
process.env.JWT_REFRESH_SECRET ||= "test-jwt-refresh-secret-0123456789ab";
process.env.EXECUTOR_SECRET ||= "test-executor-secret-16";

import { createTestApp } from "./helpers/app.helper";

import { randomBytes, randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { DataSource } from "typeorm";
import { RedisLockService } from "../src/common/services/redis-lock.service";
import { buildTask } from "./factories/task.factory";
import {
  Task,
  TaskStatus,
  ExecuteMode,
} from "../src/modules/task/entities/task.entity";
import {
  TaskExecution,
  ExecutionStatus,
  ExecutionFailureReason,
} from "../src/modules/task/entities/task-execution.entity";
import {
  Executor,
  ExecutorStatus,
  ExecutorType,
} from "../src/modules/executor/entities/executor.entity";
import { TaskService } from "../src/modules/task/task.service";

jest.setTimeout(120_000);

interface Repo<T> {
  save(entity: T): Promise<T>;
  findOne(options: unknown): Promise<T | null>;
  find(options: unknown): Promise<T[]>;
  count(options: unknown): Promise<number>;
  delete(criteria: unknown): Promise<unknown>;
}

interface Fixture {
  task: Task;
  execution: TaskExecution;
  executor: Executor | null;
  address: string;
  slotKey: string | null;
}

const STAMP = process.env.HARDENING_STAMP ?? randomUUID().slice(0, 8);

function makeExecutionRow(
  task: Task,
  id: string,
  address: string | null,
  executorId: string | null,
  broadcast: boolean,
): TaskExecution {
  const exec = new TaskExecution();
  exec.id = id;
  exec.taskId = task.id;
  exec.taskName = task.name;
  exec.status = ExecutionStatus.RUNNING;
  exec.executorAddress = address;
  exec.executorId = executorId;
  exec.logs = null;
  exec.logStorage = "db";
  exec.logObjectKey = null;
  exec.result = {};
  exec.params = {};
  exec.startTime = new Date(Date.now() - 2000);
  exec.endTime = null;
  exec.duration = null;
  exec.retryCount = 0;
  exec.attemptSeq = 1;
  exec.executeMode = broadcast ? "broadcast" : "single";
  exec.isBroadcast = broadcast;
  exec.retryKind = null;
  exec.retryUserCount = null;
  exec.errorMessage = "";
  exec.failureReason = null;
  exec.exitCode = null;
  exec.aiAnalysis = "";
  exec.artifacts = null;
  exec.triggerType = null as unknown as string;
  exec.taskVersion = task.currentVersion;
  exec.traceId = null;
  exec.agentSessionId = null;
  exec.resolvedPackageUrl = null;
  exec.resolvedPackageVersion = null;
  exec.depsFiredAt = null;
  exec.mutexGroupId = null;
  exec.synthetic = false;
  exec.version = 1;
  return exec;
}

describe("timeout policy · kill_retry / notify_only / 重复 timeout 真栈验证", () => {
  let app: INestApplication | undefined;
  let dataSource: DataSource;
  let taskService: TaskService;
  let lockService: RedisLockService;
  let taskRepo: Repo<Task>;
  let execRepo: Repo<TaskExecution>;
  let executorRepo: Repo<Executor>;
  let queueAddSpy: jest.SpyInstance | undefined;
  let setIfAbsentSpy: jest.SpyInstance | undefined;
  const setIfAbsentResults: boolean[] = [];
  const fixtures: Fixture[] = [];
  let seq = 0;

  beforeAll(async () => {
    app = await createTestApp();
    dataSource = app.get(DataSource);
    taskRepo = dataSource.getRepository(Task) as unknown as Repo<Task>;
    execRepo = dataSource.getRepository(
      TaskExecution,
    ) as unknown as Repo<TaskExecution>;
    executorRepo = dataSource.getRepository(
      Executor,
    ) as unknown as Repo<Executor>;
    taskService = app.get(TaskService);
    lockService =
      (taskService as unknown as { redisLockService?: RedisLockService })
        .redisLockService ?? app.get(RedisLockService);

    const taskQueue = (
      taskService as unknown as {
        executorService: {
          taskQueue: { add: (...args: unknown[]) => Promise<unknown> };
        };
      }
    ).executorService.taskQueue;
    queueAddSpy = jest.spyOn(taskQueue, "add").mockResolvedValue({} as never);
  });

  beforeEach(() => {
    queueAddSpy?.mockClear();
    setIfAbsentResults.length = 0;
  });

  afterEach(async () => {
    setIfAbsentSpy?.mockRestore();
    setIfAbsentSpy = undefined;
    for (const f of fixtures) {
      if (f.slotKey)
        await lockService.deleteKey(f.slotKey).catch(() => undefined);
      await execRepo.delete({ taskId: f.task.id });
      await taskRepo.delete({ id: f.task.id });
      if (f.executor) await executorRepo.delete({ id: f.executor.id });
    }
    fixtures.length = 0;
  });

  afterAll(async () => {
    queueAddSpy?.mockRestore();
    if (app) await app.close();
  });

  async function createFixture(opts: {
    timeoutAction: "kill" | "kill_retry" | "notify_only";
    broadcast?: boolean;
  }): Promise<Fixture> {
    seq += 1;
    const broadcast = Boolean(opts.broadcast);
    const taskDraft = buildTask({
      name: `task-timeout-${STAMP}-${seq}`,
      status: TaskStatus.ACTIVE,
      executeMode: broadcast ? ExecuteMode.BROADCAST : ExecuteMode.SINGLE,
      timeout: 60,
      maxRetry: 2,
      retryDelay: 0,
    });
    (taskDraft as unknown as Record<string, unknown>).timeoutAction =
      opts.timeoutAction;
    const task = await taskRepo.save(taskDraft);

    let executor: Executor | null = null;
    let address: string | null = null;
    if (broadcast) {
      address = `10.97.${seq}.${(STAMP.charCodeAt(seq % STAMP.length) % 200) + 1}:9102`;
      executor = await executorRepo.save(
        Object.assign(new Executor(), {
          appName: `timeout-e2e-app-${STAMP}-${seq}`,
          address,
          status: ExecutorStatus.ONLINE,
          type: ExecutorType.NODE,
          deviceFingerprint: randomBytes(32).toString("hex"),
          dispatchMode: "push",
          runningTaskCount: 0,
          broadcastReservedCount: 1,
          maxConcurrentTasks: 8,
          groupName: null,
          tags: null,
          projectId: null,
        }),
      );
    } else {
      address = `10.96.${seq}.${(STAMP.charCodeAt(seq % STAMP.length) % 200) + 1}:9102`;
    }

    const execution = await execRepo.save(
      makeExecutionRow(
        task,
        randomUUID(),
        address,
        executor?.id ?? null,
        broadcast,
      ),
    );
    const fixture: Fixture = {
      task,
      execution,
      executor,
      address,
      slotKey: broadcast ? `slot-release:${execution.id}:${address}` : null,
    };
    fixtures.push(fixture);
    return fixture;
  }

  function timeoutCallback(f: Fixture, attemptSeq = 1) {
    return {
      executionId: f.execution.id,
      status: "failed" as const,
      failureReason: ExecutionFailureReason.TIMEOUT,
      attemptSeq,
      executorAddress: f.address ?? undefined,
      errorMessage: "execution timeout",
    };
  }

  it("① kill_retry：真 PG 产生新 execution 行（并只入队一次）", async () => {
    const f = await createFixture({ timeoutAction: "kill_retry" });
    const before = await execRepo.count({ where: { taskId: f.task.id } });
    expect(before).toBe(1);

    const result = await taskService.handleCallback([
      timeoutCallback(f),
    ] as never[]);
    expect(result[0]?.success).toBe(true);

    const after = await execRepo.count({ where: { taskId: f.task.id } });
    expect(after).toBe(2);

    const rows = await execRepo.find({ where: { taskId: f.task.id } });
    const retry = rows.find((r) => r.id !== f.execution.id);
    expect(retry?.status).toBe(ExecutionStatus.PENDING);
    expect(retry?.triggerType).toBe("timeout_retry");
    expect(retry?.retryCount).toBe(1);

    expect(queueAddSpy).toHaveBeenCalledTimes(1);
    expect(queueAddSpy.mock.calls[0]?.[0]).toBe("execute");

    const terminal = await execRepo.findOne({ where: { id: f.execution.id } });
    expect(terminal?.status).toBe(ExecutionStatus.TIMEOUT);
  });

  it("② notify_only：真 PG 无新 execution 行", async () => {
    const f = await createFixture({ timeoutAction: "notify_only" });

    const result = await taskService.handleCallback([
      timeoutCallback(f),
    ] as never[]);
    expect(result[0]?.success).toBe(true);

    const after = await execRepo.count({ where: { taskId: f.task.id } });
    expect(after).toBe(1);
    expect(queueAddSpy).not.toHaveBeenCalled();

    const terminal = await execRepo.findOne({ where: { id: f.execution.id } });
    expect(terminal?.status).toBe(ExecutionStatus.TIMEOUT);
  });

  it("③ 迟到重复 timeout：SETNX 只首次释放广播槽位", async () => {
    const f = await createFixture({
      timeoutAction: "notify_only",
      broadcast: true,
    });
    const original = lockService.setIfAbsent.bind(lockService);
    setIfAbsentSpy = jest
      .spyOn(lockService, "setIfAbsent")
      .mockImplementation(
        async (key: string, ttlMs: number, value?: string) => {
          const ok = await original(key, ttlMs, value);
          setIfAbsentResults.push(ok);
          return ok;
        },
      );

    const cb = timeoutCallback(f);
    const results = await taskService.handleCallback([
      cb,
      { ...cb },
    ] as never[]);
    expect(results.map((r) => r.success)).toEqual([true, true]);

    expect(setIfAbsentResults).toEqual([true, false]);
    const key = await lockService.getValue(f.slotKey!);
    expect(key).not.toBeNull();

    const executorRow = await executorRepo.findOne({
      where: { id: f.executor!.id },
    });
    expect(executorRow?.broadcastReservedCount).toBe(0);

    const terminal = await execRepo.findOne({ where: { id: f.execution.id } });
    expect(terminal?.status).toBe(ExecutionStatus.TIMEOUT);
  });
});
