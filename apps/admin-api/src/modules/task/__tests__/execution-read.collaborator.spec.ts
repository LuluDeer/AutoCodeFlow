import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { getQueueToken } from "@nestjs/bullmq";
import { DataSource } from "typeorm";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TaskService } from "../task.service";
import { ExecutionRead } from "../execution-read.collaborator";
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
 * T2-B4 第一刀（执行记录读面与导出）的**结构契约**。
 *
 * 这一刀把 9 个 Facade 公共方法搬进了 `ExecutionRead` 协作者。本 spec 钉住
 * 三条**搬错了就会静默失效**的不变量：
 *
 * 1. **spy 拦截面**：Facade 转发层是 spy 拦截面——既有 spec 用
 *    `jest.spyOn(service, "getExecutionReport")` 断言「确实走了这个方法」。
 *    若 Facade 把实现搬走却**不保留同名 public 方法**，或协作者内部
 *    **self-call** 自己的 public 方法，spy 都会**静默失效**（不是报错）。
 * 2. **`execRepo` 调用顺序**：`executions-export.spec.ts:705` 用
 *    `(service as any).execRepo.createQueryBuilder.mock.results[0]` 断言
 *    「绝不使用 OFFSET」——**索引型断言不会因为「多一次调用」而红，它会把别的
 *    调用结果当成本次的结果，断言假过**。⇒ Facade 转发层不许「预检一次」，
 *    协作者内的调用次数与顺序必须与搬迁前一致。
 * 3. **实现确实搬走了**（不是「复制了一份」）：协作者是**唯一**实现处，
 *    Facade 侧不得残留实现体。
 */

const makeRepo = () => ({
  create: jest.fn((d) => d),
  save: jest.fn((e) => Promise.resolve(e)),
  findOne: jest.fn(),
  find: jest.fn().mockResolvedValue([]),
  findAndCount: jest.fn().mockResolvedValue([[], 0]),
  count: jest.fn().mockResolvedValue(0),
  delete: jest.fn().mockResolvedValue({ affected: 1 }),
  createQueryBuilder: jest.fn(),
});

describe("T2-B4 第一刀 · ExecutionRead 协作者的转发契约", () => {
  let service: TaskService;
  let execRepo: ReturnType<typeof makeRepo>;

  beforeEach(async () => {
    execRepo = makeRepo();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TaskService,
        { provide: getRepositoryToken(Task), useValue: makeRepo() },
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
        {
          provide: getRepositoryToken(ExecutionLogLine),
          useValue: makeRepo(),
        },
        { provide: getRepositoryToken(TaskVersion), useValue: makeRepo() },
        { provide: getRepositoryToken(ExecutionReport), useValue: makeRepo() },
        { provide: getQueueToken("task-queue"), useValue: { add: jest.fn() } },
        { provide: DataSource, useValue: { transaction: jest.fn() } },
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

  it("① spy Facade 的 getExecutionReport ⇒ 协作者实现**不被调用**（spy 拦截面仍在）", async () => {
    // Facade 上的同名 public 方法必须存在（否则 spy 装不上/装到了别处）。
    expect(typeof (service as any).getExecutionReport).toBe("function");

    const payload = { execution: {}, timeline: [], report: null };
    const spy = jest
      .spyOn(service, "getExecutionReport")
      .mockResolvedValue(payload as never);

    // 让协作者实现一旦被调用就会炸（用 execRepo 的 findOne 作为探针）。
    execRepo.findOne.mockRejectedValue(new Error("collaborator was called"));

    const result = await service.getExecutionReport("exec-1", "task-1");

    // spy 拦住了 ⇒ 协作者实现**没有**被调用（execRepo.findOne 未被触发）
    expect(result).toBe(payload);
    expect(execRepo.findOne).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("①b 协作者内部不得 self-call 自己的 public 方法（否则 Facade 的 spy 会静默失效）", () => {
    // 判据形态：协作者源码里，对**自身 public 方法**的直接调用必须为 0。
    // （`scripts/check-collaborator-self-call.mjs` 是全仓守卫；这里是本刀的
    // 就地钉子——防止将来有人把某个 private 改成 public 就悄悄破了不变量。）
    const src = readFileSync(
      join(__dirname, "..", "execution-read.collaborator.ts"),
      "utf-8",
    ) as string;
    const publicMethods = [
      "getExecutions",
      "getAllExecutions",
      "streamExecutionsCsv",
      "getExecutionStats",
      "getExecution",
      "getExecutionReport",
    ];
    for (const name of publicMethods) {
      const selfCalls = src.match(new RegExp(`this\\.${name}\\s*\\(`, "g"));
      // 允许 0 次；若出现则必须不是「public 方法被本类 public 方法调用」
      expect(selfCalls ?? []).toHaveLength(0);
    }
    // 反证：private 互调是**允许**的（`findExecution` 等）
    expect(src).toContain("this.findExecution(");
  });

  it("② Facade 转发层**零预检**（execRepo 的调用次数与顺序与搬迁前一致）", async () => {
    // `streamExecutionsCsv` 既有 spec 用 `mock.results[0]` 做索引型断言 ⇒
    // Facade 转发前若「预检一次」execRepo，`results[0]` 就会指向**预检那次**
    // 而不是导出那次 ⇒ 断言**假过**（不是变红）。
    //
    // 这里钉住：转发一次 ⇒ execRepo.createQueryBuilder **恰好被调 1 次**
    // （转发层自己一次都不调）。
    // 投影 helper 需要 `repo.metadata.columns`（真实仓储的实体元数据）。
    (execRepo as unknown as { metadata: { columns: unknown[] } }).metadata = {
      columns: [{ propertyName: "id" }, { propertyName: "taskId" }],
    };
    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
      getCount: jest.fn().mockResolvedValue(0),
    };
    execRepo.createQueryBuilder.mockReturnValue(qb);

    const chunks: string[] = [];
    await service.streamExecutionsCsv({}, async (chunk: string) => {
      chunks.push(chunk);
    });

    // 一次转发 ⇒ createQueryBuilder 恰好一次（Facade 零预检）
    expect(execRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    // 且 `results[0]` 就是那一次（索引型断言仍指向正确对象）
    const first = execRepo.createQueryBuilder.mock.results[0].value;
    expect(first).toBe(qb);
    expect(first.skip).not.toHaveBeenCalled();

    // ── 同一不变量在「单条读」路径上也要成立 ──
    // `getExecutionReport` 是唯一被 spy 的方法 ⇒ Facade 若在转发前碰 execRepo
    // （哪怕是 count 预检），`mock.results[0]` 这类索引型断言就会指向**预检那次**
    // ⇒ 断言**假过**（不是变红）。这里钉住：转发前 Facade 对 execRepo **零调用**。
    execRepo.createQueryBuilder.mockClear();
    execRepo.findOne.mockClear();
    execRepo.count.mockClear();
    execRepo.find.mockClear();
    execRepo.findAndCount.mockClear();
    await service.getExecutionReport("exec-1", "task-1").catch(() => undefined);
    // Facade 自己一次都没碰 execRepo（实现调用全部发生在协作者内部）
    expect(execRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(execRepo.findAndCount).not.toHaveBeenCalled();
    expect(execRepo.count).not.toHaveBeenCalled();
    expect(execRepo.find).not.toHaveBeenCalled();
    // findOne 是协作者内部**唯一**的一次调用（实现所需）⇒ 恰好 1 次
    expect(execRepo.findOne).toHaveBeenCalledTimes(1);
  });

  it("③ 实现**只在协作者**（Facade 侧不得残留实现体）", () => {
    const facadeSrc = readFileSync(
      join(__dirname, "..", "task.service.ts"),
      "utf-8",
    );
    const collaboratorSrc = readFileSync(
      join(__dirname, "..", "execution-read.collaborator.ts"),
      "utf-8",
    );
    // Facade 侧只应出现**转发调用**，不应出现实现特征（如 findAndCount /
    // createQueryBuilder("e") / executionListSelectMap 的调用）。
    expect(facadeSrc).toContain("this.executionRead.getExecutions(");
    expect(facadeSrc).toContain("this.executionRead.getExecutionReport(");
    expect(facadeSrc).not.toContain("executionListSelectMap(this.execRepo)");
    expect(facadeSrc).not.toContain('createQueryBuilder("e")');
    // 协作者侧才有实现
    expect(collaboratorSrc).toContain(
      "executionListSelectMap(this.deps.execRepo)",
    );
    expect(collaboratorSrc).toContain('createQueryBuilder("e")');
  });

  it("④ Facade 保留同名 public 方法（既有 spec 直接调它们 ⇒ 转发面不能窄化）", () => {
    for (const name of [
      "getExecutions",
      "getAllExecutions",
      "streamExecutionsCsv",
      "getExecutionStats",
      "getExecution",
      "getExecutionReport",
    ]) {
      expect(typeof (service as any)[name]).toBe("function");
    }
  });

  it("⑤ 协作者是**懒构造单例**（转发多次不新建实例）", () => {
    const first = (service as any).executionRead;
    const second = (service as any).executionRead;
    expect(first).toBeInstanceOf(ExecutionRead);
    expect(second).toBe(first);
  });
});
