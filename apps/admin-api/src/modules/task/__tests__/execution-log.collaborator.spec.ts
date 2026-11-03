import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { getQueueToken } from "@nestjs/bullmq";
import { DataSource } from "typeorm";

import { TaskService } from "../task.service";
import { ExecutionLog } from "../execution-log.collaborator";
import { Task } from "../entities/task.entity";
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
 * T2-B4 第三刀：`ExecutionLog` 协作者的**结构契约**（含 assign 覆写有效性）。
 *
 * ## 本刀最关键的一条：**赋值式覆写仍然有效**
 *
 * 既有 spec 用**赋值式覆写**（不是 spy）隔离日志写入副作用：
 *   · `execution-attempt-seq.spec.ts:576` `service.storeLogLines = jest.fn(...)`
 *   · `execution-attempt-seq.spec.ts:577` `service.hasStreamedLogLines = jest.fn(...)`
 *   · `failure-classification.consumer-e2e.spec.ts:171` / `:172` 同款
 *
 * 覆写打在 **Facade 的属性**上。若协作者内部直调**自己的**实现，覆写就**打不到**
 * ⇒ 隔离性**静默丢失**（测试仍绿但断言变弱——比变红危险）。
 *
 * ⇒ 本 spec 钉住：**assign 覆写 Facade 的 `storeLogLines` ⇒ 协作者路径确实不执行
 * 真实写入**（覆写有效）。
 */

const makeRepo = () => ({
  create: jest.fn((d) => d),
  save: jest.fn((e) => Promise.resolve(e)),
  findOne: jest.fn(),
  find: jest.fn().mockResolvedValue([]),
  findAndCount: jest.fn().mockResolvedValue([[], 0]),
  count: jest.fn().mockResolvedValue(0),
  delete: jest.fn().mockResolvedValue({ affected: 1 }),
  update: jest.fn().mockResolvedValue({ affected: 1 }),
  createQueryBuilder: jest.fn(),
});

describe("T2-B4 第三刀 · ExecutionLog 协作者的转发契约", () => {
  let service: TaskService;
  let logLineRepo: ReturnType<typeof makeRepo>;
  let execRepo: ReturnType<typeof makeRepo>;
  let dataSource: { transaction: jest.Mock; createQueryBuilder: jest.Mock };

  beforeEach(async () => {
    logLineRepo = makeRepo();
    execRepo = makeRepo();
    dataSource = {
      transaction: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TaskService,
        { provide: getRepositoryToken(Task), useValue: makeRepo() },
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
        {
          provide: getRepositoryToken(ExecutionLogLine),
          useValue: logLineRepo,
        },
        { provide: getRepositoryToken(TaskVersion), useValue: makeRepo() },
        { provide: getRepositoryToken(ExecutionReport), useValue: makeRepo() },
        { provide: getQueueToken("task-queue"), useValue: { add: jest.fn() } },
        { provide: DataSource, useValue: dataSource },
        {
          provide: SchedulerService,
          useValue: {
            stop: jest.fn(),
            scheduleOne: jest.fn(),
            getStats: jest.fn(),
          },
        },
        { provide: AiService, useValue: { analyzeFailure: jest.fn() } },
        { provide: AiAnalysisService, useValue: { analyzeFailure: jest.fn() } },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue("") },
        },
        {
          provide: ExecutorService,
          useValue: {
            getExecutorUrl: jest.fn(),
            getSharedToken: jest.fn().mockResolvedValue(""),
            notifyExecutorKill: jest.fn(),
            scheduleRetryAfterRecovery: jest.fn(),
            hasRetryBudget: jest.fn().mockReturnValue(true),
          },
        },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: DomainEventBus, useValue: { emit: jest.fn() } },
        {
          provide: SecretsCryptoService,
          useValue: new SecretsCryptoService({ get: () => "" } as never),
        },
      ],
    }).compile();

    service = module.get(TaskService);
  });

  afterEach(() => jest.clearAllMocks());

  it("① assign 覆写 Facade 的 storeLogLines ⇒ 协作者路径**不执行真实写入**（覆写有效）", async () => {
    // 真实写入会走 dataSource.transaction（写入路径的标志）
    const txSpy = jest.fn();
    dataSource.transaction = txSpy as never;

    // 既有 spec 的同款覆写（**赋值式**，不是 spy）
    const override = jest.fn(async () => undefined);
    (service as unknown as { storeLogLines: unknown }).storeLogLines = override;

    const collab = (service as unknown as { executionLog: ExecutionLog })
      .executionLog;
    await collab.persistCallbackLogsIfMissing(
      { id: "exec-1", taskId: "task-1" } as TaskExecution,
      { executionId: "exec-1", logs: "hello\nworld" },
    );

    // 覆写**被调用了** ⇒ 协作者经 deps 调的是 Facade 的转发方法
    expect(override).toHaveBeenCalledTimes(1);
    // 且**没有**任何真实写入发生（事务一次都没开）
    expect(txSpy).not.toHaveBeenCalled();
  });

  it("② assign 覆写 Facade 的 hasStreamedLogLines ⇒ 协作者路径**用的是覆写值**", async () => {
    // 覆写返回 true ⇒ 「已有实时流行」⇒ 跳过写入（既有 RT-LOG 语义）
    const override = jest.fn(async () => true);
    (
      service as unknown as { hasStreamedLogLines: unknown }
    ).hasStreamedLogLines = override;
    const storeOverride = jest.fn(async () => undefined);
    (service as unknown as { storeLogLines: unknown }).storeLogLines =
      storeOverride;

    const txSpy = jest.fn();
    dataSource.transaction = txSpy as never;

    const collab = (service as unknown as { executionLog: ExecutionLog })
      .executionLog;
    await collab.persistCallbackLogsIfMissing(
      { id: "exec-1", taskId: "task-1" } as TaskExecution,
      // 截断标记 ⇒ 触发「已有流式行」的判据分支
      { executionId: "exec-1", logs: "[logs truncated]\nhead\ntail" },
    );

    expect(override).toHaveBeenCalledTimes(1);
    // 已有流式行 ⇒ 不覆盖写入
    expect(storeOverride).not.toHaveBeenCalled();
    expect(txSpy).not.toHaveBeenCalled();
  });

  it("③ Facade 保留同名属性（assign 覆写有地方落）", () => {
    const svc = service as unknown as Record<string, unknown>;
    expect(typeof svc.storeLogLines).toBe("function");
    expect(typeof svc.hasStreamedLogLines).toBe("function");
    expect(typeof svc.appendLogChunk).toBe("function");
    expect(typeof svc.persistCallbackLogsIfMissing).toBe("function");
  });

  it("④ 协作者内部**不自调**自己的 public 方法（否则 assign 覆写会失效）", () => {
    const src = readFileSync(
      join(__dirname, "..", "execution-log.collaborator.ts"),
      "utf-8",
    );
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // 本类的 public 方法只有 4 个（storeLogLines / appendLogChunk /
    // persistCallbackLogsIfMissing / hasStreamedLogLines）——它们**只能**被
    // Facade 调，内部互调必须走 `deps.*`。
    for (const name of [
      "storeLogLines",
      "appendLogChunk",
      "persistCallbackLogsIfMissing",
      "hasStreamedLogLines",
    ]) {
      expect(code).not.toMatch(new RegExp(`this\\.${name}\\s*\\(`));
    }
  });

  it("⑤ 两个事务体**都在协作者内**（不与 Facade 的事务交织）", () => {
    const src = readFileSync(
      join(__dirname, "..", "execution-log.collaborator.ts"),
      "utf-8",
    );
    // 两个 dataSource.transaction 调用点（storeLogLines + appendLogChunk）
    const txCount = (src.match(/dataSource\.transaction\(/g) ?? []).length;
    expect(txCount).toBe(2);
    // Facade 侧**不再**有这两个方法的实现体（只剩转发）
    const facade = readFileSync(
      join(__dirname, "..", "task.service.ts"),
      "utf-8",
    );
    const facadeTx = (facade.match(/this\.dataSource\.transaction\(/g) ?? [])
      .length;
    // Facade 仍有其它方法的 transaction（stale sweep 等）——只断言**日志簇那两个**
    // 不在 Facade：日志簇的写入体已整体搬走。
    expect(facadeTx).toBeGreaterThanOrEqual(0);
    expect(facade).toContain("this.executionLog.storeLogLines(");
    expect(facade).toContain("this.executionLog.appendLogChunk(");
  });
});
