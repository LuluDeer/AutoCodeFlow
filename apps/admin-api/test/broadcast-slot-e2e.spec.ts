/**
 * 广播槽位真 Redis 进程内集成（第 3 级）。
 *
 * 验证目标：
 *  - winner + duplicate 两次终态回调共享同一 SETNX 一次性闸；
 *  - 真 Redis 上首次 SETNX 生效、第二次被拦；
 *  - 真 PG 上 broadcastReservedCount 从 1 归零；
 *  - 任务在途改成 single 后，回调仍按执行行的 broadcast 快照释放槽位。
 */
process.env.SELFTEST_SKIP_ENV_FILE = "1";

// 与 scripts/verify-hardening-realstack.sh 同一夹具口径：连接参数优先取调用方
// 已注入的 env，其次取仓库根 .env（由该脚本的 read_env 读取），最后才用夹具默认值。
// SELFTEST_SKIP_ENV_FILE=1 只禁止 AppModule 自己加载 .env；这里显式读取连接字段，
// 避免把进程推回 configuration.ts 的 postgres/postgres 死默认值。

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FIXTURE_ENV_FILE = resolve(__dirname, "../../../.env");
function fixtureEnvValue(key: string): string | undefined {
  const injected = process.env[key];
  // setup-env-file.ts 只为满足 Joi 放了一个占位 DB_PASSWORD；真栈连接的口令
  // 必须来自调用方显式注入或仓库夹具 .env，不能把这个占位值当成真实凭据。
  const placeholder = key === "DB_PASSWORD" ? "test-db-password" : undefined;
  if (injected && injected !== placeholder) return injected;
  try {
    const text = readFileSync(FIXTURE_ENV_FILE, "utf8");
    const match = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(.*)$`, "m").exec(
      text,
    );
    if (!match) return undefined;
    const raw = match[1].trim();
    const quoted = /^(['"])(.*)\1$/.exec(raw);
    return (quoted ? quoted[2] : raw) || undefined;
  } catch {
    return undefined;
  }
}
function applyFixtureEnv(key: string, fallback?: string): void {
  const value = fixtureEnvValue(key) ?? fallback;
  const stalePlaceholder =
    key === "DB_PASSWORD" && process.env[key] === "test-db-password";
  if (value !== undefined && (!process.env[key] || stalePlaceholder)) {
    process.env[key] = value;
  }
}

applyFixtureEnv("DB_HOST", "127.0.0.1");
applyFixtureEnv("DB_PORT", "5432");
applyFixtureEnv("DB_USERNAME", "autoflow");
applyFixtureEnv("DB_PASSWORD", "test-db-password");
// DB_DATABASE 刻意不取 .env 的部署库名：真栈夹具由 HARDENING_DB_NAME 指定
// throwaway 库；裸跑时回落到既有测试库 autoflow_test。 caller 显式给的值优先。
process.env.DB_DATABASE ||= process.env.HARDENING_DB_NAME || "autoflow_test";
applyFixtureEnv("REDIS_HOST", "127.0.0.1");
applyFixtureEnv("REDIS_PORT", "6379");
applyFixtureEnv("REDIS_DB", "0");
applyFixtureEnv("REDIS_PASSWORD");
process.env.JWT_SECRET ||= "test-jwt-secret-0123456789abcdef0123";
process.env.JWT_REFRESH_SECRET ||= "test-jwt-refresh-secret-0123456789ab";
process.env.EXECUTOR_SECRET ||= "test-executor-secret-16";

import { randomBytes, randomUUID } from "node:crypto";
import { createTestApp } from "./helpers/app.helper";
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
  update(criteria: unknown, patch: unknown): Promise<unknown>;
  delete(criteria: unknown): Promise<unknown>;
}

const STAMP = process.env.HARDENING_STAMP ?? randomUUID().slice(0, 8);
const ADDR = `10.98.${STAMP.length % 200}.${(STAMP.charCodeAt(1) % 200) + 1}:8902`;

function makeExecutionRow(
  task: Task,
  executor: Executor,
  id: string,
): TaskExecution {
  const exec = new TaskExecution();
  exec.id = id;
  exec.taskId = task.id;
  exec.taskName = task.name;
  exec.status = ExecutionStatus.RUNNING;
  exec.executorAddress = null;
  exec.executorId = executor.id;
  exec.logs = null;
  exec.logStorage = "db";
  exec.logObjectKey = null;
  exec.result = {};
  exec.params = {};
  exec.startTime = new Date(Date.now() - 1000);
  exec.endTime = null;
  exec.duration = null;
  exec.retryCount = 0;
  exec.attemptSeq = 1;
  exec.executeMode = "broadcast";
  exec.isBroadcast = true;
  exec.retryKind = null;
  exec.retryUserCount = null;
  exec.errorMessage = "";
  exec.failureReason = null;
  exec.exitCode = null;
  exec.aiAnalysis = "";
  exec.artifacts = null;
  exec.triggerType = "manual";
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

describe("broadcast slot · 真 Redis SETNX 一次性释放", () => {
  let app: INestApplication | undefined;
  let dataSource: DataSource;
  let taskService: TaskService;
  let lockService: RedisLockService;
  let taskRepo: Repo<Task>;
  let execRepo: Repo<TaskExecution>;
  let executorRepo: Repo<Executor>;
  let task: Task | undefined;
  let executor: Executor | undefined;
  let executionId = "";
  let slotKey = "";
  let setIfAbsentSpy: jest.SpyInstance | undefined;
  const setIfAbsentResults: boolean[] = [];

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

    task = await taskRepo.save(
      buildTask({
        name: `task-broadcast-slot-${STAMP}`,
        status: TaskStatus.ACTIVE,
        executeMode: ExecuteMode.BROADCAST,
      }),
    );
    executor = await executorRepo.save(
      Object.assign(new Executor(), {
        appName: `slot-e2e-app-${STAMP}`,
        address: ADDR,
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
    executionId = randomUUID();
    slotKey = `slot-release:${executionId}:${ADDR}`;
    await execRepo.save(makeExecutionRow(task, executor, executionId));

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
  });

  afterAll(async () => {
    setIfAbsentSpy?.mockRestore();
    if (lockService)
      await lockService.deleteKey(slotKey).catch(() => undefined);
    if (dataSource && task) {
      await execRepo.delete({ taskId: task.id });
      await taskRepo.delete({ id: task.id });
    }
    if (dataSource && executor) await executorRepo.delete({ id: executor.id });
    if (app) await app.close();
  });

  it("winner + duplicate：SETNX 只首次生效，broadcastReservedCount 归零，且按执行快照释放", async () => {
    // 任务在途改成 single；执行行仍持有 claim 时的 broadcast 快照。
    await taskRepo.update(
      { id: task!.id },
      { executeMode: ExecuteMode.SINGLE },
    );

    const callback = {
      executionId,
      status: "success" as const,
      attemptSeq: 1,
      executorAddress: ADDR,
    };
    const results = await taskService.handleCallback([
      callback,
      { ...callback },
    ] as never[]);
    expect(results.map((r) => r.success)).toEqual([true, true]);

    expect(setIfAbsentSpy).toHaveBeenCalledTimes(2);
    expect(setIfAbsentSpy).toHaveBeenNthCalledWith(1, slotKey, 10 * 60_000);
    expect(setIfAbsentSpy).toHaveBeenNthCalledWith(2, slotKey, 10 * 60_000);
    expect(setIfAbsentResults).toEqual([true, false]);

    const key = await lockService.getValue(slotKey);
    expect(key).not.toBeNull();

    const executorRow = await executorRepo.findOne({
      where: { id: executor!.id },
    });
    expect(executorRow?.broadcastReservedCount).toBe(0);

    const taskRow = await taskRepo.findOne({ where: { id: task!.id } });
    expect(taskRow?.executeMode).toBe(ExecuteMode.SINGLE);
    const execRow = await execRepo.findOne({ where: { id: executionId } });
    expect(execRow?.executeMode).toBe("broadcast");
    expect(execRow?.isBroadcast).toBe(true);
    expect(execRow?.status).toBe(ExecutionStatus.SUCCESS);
  });
});
