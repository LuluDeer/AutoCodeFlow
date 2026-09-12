import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { getQueueToken } from "@nestjs/bullmq";
import { UnrecoverableError } from "bullmq";
import { TaskProcessor } from "../task.processor";
import {
  TaskExecution,
  ExecutionStatus,
  ExecutionFailureReason,
} from "../entities/task-execution.entity";
import { ExecutionLogLine } from "../entities/execution-log-line.entity";
import { Task } from "../entities/task.entity";
import { ExecutorService } from "../../executor/executor.service";
import { AiAnalysisService } from "../../ai/ai-analysis.service";
import { NotificationService } from "../../notification/notification.service";
import { AuditService } from "../../audit/audit.service";
import { TaskService } from "../task.service";

const makeRepo = (overrides: Partial<Record<string, jest.Mock>> = {}) => ({
  findOne: jest.fn(),
  save: jest.fn((e) => Promise.resolve(e)),
  create: jest.fn((d) => d),
  delete: jest.fn().mockResolvedValue(undefined),
  update: jest.fn().mockResolvedValue({ affected: 1 }),
  createQueryBuilder: jest.fn(() => ({
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  })),
  ...overrides,
});

// Minimal DataSource mock: createQueryRunner returns a stub that satisfies
// the transaction path in the finally block of TaskProcessor.handle.
const makeDataSource = () => ({
  createQueryRunner: jest.fn(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    manager: {
      save: jest.fn((e) => Promise.resolve(e)),
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn(() => ({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      })),
    },
  })),
});

describe("TaskProcessor", () => {
  let processor: TaskProcessor;
  let execRepo: ReturnType<typeof makeRepo>;
  let taskRepo: ReturnType<typeof makeRepo>;
  let logLineRepo: ReturnType<typeof makeRepo>;
  let executorService: jest.Mocked<
    Pick<ExecutorService, "dispatch" | "dispatchBroadcast">
  >;
  let aiService: { analyzeFailure: jest.Mock };
  let notificationService: jest.Mocked<
    Pick<NotificationService, "notifyFailureWithConfig">
  >;
  let auditService: { log: jest.Mock };
  let taskService: {
    trigger: jest.Mock;
    publishTerminalEventForDispatch: jest.Mock;
  };
  let dataSource: ReturnType<typeof makeDataSource>;

  const task = {
    id: "t1",
    name: "task1",
    timeout: 10,
    alarmEmail: undefined,
    alarmChannels: [],
    executeMode: "single",
  } as unknown as Task;
  const exec = {
    id: "exec-1",
    taskId: "t1",
    status: ExecutionStatus.PENDING,
    params: {},
  } as TaskExecution;

  beforeEach(async () => {
    execRepo = makeRepo({ findOne: jest.fn().mockResolvedValue({ ...exec }) });
    taskRepo = makeRepo({ findOne: jest.fn().mockResolvedValue(task) });
    logLineRepo = makeRepo();
    executorService = { dispatch: jest.fn(), dispatchBroadcast: jest.fn() };
    aiService = { analyzeFailure: jest.fn().mockResolvedValue("analysis") };
    notificationService = {
      notifyFailureWithConfig: jest.fn().mockResolvedValue(undefined),
    };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    taskService = {
      trigger: jest.fn().mockResolvedValue(undefined),
      // BUG-21: 派发失败终态的事件发布出口（真实现由 processor 在终态落库后调用）
      publishTerminalEventForDispatch: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = makeDataSource();

    const module = await Test.createTestingModule({
      providers: [
        TaskProcessor,
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
        { provide: getRepositoryToken(Task), useValue: taskRepo },
        {
          provide: getRepositoryToken(ExecutionLogLine),
          useValue: logLineRepo,
        },
        { provide: ExecutorService, useValue: executorService },
        { provide: AiAnalysisService, useValue: aiService },
        { provide: NotificationService, useValue: notificationService },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue("") },
        },
        { provide: AuditService, useValue: auditService },
        { provide: TaskService, useValue: taskService },
        { provide: getQueueToken("task-queue"), useValue: { add: jest.fn() } },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    processor = module.get(TaskProcessor);
  });

  it("keeps execution RUNNING when dispatch is accepted", async () => {
    executorService.dispatch.mockResolvedValue({
      status: "accepted",
      executionId: "exec-1",
      executorAddress: "127.0.0.1:3105",
    });
    await processor.handle({ data: { executionId: "exec-1" } } as any);
    // The finally block persists worker-owned fields via a conditional QB
    // update inside a transaction — assert on that patch, not manager.save.
    const queryRunner = dataSource.createQueryRunner.mock.results[0].value;
    const qb = (queryRunner.manager.createQueryBuilder as jest.Mock).mock
      .results[0].value;
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
    const patch = qb.set.mock.calls[0][0];
    expect(patch.status).toBe(ExecutionStatus.RUNNING);
    expect(patch.endTime).toBeUndefined();
    const live = await execRepo.findOne.mock.results[0].value;
    expect(live.result).toMatchObject({ status: "accepted" });
  });

  it("marks execution FAILED and rethrows when dispatch fails", async () => {
    executorService.dispatch.mockRejectedValue(new Error("exec failed"));
    await expect(
      processor.handle({ data: { executionId: "exec-1" } } as any),
    ).rejects.toThrow("exec failed");
    // Failure state is mutated on the loaded execution and persisted by the
    // conditional update in finally — not via execRepo.save.
    const live = await execRepo.findOne.mock.results[0].value;
    expect(live.status).toBe(ExecutionStatus.FAILED);
    expect(live.failureReason).toBe(ExecutionFailureReason.UNKNOWN);
  });

  it("classifies dispatch failures before callback", async () => {
    executorService.dispatch.mockRejectedValue(
      new Error("npm install failed: dependency unavailable"),
    );
    await expect(
      processor.handle({ data: { executionId: "exec-1" } } as any),
    ).rejects.toThrow("npm install failed");
    const live = await execRepo.findOne.mock.results[0].value;
    expect(live.status).toBe(ExecutionStatus.FAILED);
    expect(live.failureReason).toBe(
      ExecutionFailureReason.PACKAGE_FETCH_FAILED,
    );
  });

  // BUG-21（nginx SSE 真机验证暴露）：派发阶段失败此前**不发领域事件**，
  // Dashboard 终态流 / FEAT-07 出站 webhook / notification 订阅者三方全漏。
  describe("BUG-21 派发失败终态的领域事件", () => {
    it("最后一次尝试（默认 attempts=1）→ 终态落库后发布事件，携带失败详情", async () => {
      executorService.dispatch.mockRejectedValue(new Error("exec failed"));

      await expect(
        processor.handle({ data: { executionId: "exec-1" } } as any),
      ).rejects.toThrow("exec failed");

      expect(taskService.publishTerminalEventForDispatch).toHaveBeenCalledTimes(
        1,
      );
      const [execArg, cbArg] =
        taskService.publishTerminalEventForDispatch.mock.calls[0];
      expect(execArg.status).toBe(ExecutionStatus.FAILED);
      expect(cbArg.errorMessage).toContain("exec failed");
      expect(cbArg.logs).toContain("exec failed");
    });

    it("非最后一次尝试 → 不发事件（等重试结果，避免告警/事件风暴）", async () => {
      executorService.dispatch.mockRejectedValue(new Error("exec failed"));

      await expect(
        processor.handle({
          data: { executionId: "exec-1" },
          attemptsMade: 0,
          opts: { attempts: 3 },
        } as any),
      ).rejects.toThrow("exec failed");

      expect(
        taskService.publishTerminalEventForDispatch,
      ).not.toHaveBeenCalled();
    });

    it("终态未落库（affected=0，被回调/杀掉抢先终态化）→ 不发事件（由赢家发布）", async () => {
      executorService.dispatch.mockRejectedValue(new Error("exec failed"));
      const queryRunner = dataSource.createQueryRunner.mock.results[0]?.value;
      if (queryRunner) {
        (
          queryRunner.manager.createQueryBuilder as jest.Mock
        ).mock.results[0].value.execute.mockResolvedValue({ affected: 0 });
      } else {
        // 首次调用发生在 handle 内部——预先钉死 execute 的返回
        (
          dataSource.createQueryRunner as unknown as jest.Mock
        ).mockImplementation(() => ({
          connect: jest.fn().mockResolvedValue(undefined),
          startTransaction: jest.fn().mockResolvedValue(undefined),
          commitTransaction: jest.fn().mockResolvedValue(undefined),
          rollbackTransaction: jest.fn().mockResolvedValue(undefined),
          release: jest.fn().mockResolvedValue(undefined),
          manager: {
            createQueryBuilder: jest.fn(() => ({
              update: jest.fn().mockReturnThis(),
              set: jest.fn().mockReturnThis(),
              where: jest.fn().mockReturnThis(),
              andWhere: jest.fn().mockReturnThis(),
              execute: jest.fn().mockResolvedValue({ affected: 0 }),
            })),
          },
        }));
      }

      await expect(
        processor.handle({ data: { executionId: "exec-1" } } as any),
      ).rejects.toThrow("exec failed");

      expect(
        taskService.publishTerminalEventForDispatch,
      ).not.toHaveBeenCalled();
    });
  });

  it("returns early if execution not found", async () => {
    execRepo.findOne.mockResolvedValue(null);
    await processor.handle({ data: { executionId: "missing" } } as any);
    expect(executorService.dispatch).not.toHaveBeenCalled();
  });

  it("marks FAILED if task not found", async () => {
    taskRepo.findOne.mockResolvedValue(null);
    await processor.handle({ data: { executionId: "exec-1" } } as any);
    const saved = execRepo.save.mock.calls.map((c: any) => c[0]);
    expect(saved.some((e: any) => e.status === ExecutionStatus.FAILED)).toBe(
      true,
    );
  });

  it("ERR-01: original error is not masked when transaction save fails", async () => {
    const originalError = new Error("dispatch failed");
    executorService.dispatch.mockRejectedValue(originalError);

    // Make the transactional conditional update throw to simulate DB failure
    // in finally. The repair runner shares this mock; its manager.findOne
    // returns null so repair is a no-op and the original error must surface.
    const qr = dataSource.createQueryRunner();
    (qr.manager.createQueryBuilder as jest.Mock).mockImplementation(() => ({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest
        .fn()
        .mockRejectedValue(new Error("database connection failed")),
    }));
    dataSource.createQueryRunner.mockReturnValue(qr);

    // The original dispatch error should still be thrown
    await expect(
      processor.handle({ data: { executionId: "exec-1" } } as any),
    ).rejects.toThrow("dispatch failed");
  });

  it("ERR-02: duration is 0 when startTime is null", async () => {
    const execWithoutStartTime = {
      id: "exec-2",
      taskId: "t1",
      status: ExecutionStatus.PENDING,
      params: {},
      startTime: null,
    } as unknown as TaskExecution;
    execRepo.findOne = jest.fn().mockResolvedValue(execWithoutStartTime);
    taskRepo.findOne.mockResolvedValue(null);

    await processor.handle({ data: { executionId: "exec-2" } } as any);

    // Task-not-found returns early before the finally block, so we just
    // verify no unhandled error was thrown and the execution was saved as FAILED.
    const saved = execRepo.save.mock.calls.map((c: any) => c[0]);
    expect(saved.some((e: any) => e.status === ExecutionStatus.FAILED)).toBe(
      true,
    );
  });

  // RETRY-01: task.retryableErrors drives whether a dispatch failure reaches
  // BullMQ retries or is classified UnrecoverableError (matching = a
  // case-insensitive substring of errorMessage / failureReason).
  it("retries (plain rethrow) when a non-timeout failure matches retryableErrors", async () => {
    taskRepo.findOne.mockResolvedValue({
      ...task,
      retryableErrors: ["network error"],
    });
    executorService.dispatch.mockRejectedValue(
      new Error("network error: socket hang up"),
    );
    // Must rethrow the ORIGINAL error (BullMQ retries), NOT an UnrecoverableError.
    await expect(
      processor.handle({ data: { executionId: "exec-1" } } as any),
    ).rejects.not.toBeInstanceOf(UnrecoverableError);
  });

  it("converts a non-matching failure to UnrecoverableError when retryableErrors is set", async () => {
    taskRepo.findOne.mockResolvedValue({
      ...task,
      retryableErrors: ["network"],
    });
    executorService.dispatch.mockRejectedValue(new Error("script exploded"));
    await expect(
      processor.handle({ data: { executionId: "exec-1" } } as any),
    ).rejects.toThrow(UnrecoverableError);
  });

  it("matches retryableErrors case-insensitively (configured uppercase vs lowercase message)", async () => {
    taskRepo.findOne.mockResolvedValue({
      ...task,
      retryableErrors: ["Network Error"],
    });
    executorService.dispatch.mockRejectedValue(
      new Error("socket: network error on connect"),
    );
    await expect(
      processor.handle({ data: { executionId: "exec-1" } } as any),
    ).rejects.not.toBeInstanceOf(UnrecoverableError);
  });

  it("matches retryableErrors against failureReason (secondary), not just the message", async () => {
    taskRepo.findOne.mockResolvedValue({
      ...task,
      retryableErrors: ["package_fetch_failed"],
    });
    // "npm install" classifies the failure as PACKAGE_FETCH_FAILED, but the
    // message text does NOT contain the token "package_fetch_failed" — only the
    // secondary failureReason key can match, so a retry proves secondary match.
    executorService.dispatch.mockRejectedValue(
      new Error("npm install exploded in the venv"),
    );
    await expect(
      processor.handle({ data: { executionId: "exec-1" } } as any),
    ).rejects.not.toBeInstanceOf(UnrecoverableError);
  });

  it("retryableErrors empty array keeps legacy retry-everything behavior", async () => {
    taskRepo.findOne.mockResolvedValue({ ...task, retryableErrors: [] });
    executorService.dispatch.mockRejectedValue(new Error("script exploded"));
    await expect(
      processor.handle({ data: { executionId: "exec-1" } } as any),
    ).rejects.not.toBeInstanceOf(UnrecoverableError);
  });

  it("retryableErrors null keeps legacy retry-everything behavior", async () => {
    taskRepo.findOne.mockResolvedValue({ ...task, retryableErrors: null });
    executorService.dispatch.mockRejectedValue(new Error("script exploded"));
    await expect(
      processor.handle({ data: { executionId: "exec-1" } } as any),
    ).rejects.not.toBeInstanceOf(UnrecoverableError);
  });

  it("TIMEOUT is never retried regardless of retryableErrors (double-dispatch guard)", async () => {
    taskRepo.findOne.mockResolvedValue({
      ...task,
      retryableErrors: ["timeout"],
    });
    executorService.dispatch.mockRejectedValue(
      new Error("execution timed out"),
    );
    await expect(
      processor.handle({ data: { executionId: "exec-1" } } as any),
    ).rejects.toThrow(UnrecoverableError);
  });

  // REPAIR-01: when the primary conditional update throws (DB failure) and the
  // repair branch runs, the repair must be a conditional UPDATE guarded by
  // `status IN (pending, running)` — not findOne→save — so a concurrent callback
  // that already wrote a terminal state is never overwritten.
  it("repair uses a conditional UPDATE and never overwrites a terminal state written concurrently", async () => {
    const repairLog = jest
      .spyOn((processor as any).logger, "log")
      .mockImplementation(() => undefined);
    executorService.dispatch.mockRejectedValue(new Error("dispatch failed"));

    // Fresh runner: primary QB write throws → rollback → repair path runs.
    const makeRunner = () => ({
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      manager: {
        // Old code repaired via save(); the new atomic path must NOT.
        save: jest.fn((e: any) => Promise.resolve(e)),
        findOne: jest.fn().mockResolvedValue({
          id: "exec-1",
          // Concurrent callback flipped the row to a terminal state.
          status: ExecutionStatus.SUCCESS,
        }),
        // No-op: primary throws to trigger repair; repair resolves with
        // affected=0 (status guard matched no row).
        createQueryBuilder: jest.fn(() => ({
          update: jest.fn().mockReturnThis(),
          set: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue({ affected: 0 }),
        })),
      },
    });
    let n = 0;
    dataSource.createQueryRunner.mockImplementation(() => {
      const r = makeRunner();
      if (n++ === 0) {
        r.manager.createQueryBuilder = jest.fn(() => ({
          update: jest.fn().mockReturnThis(),
          set: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          execute: jest.fn().mockRejectedValue(new Error("db down")),
        }));
      }
      return r;
    });

    await expect(
      processor.handle({ data: { executionId: "exec-1" } } as any),
    ).rejects.toThrow("dispatch failed");

    const repairRunner = dataSource.createQueryRunner.mock.results[1].value;
    // Repair wrote via a conditional UPDATE (status guard), not findOne→save.
    expect(repairRunner.manager.findOne).not.toHaveBeenCalled();
    expect(repairRunner.manager.save).not.toHaveBeenCalled();
    const repairQB = (repairRunner.manager.createQueryBuilder as jest.Mock).mock
      .results[0].value;
    expect(repairQB.update).toHaveBeenCalled();
    const andWhereCalls = (repairQB.andWhere as jest.Mock).mock.calls.map(
      (c: any) => String(c[0]),
    );
    expect(andWhereCalls.some((s: string) => s.includes("status IN"))).toBe(
      true,
    );
    // affected=0 → nothing was clobbered, no "Repaired" log.
    expect(
      repairLog.mock.calls.some((c: any) => /Repaired/.test(String(c[0]))),
    ).toBe(false);
  });

  // CONSISTENCY-01: a stalled BullMQ redelivery must not re-claim a row that is
  // still RUNNING. The claim UPDATE now only accepts pending/failed, so the
  // redelivered job's claim affects 0 rows and handle() returns idle without a
  // second dispatch — preventing two live copies of one executionId.
  it("does not re-claim a RUNNING row: claimable set excludes RUNNING", async () => {
    // Simulate the real DB: the row is RUNNING, so the guarded claim UPDATE
    // (`status IN (:...claimable)`) matches nothing → affected=0.
    execRepo.findOne = jest
      .fn()
      .mockResolvedValue({ ...exec, status: ExecutionStatus.RUNNING });
    execRepo.createQueryBuilder = jest.fn(() => ({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    }));
    executorService.dispatch.mockResolvedValue({ status: "accepted" });

    await processor.handle({ data: { executionId: "exec-1" } } as any);

    const claimQb = (execRepo.createQueryBuilder as jest.Mock).mock.results[0]
      .value;
    const claimable = (claimQb.andWhere as jest.Mock).mock.calls
      .map((c: any) => c)
      .find((c: any) => String(c[0]).includes("status IN"))?.[1]?.claimable as
      string[] | undefined;
    expect(claimable).toBeDefined();
    expect(claimable).toContain(ExecutionStatus.PENDING);
    expect(claimable).toContain(ExecutionStatus.FAILED);
    expect(claimable).not.toContain(ExecutionStatus.RUNNING);
    // The RUNNING row was not claimable → no dispatch, idle return, and the
    // finally-block transaction is never opened (no worker-owned overwrite).
    expect(executorService.dispatch).not.toHaveBeenCalled();
    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
  });

  it("still claims a FAILED row (BullMQ retry path preserved)", async () => {
    execRepo.findOne = jest
      .fn()
      .mockResolvedValue({ ...exec, status: ExecutionStatus.FAILED });
    executorService.dispatch.mockResolvedValue({ status: "accepted" });

    await processor.handle({ data: { executionId: "exec-1" } } as any);

    expect(executorService.dispatch).toHaveBeenCalled();
  });
});

// PERF-P3a: worker 并发配置断言。@nestjs/bullmq v11 的 @Processor 装饰器把
// 第一参数（队列名等 ProcessorOptions）写入 'bullmq:processor_metadata'，
// 第二参数（NestWorkerOptions，bull.explorer 直接展开进 Worker 构造函数）
// 写入 'bullmq:worker_metadata'。concurrency 只认第二参数——若误写成
// @Processor({ name, concurrency }) 单对象形式，worker_metadata 会是空对象，
// 本断言即失败。
describe("TaskProcessor worker metadata (PERF-P3a)", () => {
  it("subscribes to task-queue", () => {
    expect(
      Reflect.getMetadata("bullmq:processor_metadata", TaskProcessor),
    ).toMatchObject({ name: "task-queue" });
  });

  it("runs the worker with concurrency 5", () => {
    expect(
      Reflect.getMetadata("bullmq:worker_metadata", TaskProcessor),
    ).toEqual({ concurrency: 5 });
  });
});
