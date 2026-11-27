/**
 * attemptSeq 真 admin HTTP + 真 executor-node 进程端到端闭环（目标第 3/4 级）。
 *
 * 与 attemptseq-pg.e2e-spec.ts 的区别：这里不再 spy 掉 dispatch、不再用假传输层。
 *   · admin-api 以 Nest 应用监听真实端口（回调经 HTTP 进入）；
 *   · executor-node 以独立 Node 子进程挂载产品 executeRouter / verifyToken /
 *     callback 线程，dispatch payload 由 admin 真 HTTP POST 到它；
 *   · 执行器终态回调经真 HTTP 回到 admin，admin 用回调 attemptSeq 写终态；
 *   · 第二次 claim 后，用旧世代的迟到 HTTP 回调打 admin，断言库行不被污染。
 *
 * 本 spec 必须由 scripts/verify-attemptseq-http.sh 启动：throwaway DB / stamp
 * 前缀 Redis 键 / 子进程 pid 文件的清理都由该脚本 trap 负责。
 */
process.env.SELFTEST_SKIP_ENV_FILE = "1";
process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK = "true";
process.env.DB_PASSWORD ||= "test-db-password";
process.env.JWT_SECRET ||= "test-jwt-secret-0123456789abcdef0123";
process.env.JWT_REFRESH_SECRET ||= "test-jwt-refresh-secret-0123456789ab";
process.env.EXECUTOR_SECRET ||= "test-executor-secret-16";

if (!(process.env.DB_DATABASE ?? "").startsWith("autoflow_attemptseq_http_")) {
  throw new Error(
    `attemptseq-http e2e requires throwaway DB_DATABASE=autoflow_attemptseq_http_*; got ${process.env.DB_DATABASE ?? "(unset)"}`,
  );
}

import { randomBytes, randomUUID } from "node:crypto";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { AddressInfo, createServer } from "node:net";
import { networkInterfaces } from "node:os";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import request from "supertest";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as bcrypt from "bcrypt";
import Redis from "ioredis";
import { DataSource } from "typeorm";
import { AppModule } from "../src/app.module";
import {
  Task,
  TaskCodeSource,
  TaskRuntime,
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
import { ExecutorService } from "../src/modules/executor/executor.service";
import { TaskProcessor } from "../src/modules/task/task.processor";
import { buildTask } from "./factories/task.factory";

jest.setTimeout(180_000);

const STAMP = process.env.ATTEMPTSEQ_HTTP_STAMP ?? randomUUID().slice(0, 8);
const SHARED_TOKEN = process.env.EXECUTOR_SECRET || "test-executor-secret-16";
const TMP_ROOT =
  process.env.ATTEMPTSEQ_HTTP_TMP || path.join("/tmp/opencode", `attemptseq-http-${STAMP}`);
const FIXTURE = path.resolve(
  __dirname,
  "../../executor-node/src/attemptseq-http-fixture.spec.ts",
);
const EXECUTOR_CWD = path.resolve(__dirname, "../../executor-node");

interface Repo<T> {
  create(entity: Partial<T>): T;
  save(entity: T): Promise<T>;
  findOne(options: unknown): Promise<T | null>;
  update(criteria: unknown, patch: unknown): Promise<unknown>;
  delete(criteria: unknown): Promise<unknown>;
}

interface DispatchObservation {
  executionId: string | null;
  attemptSeq: number | null;
  bodyKeys: string[];
  taskName: string | null;
}

interface ChildHarness {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<{ port: number; address: string; pid: number }>;
  observed: DispatchObservation[];
  output(): string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  label: string,
  probe: () => Promise<T | null> | T | null,
  timeoutMs = 60_000,
  intervalMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== null && value !== undefined) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "");
  throw new Error(`timeout waiting for ${label} within ${timeoutMs}ms; last=${detail}`);
}

function pickNonInternalIPv4(): string {
  const candidates: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === "IPv4" && !iface.internal) candidates.push(iface.address);
    }
  }
  if (candidates.length === 0) {
    throw new Error("no non-internal IPv4 found; push dispatch SSRF guard requires a routable host address");
  }
  // 优先 RFC1918（ EXECUTOR_ALLOW_PRIVATE_NETWORK=true 已由脚本设置），否则公网地址也可。
  return (
    candidates.find((ip) =>
      /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(ip),
    ) ?? candidates[0]
  );
}

async function pickFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  return port;
}

async function createCapturingApp(callbackBodies: unknown[]): Promise<INestApplication> {
  const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleFixture.createNestApplication();
  // 对齐生产 src/main.ts：执行器只认识 /api/executions/callback。
  app.setGlobalPrefix("api");

  app.use(
    express.json({
      limit: "1mb",
      verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = Buffer.from(buf);
      },
    }),
  );
  // 在 Nest 路由与全局 ValidationPipe 之前捕获原始 callback body：
  // 断言的是执行器经 HTTP 真正发出来的字节形态，不是 DTO 变换后的副本。
  app.use((req, res, next) => {
    if (req.method === "POST" && req.path === "/api/executions/callback") {
      const body = JSON.parse(JSON.stringify(req.body ?? []));
      callbackBodies.push(body);
      res.on("finish", () => {
        // eslint-disable-next-line no-console
        console.log(
          `[attemptseq-http] callback HTTP status=${res.statusCode} body=${JSON.stringify(body)}`,
        );
      });
    }
    next();
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.listen(0);
  return app;
}

function startExecutorChild(env: NodeJS.ProcessEnv): ChildHarness {
  const child = spawn(
    process.execPath,
    ["-r", require.resolve("ts-node/register/transpile-only"), FIXTURE],
    { cwd: EXECUTOR_CWD, env, stdio: ["ignore", "pipe", "pipe"] },
  );

  let stdoutLog = "";
  let stderrLog = "";
  let buffer = "";
  let readySettled = false;
  let resolveReady!: (value: { port: number; address: string; pid: number }) => void;
  let rejectReady!: (err: Error) => void;
  const ready = new Promise<{ port: number; address: string; pid: number }>(
    (resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    },
  );
  const observed: DispatchObservation[] = [];

  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stdoutLog += text;
    buffer += text;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.startsWith("EXECUTOR_READY ")) {
        const parts = line.split(" ");
        if (!readySettled) {
          readySettled = true;
          resolveReady({
            port: Number(parts[1]),
            address: parts[2],
            pid: Number(parts[3]),
          });
        }
      } else if (line.startsWith("DISPATCH_OBSERVED ")) {
        observed.push(JSON.parse(line.slice("DISPATCH_OBSERVED ".length)) as DispatchObservation);
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrLog += chunk.toString();
  });
  child.on("exit", (code, signal) => {
    if (!readySettled) {
      readySettled = true;
      rejectReady(
        new Error(
          `executor child exited before READY (code=${code}, signal=${signal}); stderr=${stderrLog}`,
        ),
      );
    }
  });

  return {
    child,
    ready,
    observed,
    output: () => `[stdout]\n${stdoutLog}\n[stderr]\n${stderrLog}`,
  };
}

function makeExecutionRow(task: Task, id: string): TaskExecution {
  const exec = new TaskExecution();
  exec.id = id;
  exec.taskId = task.id;
  exec.taskName = task.name;
  exec.status = ExecutionStatus.PENDING;
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

describe("attemptSeq · 真 admin HTTP + 真 executor-node 进程闭环", () => {
  let app: INestApplication | undefined;
  let dataSource: DataSource | undefined;
  let taskRepo: Repo<Task>;
  let execRepo: Repo<TaskExecution>;
  let executorRepo: Repo<Executor>;
  let processor: TaskProcessor;
  let executorService: ExecutorService;
  let child: ChildHarness | undefined;
  let redis: Redis | undefined;
  let dispatchSpy: jest.SpyInstance | undefined;

  const callbackBodies: unknown[] = [];
  let task: Task | undefined;
  let executorRow: Executor | undefined;
  let executionId = "";
  let executorAddress = "";
  let adminBaseUrl = "";

  beforeAll(async () => {
    fs.mkdirSync(path.join(TMP_ROOT, "work"), { recursive: true });
    fs.mkdirSync(path.join(TMP_ROOT, "callbacks"), { recursive: true });

    app = await createCapturingApp(callbackBodies);
    dataSource = app.get(DataSource);
    taskRepo = dataSource.getRepository(Task) as unknown as Repo<Task>;
    execRepo = dataSource.getRepository(TaskExecution) as unknown as Repo<TaskExecution>;
    executorRepo = dataSource.getRepository(Executor) as unknown as Repo<Executor>;
    processor = app.get(TaskProcessor);
    executorService = app.get(ExecutorService);

    const adminPort = (app.getHttpServer().address() as AddressInfo).port;
    adminBaseUrl = `http://127.0.0.1:${adminPort}`;
    const execPort = await pickFreePort();
    const hostIp = pickNonInternalIPv4();
    executorAddress = `${hostIp}:${execPort}`;

    child = startExecutorChild({
      ...process.env,
      NODE_ENV: "test",
      SELFTEST_SKIP_ENV_FILE: "1",
      TS_NODE_TRANSPILE_ONLY: "true",
      ADMIN_API_URL: adminBaseUrl,
      ADMIN_API_URL_INTERNAL: adminBaseUrl,
      EXECUTOR_SHARED_TOKEN: SHARED_TOKEN,
      EXECUTOR_SECRET: SHARED_TOKEN,
      EXECUTOR_ADDRESS: executorAddress,
      EXECUTOR_ADDRESS_PUBLIC: executorAddress,
      EXECUTOR_ALLOW_NO_TOKEN: "false",
      ATTEMPTSEQ_HTTP_EXEC_PORT: String(execPort),
      ATTEMPTSEQ_HTTP_BIND: "0.0.0.0",
      WORK_DIR: path.join(TMP_ROOT, "work"),
    });
    const ready = await child.ready;
    expect(ready.port).toBe(execPort);
    expect(ready.address).toBe(executorAddress);
    fs.writeFileSync(path.join(TMP_ROOT, "executor.pid"), String(ready.pid));

    const fingerprint = randomBytes(32).toString("hex");
    executorRow = await executorRepo.save(
      executorRepo.create({
        appName: `attemptseq-http-${STAMP}`,
        address: executorAddress,
        status: ExecutorStatus.ONLINE,
        type: ExecutorType.NODE,
        dispatchMode: "push",
        capabilities: ["node"],
        maxConcurrentTasks: 10,
        runningTaskCount: 0,
        cpuUsage: 0,
        memUsage: 0,
        diskUsage: 0,
        lastHeartbeat: new Date(),
        tokenHash: await bcrypt.hash(SHARED_TOKEN, 10),
        deviceFingerprint: fingerprint,
        groupName: null,
        tags: ["attemptseq-http"],
      }),
    );

    const safeStamp = STAMP.toLowerCase().replace(/[^a-z0-9]/g, "-");
    task = await taskRepo.save(
      buildTask({
        name: `task-attemptseq-http-${safeStamp}`,
        status: TaskStatus.ACTIVE,
        executeMode: ExecuteMode.SINGLE,
        runtime: TaskRuntime.NODE,
        glueSource: "console.log('attemptseq-http-ok');",
        timeout: 30,
        maxRetry: 0,
      }),
    );
    // 这两个字段不在 TaskFactoryOptions 白名单里：落到实体上再保存。
    task.codeSource = TaskCodeSource.GLUE;
    task.glueLanguage = "javascript";
    task.executorId = executorRow.id;
    task.runtimeVersion = null as never;
    task = await taskRepo.save(task);

    executionId = randomUUID();
    await execRepo.save(makeExecutionRow(task, executionId));

    // stamp 前缀的槽位哨兵：脚本 trap 清理 Redis 时用它验证键确实被清掉。
    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT),
      password: process.env.REDIS_PASSWORD || undefined,
      db: Number(process.env.REDIS_DB || 0),
      lazyConnect: false,
    });
    await redis.set(`acf:pull:attemptseq-http-${STAMP}`, "fixture-slot", "EX", 600);
    await redis.set(`slot-release:attemptseq-http-${STAMP}`, "fixture-slot", "EX", 600);
  });

  afterAll(async () => {
    dispatchSpy?.mockRestore();
    if (redis) await redis.quit().catch(() => undefined);

    if (child) {
      const proc = child.child;
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGTERM");
        await Promise.race([
          once(proc, "exit"),
          sleep(6_000).then(() => {
            if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
          }),
        ]);
      }
      expect(
        proc.exitCode !== null || proc.signalCode !== null,
      ).toBe(true);
      // 子进程退出证据保留给 verify 脚本做二次检查。
      fs.writeFileSync(path.join(TMP_ROOT, "executor.exited"), "1");
    }
    if (app) await app.close();
  });

  it("① 真 HTTP dispatch 到达 executor-node；attemptSeq=N 原样回传并写终态", async () => {
    await processor.handle({ data: { executionId } } as never);

    const observed = await waitFor(
      "executor observed dispatch",
      () => child!.observed.find((row) => row.executionId === executionId) ?? null,
      30_000,
    );
    expect(observed.attemptSeq).toBe(1);
    expect(observed.bodyKeys).toEqual(
      expect.arrayContaining(["attemptSeq", "executionId", "params", "secrets", "task"]),
    );
    expect(observed.taskName).toBe(task!.name);
    // eslint-disable-next-line no-console
    console.log(`[attemptseq-http] executor observed dispatch=${JSON.stringify(observed)}`);

    const callback = await waitFor(
      "executor terminal callback body",
      () => {
        const found = callbackBodies.find(
          (body) =>
            Array.isArray(body) &&
            body.some(
              (item: { executionId?: string; status?: string }) =>
                item.executionId === executionId && item.status === "success",
            ),
        ) as Array<{ executionId: string; status: string; attemptSeq?: number }> | undefined;
        return found?.[0] ?? null;
      },
      90_000,
    );
    expect(callback.executionId).toBe(executionId);
    expect(callback.attemptSeq).toBe(1);

    const row = await waitFor(
      "terminal row written by callback",
      async () => {
        const found = await execRepo.findOne({ where: { id: executionId } });
        return found?.status === ExecutionStatus.SUCCESS ? found : null;
      },
      90_000,
    );
    expect(row.attemptSeq).toBe(1);
    expect(row.endTime).toBeInstanceOf(Date);
  }, 180_000);

  it("② 重新 claim 使 attemptSeq 1 → 2（第二次派发用 spy 避免竞态回调）", async () => {
    await execRepo.update({ id: executionId }, { status: ExecutionStatus.FAILED });
    const before = await execRepo.findOne({ where: { id: executionId } });
    expect(before?.attemptSeq).toBe(1);

    dispatchSpy = jest
      .spyOn(executorService, "dispatch")
      .mockResolvedValue({ status: "accepted" } as never);

    await processor.handle({ data: { executionId } } as never);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);

    const after = await execRepo.findOne({ where: { id: executionId } });
    expect(after?.attemptSeq).toBe(2);
    expect(after?.status).toBe(ExecutionStatus.RUNNING);
    expect(after?.endTime).toBeInstanceOf(Date); // 第一次回合的终态时间仍留在行上，但状态已重新打开
  });

  it("③ 旧世代 HTTP 回调不污染新回合；新世代回调可写终态", async () => {
    const staleResponse = await request(app!.getHttpServer())
      .post("/api/executions/callback")
      .set("Authorization", `Bearer ${SHARED_TOKEN}`)
      .set("x-executor-address", executorAddress)
      .send([
        {
          executionId,
          status: "success",
          attemptSeq: 1,
          executorAddress,
        },
      ]);
    expect([200, 201]).toContain(staleResponse.status);
    // eslint-disable-next-line no-console
    console.log(`[attemptseq-http] stale callback body=${JSON.stringify(staleResponse.body)}`);

    const afterStale = await execRepo.findOne({ where: { id: executionId } });
    expect(afterStale?.status).toBe(ExecutionStatus.RUNNING);
    expect(afterStale?.attemptSeq).toBe(2);
    // eslint-disable-next-line no-console
    console.log(
      `[attemptseq-http] after stale row status=${afterStale?.status} attemptSeq=${afterStale?.attemptSeq} endTime=${afterStale?.endTime?.toISOString() ?? "null"}`,
    );

    const currentResponse = await request(app!.getHttpServer())
      .post("/api/executions/callback")
      .set("Authorization", `Bearer ${SHARED_TOKEN}`)
      .set("x-executor-address", executorAddress)
      .send([
        {
          executionId,
          status: "success",
          attemptSeq: 2,
          executorAddress,
        },
      ]);
    expect([200, 201]).toContain(currentResponse.status);
    // eslint-disable-next-line no-console
    console.log(`[attemptseq-http] current callback body=${JSON.stringify(currentResponse.body)}`);

    const afterCurrent = await execRepo.findOne({ where: { id: executionId } });
    expect(afterCurrent?.status).toBe(ExecutionStatus.SUCCESS);
    expect(afterCurrent?.attemptSeq).toBe(2);
    expect(afterCurrent?.endTime).toBeInstanceOf(Date);
    // eslint-disable-next-line no-console
    console.log(
      `[attemptseq-http] after current row status=${afterCurrent?.status} attemptSeq=${afterCurrent?.attemptSeq} endTime=${afterCurrent?.endTime?.toISOString() ?? "null"}`,
    );
  });
});
