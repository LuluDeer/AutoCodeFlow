/**
 * LOG-11 (optimization-notes 2.6) integration tests for the optional S3 log
 * driver. Mocks the minio Client so the suite is hermetic — no real MinIO.
 *
 * Coverage:
 *   - handleCallback with LOG_STORAGE_DRIVER=s3 calls S3 put (gzip) and
 *     persists the (storage="s3", key) reference instead of DB rows.
 *   - S3 put failure falls back to DB row storage and the execution still
 *     ends up marked SUCCESS.
 *   - getExecutionLogs on an S3-stored execution gunzips and slices the
 *     decoded lines; pagination metadata reflects the full content.
 *   - getExecutionLogs falls back to DB rows when S3 get throws.
 *   - Default (driver=db) keeps writing to execution_log_lines — no S3 calls.
 *   - The lazy S3LogStorage resolver only constructs once even when both
 *     callback and read paths go through resolveS3Storage().
 */
import { Readable } from "node:stream";
import { gzipSync, gunzipSync } from "node:zlib";
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { getQueueToken } from "@nestjs/bullmq";
import { ConfigService } from "@nestjs/config";
import { TaskService } from "../task.service";
import { Task } from "../entities/task.entity";
import {
  TaskExecution,
  ExecutionStatus,
} from "../entities/task-execution.entity";
import { ExecutionLogLine } from "../entities/execution-log-line.entity";
import { TaskVersion } from "../entities/task-version.entity";
import { SchedulerService } from "../../scheduler/scheduler.service";
import { AiService } from "../../ai/ai.service";
import { ExecutorService } from "../../executor/executor.service";
import { NotificationService } from "../../notification/notification.service";
import { AuditService } from "../../audit/audit.service";

const minioClient = {
  bucketExists: jest.fn(),
  makeBucket: jest.fn(),
  putObject: jest.fn(),
  getObject: jest.fn(),
  removeObject: jest.fn(),
};

jest.mock("minio", () => ({
  Client: jest.fn(() => minioClient),
}));

// The log-backfill path dynamically imports axios to page logs from the
// executor; mock it so no network is attempted.
jest.mock("axios");

const makeRepo = () => {
  const repo: Record<string, jest.Mock> = {
    create: jest.fn((d) => d),
    save: jest.fn((e) => Promise.resolve(e)),
    findOne: jest.fn(),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
    find: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  repo.createQueryBuilder = jest.fn(() => {
    let patch: Record<string, unknown> | null = null;
    const target = repo.findOne.mock.results.length
      ? repo.findOne.mock.results[repo.findOne.mock.results.length - 1].value
      : null;
    const qb: Record<string, jest.Mock> = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      // handleCallback / killExecution 的终态 UPDATE 现携带 RETURNING。
      returning: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
      getRawOne: jest.fn().mockResolvedValue({ maxNum: 0 }),
      update: jest.fn().mockReturnThis(),
      set: jest.fn((p: Record<string, unknown>) => {
        patch = p;
        return qb;
      }),
      execute: jest.fn().mockImplementation(async () => {
        const entity = await target;
        if (!entity) return { affected: 0 };
        const status = (entity as { status?: string }).status;
        const TERMINAL = [
          "success",
          "failed",
          "timeout",
          "cancelled",
          "killed",
        ];
        if (status && TERMINAL.includes(status)) {
          return { affected: 0 };
        }
        if (patch) Object.assign(entity, patch);
        // 模拟 UPDATE ... RETURNING ["id","executorAddress"]。
        return {
          affected: 1,
          raw: [
            {
              id: (entity as { id?: string }).id,
              executorAddress:
                (entity as { executorAddress?: string | null })
                  .executorAddress ?? null,
            },
          ],
        };
      }),
    };
    return qb;
  });
  return repo;
};

describe("TaskService + S3 log driver integration (LOG-11)", () => {
  let service: TaskService;
  let taskRepo: ReturnType<typeof makeRepo>;
  let execRepo: ReturnType<typeof makeRepo>;
  let logLineRepo: ReturnType<typeof makeRepo>;
  let versionRepo: ReturnType<typeof makeRepo>;
  let configGet: jest.Mock;
  let releaseSlotExecute: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();
    minioClient.bucketExists.mockResolvedValue(true);
    minioClient.makeBucket.mockResolvedValue(undefined);
    minioClient.putObject.mockResolvedValue(undefined);
    minioClient.removeObject.mockResolvedValue(undefined);

    taskRepo = makeRepo();
    execRepo = makeRepo();
    logLineRepo = makeRepo();
    versionRepo = makeRepo();
    releaseSlotExecute = jest.fn().mockResolvedValue({ affected: 1 });
    configGet = jest.fn((key: string) => {
      const map: Record<string, unknown> = {
        "logStorage.driver": "s3",
        "logStorage.bucket": "test-bucket",
        "logStorage.endpoint": "minio:9000",
        "logStorage.accessKey": "AK",
        "logStorage.secretKey": "SK",
        "logStorage.useSSL": false,
        "logStorage.region": "",
      };
      return map[key];
    });

    const module = await Test.createTestingModule({
      providers: [
        TaskService,
        { provide: getRepositoryToken(Task), useValue: taskRepo },
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
        {
          provide: getRepositoryToken(ExecutionLogLine),
          useValue: logLineRepo,
        },
        { provide: getRepositoryToken(TaskVersion), useValue: versionRepo },
        {
          provide: getQueueToken("task-queue"),
          useValue: { add: jest.fn().mockResolvedValue({}) },
        },
        {
          provide: DataSource,
          useValue: {
            // R4-P2: DB-path log persistence runs delete+insert inside one
            // transaction; delegate the transaction manager to the repo mocks
            // so per-call assertions keep working.
            transaction: jest.fn(async (fn: any) =>
              fn({
                delete: jest.fn(async (_t: unknown, criteria: unknown) =>
                  logLineRepo.delete(criteria as any),
                ),
                save: jest.fn(async (_t: unknown, rows: unknown) =>
                  logLineRepo.save(rows as any),
                ),
              }),
            ),
            createQueryBuilder: jest.fn(() => ({
              update: jest.fn().mockReturnThis(),
              set: jest.fn().mockReturnThis(),
              where: jest.fn().mockReturnThis(),
              execute: releaseSlotExecute,
            })),
          },
        },
        {
          provide: SchedulerService,
          useValue: {
            stop: jest.fn(),
            scheduleOne: jest.fn(),
            getStats: jest.fn(),
          },
        },
        {
          provide: AiService,
          useValue: { analyzeFailure: jest.fn(), chat: jest.fn() },
        },
        { provide: ConfigService, useValue: { get: configGet } },
        {
          provide: ExecutorService,
          useValue: {
            getExecutorUrl: jest.fn((_a, p) => `http://ex/${p}`),
            // 日志回填 token 现走 DB 优先的 getSharedToken
            getSharedToken: jest.fn().mockResolvedValue(""),
          },
        },
        {
          provide: NotificationService,
          useValue: {
            notifyFailureWithConfig: jest.fn().mockResolvedValue(undefined),
            notifyFailure: jest.fn().mockResolvedValue(undefined),
            sendAll: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();

    service = module.get(TaskService);
  });

  it("callback upload: writes to S3 (gzip) and records (storage=s3, key) instead of DB rows", async () => {
    const exec = { id: "e-s3", status: ExecutionStatus.RUNNING, logs: "" };
    execRepo.findOne.mockResolvedValue(exec);

    const result = await service.handleCallback([
      {
        executionId: "e-s3",
        status: "success",
        logs: "alpha\nbeta\ngamma",
      },
    ]);

    expect(result[0].success).toBe(true);
    expect(exec.status).toBe(ExecutionStatus.SUCCESS);

    // S3 client received exactly one putObject with gzipped payload.
    expect(minioClient.putObject).toHaveBeenCalledTimes(1);
    const [bucket, key, body, size, meta] = minioClient.putObject.mock.calls[0];
    expect(bucket).toBe("test-bucket");
    expect(key).toBe("execution-logs/e-s3.log.gz");
    expect(gunzipSync(body).toString("utf-8")).toBe("alpha\nbeta\ngamma");
    expect(size).toBe(body.length);
    expect(meta["Content-Encoding"]).toBe("gzip");

    // exec row carries the reference; DB rows were never inserted.
    expect(execRepo.update).toHaveBeenCalledWith("e-s3", {
      logStorage: "s3",
      logObjectKey: "execution-logs/e-s3.log.gz",
    });
    expect(logLineRepo.save).not.toHaveBeenCalled();
    expect(logLineRepo.delete).toHaveBeenCalledWith({ executionId: "e-s3" });
  });

  it("callback upload fallback: when S3 put throws, logs are written as DB rows and execution still succeeds", async () => {
    const exec = { id: "e-fb", status: ExecutionStatus.RUNNING, logs: "" };
    execRepo.findOne.mockResolvedValue(exec);
    minioClient.putObject.mockRejectedValueOnce(
      Object.assign(new Error("ECONNREFUSED 10.0.0.5:9000"), {
        code: "ECONNREFUSED",
      }),
    );

    const result = await service.handleCallback([
      {
        executionId: "e-fb",
        status: "success",
        logs: "line-A\nline-B",
      },
    ]);

    expect(result[0].success).toBe(true);
    expect(exec.status).toBe(ExecutionStatus.SUCCESS);
    expect(minioClient.putObject).toHaveBeenCalledTimes(1);

    // DB row fallback path: deletion of any stale rows, then bulk insert.
    expect(logLineRepo.delete).toHaveBeenCalledWith({ executionId: "e-fb" });
    expect(logLineRepo.create).toHaveBeenCalledWith({
      executionId: "e-fb",
      lineNumber: 0,
      content: "line-A",
      level: null,
    });
    expect(logLineRepo.create).toHaveBeenCalledWith({
      executionId: "e-fb",
      lineNumber: 1,
      content: "line-B",
      level: null,
    });
    expect(logLineRepo.save).toHaveBeenCalled();

    // exec row must NOT advertise s3 storage after a fallback.
    expect((exec as any).logStorage).toBeUndefined();
  });

  it("getExecutionLogs reads from S3, gunzips, paginates correctly", async () => {
    const payload = Array.from({ length: 10 }, (_, i) => `line-${i}`).join(
      "\n",
    );
    const gz = gzipSync(Buffer.from(payload, "utf-8"));
    // Each call must yield a fresh Readable — a stream consumed on the first
    // call would be empty on the second.
    minioClient.getObject.mockImplementation(() =>
      Promise.resolve(Readable.from([gz])),
    );

    const exec = {
      id: "e-read",
      status: ExecutionStatus.SUCCESS,
      logStorage: "s3",
      logObjectKey: "execution-logs/e-read.log.gz",
    };
    execRepo.findOne.mockResolvedValue(exec);

    const firstPage = await service.getExecutionLogs("e-read", 0, 3);
    expect(firstPage.totalLines).toBe(10);
    expect(firstPage.lines).toEqual(["line-0", "line-1", "line-2"]);
    expect(firstPage.hasMore).toBe(true);

    // The second page should resume without re-downloading everything (mock
    // would catch multiple calls). Also confirm tail of file.
    const lastPage = await service.getExecutionLogs("e-read", 9, 50);
    expect(lastPage.lines).toEqual(["line-9"]);
    expect(lastPage.hasMore).toBe(false);
    expect(minioClient.getObject).toHaveBeenCalledTimes(2);
    expect(minioClient.getObject).toHaveBeenCalledWith(
      "test-bucket",
      "execution-logs/e-read.log.gz",
    );
    // The DB fallback was never reached (s3 path covers this test).
    expect(logLineRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it("getExecutionLogs falls back to DB rows when S3 get throws", async () => {
    minioClient.getObject.mockRejectedValueOnce(
      new Error("NoSuchKey: missing"),
    );
    const exec = {
      id: "e-missing",
      status: ExecutionStatus.SUCCESS,
      logStorage: "s3",
      logObjectKey: "execution-logs/e-missing.log.gz",
    };
    execRepo.findOne.mockResolvedValue(exec);
    const fallbackQb: any = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([
        { lineNumber: 0, content: "fallback-A" },
        { lineNumber: 1, content: "fallback-B" },
      ]),
    };
    logLineRepo.createQueryBuilder.mockReturnValue(fallbackQb);
    logLineRepo.count.mockResolvedValue(2);
    logLineRepo.count.mockResolvedValue(2);

    const result = await service.getExecutionLogs("e-missing", 0);
    expect(result.lines).toEqual(["fallback-A", "fallback-B"]);
    expect(result.totalLines).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(minioClient.getObject).toHaveBeenCalledTimes(1);
  });

  it("R4-P1: multi-page backfill with S3 driver concatenates pages into one growing object", async () => {
    const exec = {
      id: "e-s3-multi",
      status: ExecutionStatus.RUNNING,
      executorAddress: "exec-1:8002",
      logs: "",
    };
    execRepo.findOne.mockResolvedValue(exec);
    const axios = (await import("axios")).default as any;
    axios.get
      // Page 0: object does not exist yet
      .mockResolvedValueOnce({
        data: { lines: ["m0", "m1"], totalLines: 4, hasMore: true },
      })
      .mockResolvedValueOnce({
        data: { lines: ["m2", "m3"], totalLines: 4, hasMore: false },
      });
    // The append path reads back the page-0 object before uploading page 1.
    minioClient.getObject.mockImplementationOnce(() =>
      Promise.resolve(
        Readable.from([gzipSync(Buffer.from("m0\nm1", "utf-8"))]),
      ),
    );

    await service.handleCallback([
      {
        executionId: "e-s3-multi",
        status: "success",
        executorAddress: "exec-1:8002",
        logs: "...[truncated, total 50000 chars]...",
      },
    ]);

    // Two uploads; the second must contain pages 0+1 concatenated.
    expect(minioClient.putObject).toHaveBeenCalledTimes(2);
    const firstBody = minioClient.putObject.mock.calls[0][2] as Buffer;
    const secondBody = minioClient.putObject.mock.calls[1][2] as Buffer;
    expect(gunzipSync(firstBody).toString("utf-8")).toBe("m0\nm1");
    expect(gunzipSync(secondBody).toString("utf-8")).toBe("m0\nm1\nm2\nm3");
    // Page 0 replaced; pages 1+ must not clear anything mid-backfill.
    expect(logLineRepo.delete).toHaveBeenCalledTimes(1);
    expect(execRepo.update).toHaveBeenLastCalledWith("e-s3-multi", {
      logStorage: "s3",
      logObjectKey: "execution-logs/e-s3-multi.log.gz",
    });
  });

  // BUG-06 修复回归：replace 模式 S3 put 失败——DB 重写后指针必须收回 db，
  // 否则 exec 行仍指旧对象，读取面永远看到 STALE 内容。
  it("BUG-06 fallback pointer reset: replace-mode S3 failure clears the stale s3 pointer", async () => {
    const exec = {
      id: "e-stale",
      status: ExecutionStatus.RUNNING,
      logs: "",
      logStorage: "s3",
      logObjectKey: "execution-logs/e-stale.log.gz",
    };
    execRepo.findOne.mockResolvedValue(exec);
    minioClient.putObject.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    await service.handleCallback([
      { executionId: "e-stale", status: "success", logs: "fresh-1\nfresh-2" },
    ]);

    // DB 重写（replace：先 delete 再插新行）
    expect(logLineRepo.delete).toHaveBeenCalledWith({ executionId: "e-stale" });
    // 指针收回：不再 advertise 旧 S3 对象
    expect(execRepo.update).toHaveBeenLastCalledWith("e-stale", {
      logStorage: "db",
      logObjectKey: null,
    });
  });

  // BUG-06 修复回归：append 模式 S3 put 失败——既有 S3 内容并入 DB 回退，
  // 根治"本页落 DB 成孤儿行（S3 优先读取面永远看不到）"。
  it("BUG-06 fallback merge: append-mode S3 failure merges existing object content into DB rows", async () => {
    const exec = {
      id: "e-merge",
      status: ExecutionStatus.RUNNING,
      executorAddress: "exec-1:8002",
      logs: "",
    };
    execRepo.findOne.mockResolvedValue(exec);
    const axios = (await import("axios")).default as any;
    axios.get
      .mockResolvedValueOnce({
        data: { lines: ["m0", "m1"], totalLines: 4, hasMore: true },
      })
      .mockResolvedValueOnce({
        data: { lines: ["m2", "m3"], totalLines: 4, hasMore: false },
      });
    // page-1 的 append 先读回 page-0 对象，随后 put 失败
    minioClient.getObject.mockImplementationOnce(() =>
      Promise.resolve(
        Readable.from([gzipSync(Buffer.from("m0\nm1", "utf-8"))]),
      ),
    );
    minioClient.putObject
      .mockResolvedValueOnce(undefined) // page-0 成功上 S3
      .mockRejectedValueOnce(new Error("ECONNREFUSED")); // page-1 失败

    await service.handleCallback([
      {
        executionId: "e-merge",
        status: "success",
        executorAddress: "exec-1:8002",
        logs: "...[truncated, total 50000 chars]...",
      },
    ]);

    // 回退把 existing(m0/m1) + 本页(m2/m3) 全量写 DB，行号归零
    expect(logLineRepo.create).toHaveBeenCalledWith({
      executionId: "e-merge",
      lineNumber: 0,
      content: "m0",
      level: null,
    });
    expect(logLineRepo.create).toHaveBeenCalledWith({
      executionId: "e-merge",
      lineNumber: 3,
      content: "m3",
      level: null,
    });
    // 全量改写 = replace 语义（先 delete）
    expect(logLineRepo.delete).toHaveBeenCalledWith({ executionId: "e-merge" });
    // 指针收回 db
    expect(execRepo.update).toHaveBeenLastCalledWith("e-merge", {
      logStorage: "db",
      logObjectKey: null,
    });
  });

  it("db driver: callback writes DB rows and never touches S3", async () => {
    // Override the config to disable s3 for this test only.
    configGet.mockImplementation((key: string) => {
      if (key === "logStorage.driver") return "db";
      if (key === "logStorage.endpoint") return "";
      return "";
    });
    const exec = { id: "e-db", status: ExecutionStatus.RUNNING, logs: "" };
    execRepo.findOne.mockResolvedValue(exec);

    await service.handleCallback([
      { executionId: "e-db", status: "success", logs: "alpha\nbeta" },
    ]);

    expect(minioClient.putObject).not.toHaveBeenCalled();
    expect(logLineRepo.create).toHaveBeenCalledWith({
      executionId: "e-db",
      lineNumber: 0,
      content: "alpha",
      level: null,
    });
    expect(logLineRepo.create).toHaveBeenCalledWith({
      executionId: "e-db",
      lineNumber: 1,
      content: "beta",
      level: null,
    });
  });

  it("resolves S3LogStorage lazily and reuses the same instance on callback + read", async () => {
    const exec = {
      id: "e-reuse",
      status: ExecutionStatus.RUNNING,
      logs: "",
    };
    execRepo.findOne.mockResolvedValue(exec);
    minioClient.getObject.mockImplementation(() =>
      Promise.resolve(Readable.from([gzipSync(Buffer.from("only-line"))])),
    );

    // Trigger callback path (should construct S3LogStorage from config).
    await service.handleCallback([
      { executionId: "e-reuse", status: "success", logs: "only-line" },
    ]);
    // Now the same execution is read via getExecutionLogs (should NOT re-init).
    execRepo.findOne.mockResolvedValue({
      id: "e-reuse",
      status: ExecutionStatus.SUCCESS,
      logStorage: "s3",
      logObjectKey: "execution-logs/e-reuse.log.gz",
    });
    const result = await service.getExecutionLogs("e-reuse", 0);
    expect(result.lines).toEqual(["only-line"]);

    // Only ONE Client constructor call across both paths — proof that the
    // lazy resolver cached its instance.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Client } = require("minio");
    expect(Client).toHaveBeenCalledTimes(1);
  });

  // OBS-03: S3 路径无 level 列可下推——整流解码后逐行重推断过滤。
  // 取舍（正确性 > 数据量）：MAX_LOG_BYTES 已为解码体积兜底，重推断是
  // O(lines) 文本扫描。这里验证：过滤行集、过滤后分页偏移与 totalLines。
  describe("OBS-03: S3 read-path level filter (post-read)", () => {
    const PAYLOAD = [
      "[INFO] starting",
      "[ERROR] boom",
      "no level",
      "2024-01-01 10:00:00 [ERROR] tz boom",
      "[WARN] careful",
    ].join("\n");

    beforeEach(() => {
      minioClient.getObject.mockImplementation(() =>
        Promise.resolve(
          Readable.from([gzipSync(Buffer.from(PAYLOAD, "utf-8"))]),
        ),
      );
      execRepo.findOne.mockResolvedValue({
        id: "e-level",
        status: ExecutionStatus.SUCCESS,
        logStorage: "s3",
        logObjectKey: "execution-logs/e-level.log.gz",
      });
    });

    it("filters by level after decode; unknown-level rows are excluded", async () => {
      const result = await service.getExecutionLogs("e-level", 0, 50, "ERROR");
      expect(result.lines).toEqual([
        "[ERROR] boom",
        "2024-01-01 10:00:00 [ERROR] tz boom",
      ]);
      expect(result.totalLines).toBe(2);
      expect(result.hasMore).toBe(false);
    });

    it("fromLine is an offset into the filtered sequence (not the physical line)", async () => {
      // 过滤后序列：0=[ERROR] boom, 1=tz boom → offset 1 起第二页
      const secondPage = await service.getExecutionLogs(
        "e-level",
        1,
        1,
        "ERROR",
      );
      expect(secondPage.lines).toEqual(["2024-01-01 10:00:00 [ERROR] tz boom"]);
      expect(secondPage.totalLines).toBe(2);
      expect(secondPage.hasMore).toBe(false);
    });

    it("no level param keeps unfiltered behavior on the S3 path", async () => {
      const result = await service.getExecutionLogs("e-level", 0, 50);
      expect(result.lines).toEqual(PAYLOAD.split("\n"));
      expect(result.totalLines).toBe(5);
      expect(result.hasMore).toBe(false);
    });
  });
});
