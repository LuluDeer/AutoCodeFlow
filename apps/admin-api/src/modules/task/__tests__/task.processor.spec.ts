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
import {
  Task,
  TaskStatus,
} from "../entities/task.entity";
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
    // A1: transitionOneToTerminal 链携带 RETURNING；mock 需可链式。
    returning: jest.fn().mockReturnThis(),
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
        // A1: transitionOneToTerminal 链携带 RETURNING；mock 需可链式。
        returning: jest.fn().mockReturnThis(),
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
    // B-11: claim 前的任务状态闸——既有用例默认 ACTIVE（闸放行）。
    status: TaskStatus.ACTIVE,
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

  // E-P2-R5: 旧实现 dispatch 后立即 execRepo.update(id, {executorAddress})——
  // 该 update 不在事务内，与 finally 的终态写之间是非原子窗口。本用例断言：
  // ①不再单独 update executorAddress；②executorAddress 进入 finally 的条件
  // UPDATE patch（ownedPatch 已有条件判断）。旧实现 execRepo.update 会被调用
  // → 断言①红。
  it("E-P2-R5: persists executorAddress in the transactional patch, not via a separate out-of-tx update", async () => {
    executorService.dispatch.mockImplementation(async (_task, target: any) => {
      // 真实现 dispatch 通过入参引用把 executorAddress 写到执行行（executor.service）。
      target.executorAddress = "127.0.0.1:3105";
      return {
        status: "accepted",
        executionId: "exec-1",
        executorAddress: "127.0.0.1:3105",
      };
    });
    await processor.handle({ data: { executionId: "exec-1" } } as any);

    expect(execRepo.update).not.toHaveBeenCalled();
    const queryRunner = dataSource.createQueryRunner.mock.results[0].value;
    const qb = (queryRunner.manager.createQueryBuilder as jest.Mock).mock
      .results[0].value;
    const patch = qb.set.mock.calls[0][0];
    expect(patch.executorAddress).toBe("127.0.0.1:3105");
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

  // R-13（DEEP_REVIEW 0ef3bbe）: finally 里 connect()/startTransaction() 此前在
  // try 外——失败时 queryRunner 从不 release（连接泄漏），且抛出的新异常会替换
  // 触发 finally 的原始 dispatch 错误。钉住：connect 失败仍 release 连接，且原始
  // 错误（而非 connect 错误）向上抛出。
  it("R-13: connect() failure releases the connection and preserves the original error", async () => {
    executorService.dispatch.mockRejectedValue(new Error("dispatch failed"));
    const qr = {
      connect: jest.fn().mockRejectedValue(new Error("connect failed")),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn().mockResolvedValue(undefined),
      manager: {
        createQueryBuilder: jest.fn(() => ({
          update: jest.fn().mockReturnThis(),
          set: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue({ affected: 1 }),
        })),
      },
    };
    dataSource.createQueryRunner.mockReturnValue(qr as any);

    // 原始 dispatch 错误必须仍是向上抛出的异常——不能被 "connect failed" 替换
    await expect(
      processor.handle({ data: { executionId: "exec-1" } } as any),
    ).rejects.toThrow("dispatch failed");
    // 连接被释放（无泄漏）；connect 在 startTransaction 之前就失败
    expect(qr.release).toHaveBeenCalled();
    expect(qr.startTransaction).not.toHaveBeenCalled();
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

  // F-01（本轮审计）：interpreter_unavailable 必须排在分类链最前面——堆栈含
  // `ExecutorService.failInterpreterUnavailable`，旧的 /executor.*(offline|unavailable)/
  // 会从 `ExecutorService...Unavailable` 命中并误判成 EXECUTOR_OFFLINE。修复后：
  // ① failureReason=interpreter_unavailable；② D14 不可重试 → UnrecoverableError。
  it("classifies interpreter_unavailable before the executor-offline rule (F-01, D14)", async () => {
    executorService.dispatch.mockRejectedValue(
      new Error(
        "[interpreter_unavailable] 解释器 3.7 无法获取（缓存缺失 + 下载失败：无在线执行器缓存该版本）",
      ),
    );
    await expect(
      processor.handle({ data: { executionId: "exec-1" } } as any),
    ).rejects.toThrow(UnrecoverableError);
    const live = await execRepo.findOne.mock.results[0].value;
    expect(live.status).toBe(ExecutionStatus.FAILED);
    expect(live.failureReason).toBe(
      ExecutionFailureReason.INTERPRETER_UNAVAILABLE,
    );
  });

  it("TIMEOUT stays classified as TIMEOUT even when the stack mentions interpreter (F-01 order)", async () => {
    // 反例保护：解释器下载超时文案含 timeout，但解释器词+失败词相邻才命中
    // INTERPRETER_UNAVAILABLE_PATTERN；纯超时不得被新规则吞掉。
    executorService.dispatch.mockRejectedValue(
      new Error("execution timed out after 300s"),
    );
    await expect(
      processor.handle({ data: { executionId: "exec-1" } } as any),
    ).rejects.toThrow(UnrecoverableError);
    const live = await execRepo.findOne.mock.results[0].value;
    expect(live.failureReason).toBe(ExecutionFailureReason.TIMEOUT);
    expect(live.status).toBe(ExecutionStatus.TIMEOUT);
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
    // A1: task-not-found 终态写走 transitionOneToTerminal（createQueryBuilder 链），
    // 不再经 execRepo.save。断言条件 UPDATE 的 patch 携带 FAILED。
    const qb = (execRepo.createQueryBuilder as jest.Mock).mock.results[0].value;
    const patch = qb.set.mock.calls[0][0];
    expect(patch.status).toBe(ExecutionStatus.FAILED);
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
    // verify no unhandled error was thrown and the execution was written as
    // FAILED via the terminal-transition gate (A1: createQueryBuilder 链).
    const qb = (execRepo.createQueryBuilder as jest.Mock).mock.results[0].value;
    const patch = qb.set.mock.calls[0][0];
    expect(patch.status).toBe(ExecutionStatus.FAILED);
    expect(patch.duration).toBe(0);
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
    // E-P2-R2: 修复成功的 "Repaired" 信号已从 log 升到 warn——同时钉住两级，
    // 确保 affected=0 时两级都不会打出 "Repaired"。
    const repairWarn = jest
      .spyOn((processor as any).logger, "warn")
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
          // A1: transitionOneToTerminal 链携带 RETURNING；mock 需可链式。
          returning: jest.fn().mockReturnThis(),
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
          returning: jest.fn().mockReturnThis(),
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
    // A1: transitionOneToTerminal 把状态门槛写在 .where()（而非 .andWhere()）。
    // WHERE 子句形如 '"id" IN (...) AND "status" IN (...)'——"status" 带引号。
    const whereCalls = (repairQB.where as jest.Mock).mock.calls.map((c: any) =>
      String(c[0]),
    );
    expect(
      whereCalls.some(
        (s: string) => s.includes('"status" IN') || s.includes("status IN"),
      ),
    ).toBe(true);
    // affected=0 → nothing was clobbered, no "Repaired" log/warn.
    expect(
      repairLog.mock.calls.some((c: any) => /Repaired/.test(String(c[0]))),
    ).toBe(false);
    expect(
      repairWarn.mock.calls.some((c: any) => /Repaired/.test(String(c[0]))),
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
      returning: jest.fn().mockReturnThis(),
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

  // ── MUTEX-01：互斥排队态（waiting）────────────────────────────────────────
  //
  // 唤醒路径依赖「WAITING 可被 claim」：15s 唤醒 sweep 把 WAITING 翻回 PENDING
  // 后重新入队，若竞态下行仍是 WAITING（并发唤醒/手动路径），claim 也必须放行，
  // 否则唤醒 job 永远空转、执行永久排队。
  it("claims a WAITING row so the mutex wake sweep can re-dispatch it (MUTEX-01)", async () => {
    execRepo.findOne = jest
      .fn()
      .mockResolvedValue({ ...exec, status: ExecutionStatus.WAITING });
    executorService.dispatch.mockResolvedValue({ status: "accepted" });

    await processor.handle({ data: { executionId: "exec-1" } } as any);

    const claimQb = (execRepo.createQueryBuilder as jest.Mock).mock.results[0]
      .value;
    const claimable = (claimQb.andWhere as jest.Mock).mock.calls
      .map((c: any) => c)
      .find((c: any) => String(c[0]).includes("status IN"))?.[1]?.claimable as
      string[] | undefined;
    expect(claimable).toContain(ExecutionStatus.WAITING);
    expect(claimable).not.toContain(ExecutionStatus.RUNNING);
    // WAITING 行被 claim（affected=1）→ dispatch 真正发生。
    expect(executorService.dispatch).toHaveBeenCalledTimes(1);
  });

  // 互斥阻塞不是失败：processor 识别 `[mutex_wait]` 前缀后把执行置 WAITING 并
  // **正常结束 job**（不 rethrow → 不烧 BullMQ 重试预算），失败分类/AI 分析/
  // 终态事件全链路不触发；错误文本剥掉 token 后作为排队原因写入 errorMessage。
  it("mutex-wait dispatch failure parks the execution in WAITING without rethrow (MUTEX-01)", async () => {
    executorService.dispatch.mockRejectedValue(
      new Error(
        '[mutex_wait]任务 "ziniao-app" 的所有候选设备上互斥组占用已满，执行进入排队等待',
      ),
    );

    // 不 reject —— job 正常完成，执行保持打开态等待唤醒。
    await expect(
      processor.handle({ data: { executionId: "exec-1" } } as any),
    ).resolves.toBeUndefined();

    // 落库面：finally 的非终态条件 UPDATE 带着WAITING 状态 + 清空的
    // failureReason + 剥掉 token 的排队原因。
    const persistedPatch = (
      dataSource.createQueryRunner as jest.Mock
    ).mock.results
      .map((r) => r.value)
      .map((qr) => qr.manager.createQueryBuilder.mock.results[0]?.value)
      .filter(Boolean)
      .map((qb) => (qb.set as jest.Mock).mock.calls[0]?.[0])
      .find((patch) => patch && typeof patch === "object") as
      Record<string, unknown> | undefined;
    expect(persistedPatch).toBeDefined();
    expect(persistedPatch!.status).toBe(ExecutionStatus.WAITING);
    expect(persistedPatch!.failureReason).toBeNull();
    expect(String(persistedPatch!.errorMessage)).not.toContain("[mutex_wait]");
    expect(String(persistedPatch!.errorMessage)).toContain("互斥组占用已满");

    // 不是失败：无终态事件、无 AI 分析、无失败通知。
    expect(taskService.publishTerminalEventForDispatch).not.toHaveBeenCalled();
    expect(aiService.analyzeFailure).not.toHaveBeenCalled();
  });

  // MUTEX-01 P3：互斥排队的执行被唤醒后，dispatch 因「无可用/离线执行器」失败
  // 时与组满路径同策——回 WAITING 等下轮唤醒，不进 BullMQ 重试链烧预算。
  it("mutex-grouped execution whose dispatch fails with no-executor-available goes back to WAITING (MUTEX-01 P3)", async () => {
    execRepo.findOne = jest
      .fn()
      .mockResolvedValue({ ...exec, mutexGroupId: "group-1" });
    executorService.dispatch.mockRejectedValue(
      new Error(
        "No available executor (all candidates are offline or at capacity)",
      ),
    );

    // 不 reject —— job 正常完成，执行回 WAITING。
    await expect(
      processor.handle({ data: { executionId: "exec-1" } } as any),
    ).resolves.toBeUndefined();

    const persistedPatch = (
      dataSource.createQueryRunner as jest.Mock
    ).mock.results
      .map((r) => r.value)
      .map((qr) => qr.manager.createQueryBuilder.mock.results[0]?.value)
      .filter(Boolean)
      .map((qb) => (qb.set as jest.Mock).mock.calls[0]?.[0])
      .find((patch) => patch && typeof patch === "object") as
      Record<string, unknown> | undefined;
    expect(persistedPatch).toBeDefined();
    expect(persistedPatch!.status).toBe(ExecutionStatus.WAITING);
    expect(persistedPatch!.failureReason).toBeNull();
    expect(String(persistedPatch!.errorMessage)).toContain(
      "No available executor",
    );

    // 排队不是失败：无终态事件、无 AI 分析。
    expect(taskService.publishTerminalEventForDispatch).not.toHaveBeenCalled();
    expect(aiService.analyzeFailure).not.toHaveBeenCalled();
  });

  // 「No online executors ...」消息族在分类链落 UNKNOWN——互斥回队判定必须
  // 连它一起收，否则整机队下线时被唤醒的执行仍烧重试预算。
  it("mutex-grouped execution whose dispatch fails with no-online-executors also goes back to WAITING (MUTEX-01 P3)", async () => {
    execRepo.findOne = jest
      .fn()
      .mockResolvedValue({ ...exec, mutexGroupId: "group-1" });
    executorService.dispatch.mockRejectedValue(
      new Error("No online executors match the requested group/tags/runtime"),
    );

    await expect(
      processor.handle({ data: { executionId: "exec-1" } } as any),
    ).resolves.toBeUndefined();

    const persistedPatch = (
      dataSource.createQueryRunner as jest.Mock
    ).mock.results
      .map((r) => r.value)
      .map((qr) => qr.manager.createQueryBuilder.mock.results[0]?.value)
      .filter(Boolean)
      .map((qb) => (qb.set as jest.Mock).mock.calls[0]?.[0])
      .find((patch) => patch && typeof patch === "object") as
      Record<string, unknown> | undefined;
    expect(persistedPatch!.status).toBe(ExecutionStatus.WAITING);
  });

  // 负例：无组快照的执行维持既有失败语义（FAILED + rethrow 进重试链）。
  it("non-grouped execution keeps the legacy FAILED + rethrow path for the same failure", async () => {
    executorService.dispatch.mockRejectedValue(
      new Error(
        "No available executor (all candidates are offline or at capacity)",
      ),
    );

    await expect(
      processor.handle({ data: { executionId: "exec-1" } } as any),
    ).rejects.toThrow("No available executor");

    const live = await execRepo.findOne.mock.results[0].value;
    expect(live.status).toBe(ExecutionStatus.FAILED);
  });

  // ── B-11（调度域审计）：PAUSED/非 ACTIVE 任务的未派发排队执行不 claim ──
  describe("B-11: non-ACTIVE task claim gate", () => {
    it("PAUSED task's queued PENDING execution is not claimed nor dispatched", async () => {
      taskRepo.findOne.mockResolvedValue({
        ...task,
        status: TaskStatus.PAUSED,
      });
      execRepo.findOne = jest
        .fn()
        .mockResolvedValue({ ...exec, status: ExecutionStatus.PENDING });

      await processor.handle({ data: { executionId: "exec-1" } } as any);

      // 不派发：executorService.dispatch 零调用；claim 的条件 UPDATE 也未发。
      expect(executorService.dispatch).not.toHaveBeenCalled();
      expect(execRepo.createQueryBuilder).not.toHaveBeenCalled();
      // 行保持 PENDING（不写 RUNNING、不终态化）。
      const live = await execRepo.findOne.mock.results[0].value;
      expect(live.status).toBe(ExecutionStatus.PENDING);
    });

    it("PAUSED task's WAITING execution is not claimed (stale wake job is a no-op)", async () => {
      taskRepo.findOne.mockResolvedValue({
        ...task,
        status: TaskStatus.PAUSED,
      });
      execRepo.findOne = jest
        .fn()
        .mockResolvedValue({ ...exec, status: ExecutionStatus.WAITING });

      await processor.handle({ data: { executionId: "exec-1" } } as any);

      expect(executorService.dispatch).not.toHaveBeenCalled();
      const live = await execRepo.findOne.mock.results[0].value;
      expect(live.status).toBe(ExecutionStatus.WAITING);
    });

    it("PAUSED task's FAILED execution is still claimable (retry budget preserved)", async () => {
      taskRepo.findOne.mockResolvedValue({
        ...task,
        status: TaskStatus.PAUSED,
      });
      execRepo.findOne = jest
        .fn()
        .mockResolvedValue({ ...exec, status: ExecutionStatus.FAILED });
      executorService.dispatch.mockResolvedValue({
        status: "accepted",
        executionId: "exec-1",
        executorAddress: "127.0.0.1:3105",
      });

      await processor.handle({ data: { executionId: "exec-1" } } as any);

      // 重试语义不受暂停影响：FAILED 行照常 claim 并派发。
      expect(executorService.dispatch).toHaveBeenCalledTimes(1);
    });

    it("ACTIVE task's queued execution claims and dispatches normally (regression guard)", async () => {
      executorService.dispatch.mockResolvedValue({
        status: "accepted",
        executionId: "exec-1",
        executorAddress: "127.0.0.1:3105",
      });

      await processor.handle({ data: { executionId: "exec-1" } } as any);

      expect(executorService.dispatch).toHaveBeenCalledTimes(1);
    });
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
