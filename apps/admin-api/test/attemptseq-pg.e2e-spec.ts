/**
 * attemptSeq 真 PG / 真 Redis 进程内集成（第 3 级）。
 *
 * 验证目标：
 *  - 真 PG 上两个并发 claim 各自把 attemptSeq 原子自增到 1；
 *  - 同一执行行重新开回合后再次 claim，attemptSeq 1 → 2；
 *  - 旧世代（#1）终态回调被 DB 世代谓词拒绝，不写终态；
 *  - 当前世代（#2）终态回调命中并落 SUCCESS。
 *
 * 传输层用 jest.spyOn 顶掉 dispatch（真 Nest + 真仓储 + 假传输），持久化、
 * 行锁与世代谓词全部由真 PG 求值。
 */
process.env.SELFTEST_SKIP_ENV_FILE = "1";
process.env.DB_PASSWORD ||= "test-db-password";
process.env.JWT_SECRET ||= "test-jwt-secret-0123456789abcdef0123";
process.env.JWT_REFRESH_SECRET ||= "test-jwt-refresh-secret-0123456789ab";
process.env.EXECUTOR_SECRET ||= "test-executor-secret-16";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createTestApp } = require("./helpers/app.helper") as typeof import("./helpers/app.helper");

import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { DataSource } from "typeorm";
import { buildTask } from "./factories/task.factory";
import { Task, TaskStatus, ExecuteMode } from "../src/modules/task/entities/task.entity";
import {
  TaskExecution,
  ExecutionStatus,
} from "../src/modules/task/entities/task-execution.entity";
import {
  ExecutorService,
} from "../src/modules/executor/executor.service";
import { TaskProcessor } from "../src/modules/task/task.processor";
import { TaskService } from "../src/modules/task/task.service";

jest.setTimeout(120_000);

const STAMP = process.env.HARDENING_STAMP ?? randomUUID().slice(0, 8);
const ADDR = `10.99.${STAMP.length % 200}.${(STAMP.charCodeAt(0) % 200) + 1}:8802`;

function makeExecutionRow(task: Task, id: string, status: ExecutionStatus): TaskExecution {
  const exec = new TaskExecution();
  exec.id = id;
  exec.taskId = task.id;
  exec.taskName = task.name;
  exec.status = status;
  exec.executorAddress = null;
  exec.executorId = null;
  exec.logs = null;
  exec.logStorage = "db";
  exec.logObjectKey = null;
  exec.result = {};
  exec.params = {};
  exec.startTime = null;
  exec.endTime = null;
  exec.duration = null;
  exec.retryCount = 0;
  exec.attemptSeq = 0;
  exec.executeMode = null;
  exec.isBroadcast = null;
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

describe("attemptSeq · 真 PG 并发 claim 与世代门禁", () => {
  let app: INestApplication | undefined;
  let dataSource: DataSource;
  let taskRepo: Repo<Task>;
  let execRepo: Repo<TaskExecution>;
  let processor: TaskProcessor;
  let taskService: TaskService;
  let task: Task | undefined;
  let execAId = "";
  let execBId = "";
  let dispatchSpy: jest.SpyInstance | undefined;

  interface Repo<T> {
  save(entity: T): Promise<T>;
  findOne(options: unknown): Promise<T | null>;
  update(criteria: unknown, patch: unknown): Promise<unknown>;
  delete(criteria: unknown): Promise<unknown>;
}

  beforeAll(async () => {
    app = await createTestApp();
    dataSource = app.get(DataSource);
    taskRepo = dataSource.getRepository(Task) as unknown as Repo<Task>;
    execRepo = dataSource.getRepository(TaskExecution) as unknown as Repo<TaskExecution>;
    processor = app.get(TaskProcessor);
    taskService = app.get(TaskService);

    dispatchSpy = jest
      .spyOn(app.get(ExecutorService), "dispatch")
      .mockResolvedValue({ status: "accepted" } as never);

    task = await taskRepo.save(
      buildTask({
        name: `task-attemptseq-${STAMP}`,
        status: TaskStatus.ACTIVE,
        executeMode: ExecuteMode.SINGLE,
        timeout: 300,
        maxRetry: 0,
      }),
    );

    execAId = randomUUID();
    execBId = randomUUID();
    await execRepo.save(makeExecutionRow(task, execAId, ExecutionStatus.PENDING));
    await execRepo.save(makeExecutionRow(task, execBId, ExecutionStatus.PENDING));
  });

  afterAll(async () => {
    dispatchSpy?.mockRestore();
    if (dataSource && task) {
      await execRepo.delete({ taskId: task.id });
      await taskRepo.delete({ id: task.id });
    }
    if (app) await app.close();
  });

  it("① 真 PG 并发两次 claim：各自原子自增到 attemptSeq=1", async () => {
    const [a, b] = await Promise.all([
      processor.handle({ data: { executionId: execAId } } as never),
      processor.handle({ data: { executionId: execBId } } as never),
    ]);
    void a;
    void b;

    const rowA = await execRepo.findOne({ where: { id: execAId } });
    const rowB = await execRepo.findOne({ where: { id: execBId } });
    expect(rowA?.attemptSeq).toBe(1);
    expect(rowB?.attemptSeq).toBe(1);
    expect(rowA?.status).toBe(ExecutionStatus.RUNNING);
    expect(rowB?.status).toBe(ExecutionStatus.RUNNING);
  });

  it("② 同一行重新 claim：并发两次仅一个 winner，attemptSeq 从 1 递增到 2", async () => {
    await execRepo.update({ id: execAId }, { status: ExecutionStatus.FAILED });
    const before = await execRepo.findOne({ where: { id: execAId } });
    expect(before?.attemptSeq).toBe(1);

    const dispatchBefore = dispatchSpy?.mock.calls.length ?? 0;
    await Promise.all([
      processor.handle({ data: { executionId: execAId } } as never),
      processor.handle({ data: { executionId: execAId } } as never),
    ]);
    expect((dispatchSpy?.mock.calls.length ?? 0) - dispatchBefore).toBe(1);

    const after = await execRepo.findOne({ where: { id: execAId } });
    expect(after?.attemptSeq).toBe(2);
    expect(after?.status).toBe(ExecutionStatus.RUNNING);
  });

  it("③ 旧世代回调不写终态，当前世代回调命中", async () => {
    const stale = await taskService.handleCallback([
      {
        executionId: execAId,
        status: "success",
        attemptSeq: 1,
        executorAddress: ADDR,
      } as never,
    ]);
    expect(stale[0]?.success).toBe(true);

    const afterStale = await execRepo.findOne({ where: { id: execAId } });
    expect(afterStale?.status).toBe(ExecutionStatus.RUNNING);
    expect(afterStale?.endTime).toBeNull();

    const current = await taskService.handleCallback([
      {
        executionId: execAId,
        status: "success",
        attemptSeq: 2,
        executorAddress: ADDR,
      } as never,
    ]);
    expect(current[0]?.success).toBe(true);

    const afterCurrent = await execRepo.findOne({ where: { id: execAId } });
    expect(afterCurrent?.status).toBe(ExecutionStatus.SUCCESS);
    expect(afterCurrent?.endTime).toBeInstanceOf(Date);
  });
});
