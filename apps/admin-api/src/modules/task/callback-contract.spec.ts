import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { ParseArrayPipe } from "@nestjs/common";

import { ExecutionCallback } from "./execution-callback.collaborator";
import type { ExecutionCallbackDeps } from "./execution-callback.collaborator";
import { transitionToTerminal } from "./execution-terminal";
import { CallbackItemDto } from "./dto/execution-callback.dto";
import {
  ExecutionStatus,
  FAILED_EXECUTION_STATUSES,
  type TaskExecution,
} from "./entities/task-execution.entity";

jest.mock("./execution-terminal", () => ({
  ...jest.requireActual("./execution-terminal"),
  transitionToTerminal: jest.fn(),
}));

const transitionMock = transitionToTerminal as jest.Mock;
const EXEC_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function makeDeps(overrides: Partial<ExecutionCallbackDeps> = {}): any {
  return {
    execRepo: { findOne: jest.fn(), find: jest.fn() },
    taskRepo: { findOne: jest.fn(), find: jest.fn() },
    artifactIndexRepo: null,
    dataSource: {},
    eventBus: null,
    aiAnalysisService: { analyzeFailure: jest.fn() },
    logger: {
      warn: jest.fn(),
      debug: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
    },
    redisLockService: null,
    executorService: { scheduleRetryAfterRecovery: jest.fn() },
    releaseSlot: jest.fn().mockResolvedValue(undefined),
    releaseBroadcastSlot: jest.fn().mockResolvedValue(undefined),
    storeLogLines: jest.fn().mockResolvedValue(undefined),
    persistCallbackLogsIfMissing: jest.fn().mockResolvedValue(undefined),
    backfillFullLogsFromExecutor: jest.fn().mockResolvedValue(false),
    hasStreamedLogLines: jest.fn().mockResolvedValue(false),
    emitTerminalEvent: jest.fn(),
    publishExecutionWake: jest.fn(),
    triggerDependentTasks: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeExecution(patch: Partial<TaskExecution> = {}): TaskExecution {
  return {
    id: EXEC_ID,
    taskId: "task-1",
    taskName: "callback-fixture",
    status: ExecutionStatus.RUNNING,
    executorAddress: "addr-1",
    executorId: null,
    attemptSeq: 2,
    executeMode: "single",
    isBroadcast: false,
    startTime: new Date(Date.now() - 1000),
    ...patch,
  } as unknown as TaskExecution;
}

/** 让终态 UPDATE 落空（重复/迟到回调分支），避免进入需要更多 deps 的 winner 分支。 */
function setupNoWinner(execution: TaskExecution) {
  const deps = makeDeps();
  // 第一次 findOne 取 execution（handleCallback 入口），第二次是 affected=0
  // 后的 fresh 复核；返回 null 让它落在「重复/迟到」分支而不进入 winner 分支。
  deps.execRepo.findOne
    .mockResolvedValueOnce(execution)
    .mockResolvedValueOnce(null);
  transitionMock.mockResolvedValue({
    affected: 0,
    rows: [],
    transitioned: false,
  });
  return { deps, run: (cb: any) => new ExecutionCallback(deps).handleCallback([cb]) };
}

beforeEach(() => {
  transitionMock.mockReset();
});

describe("callback-attemptSeq：执行快照驱动的世代闭合", () => {
  it("迟到回调携带旧 attemptSeq —— 世代门禁用回调值，不污染新 attempt", async () => {
    const { run } = setupNoWinner(makeExecution({ attemptSeq: 2 }));
    await run({
      executionId: EXEC_ID,
      status: "success",
      executorAddress: "addr-1",
      attemptSeq: 1,
    });

    expect(transitionMock).toHaveBeenCalledTimes(1);
    expect(transitionMock.mock.calls[0][1].expectedAttemptSeq).toBe(1);
    expect(transitionMock.mock.calls[0][1].expectedAttemptSeq).not.toBe(2);
  });

  it("旧执行器不带 attemptSeq —— 回退服务端快照（兼容策略）", async () => {
    const { run } = setupNoWinner(makeExecution({ attemptSeq: 2 }));
    await run({
      executionId: EXEC_ID,
      status: "success",
      executorAddress: "addr-1",
    });

    expect(transitionMock.mock.calls[0][1].expectedAttemptSeq).toBe(2);
  });

  it.each([
    ["字符串世代", "1"],
    ["负数", -1],
    ["NaN", Number.NaN],
    ["null", null],
  ])("畸形 attemptSeq（%s）按缺省回退快照，绝不编造 0", async (_label, bad) => {
    const { run } = setupNoWinner(makeExecution({ attemptSeq: 2 }));
    await run({
      executionId: EXEC_ID,
      status: "success",
      executorAddress: "addr-1",
      attemptSeq: bad,
    });

    expect(transitionMock.mock.calls[0][1].expectedAttemptSeq).toBe(2);
  });

  it("快照也读不到时不传世代谓词（undefined，与引入前逐字节一致）", async () => {
    const { run } = setupNoWinner(
      makeExecution({ attemptSeq: undefined as unknown as number }),
    );
    await run({
      executionId: EXEC_ID,
      status: "success",
      executorAddress: "addr-1",
    });

    expect(transitionMock.mock.calls[0][1].expectedAttemptSeq).toBeUndefined();
  });
});

describe("callback-broadcast：槽位释放只读执行快照", () => {
  it("任务中途改成 single 时，历史广播执行仍逐执行器释放广播坑", async () => {
    const deps = makeDeps();
    // 执行行快照：广播；任务当前值：single（与快照相反，用来证明不读当前值）。
    deps.execRepo.findOne.mockResolvedValue(
      makeExecution({
        executorAddress: null,
        executeMode: "single",
        isBroadcast: true,
        attemptSeq: 1,
      }),
    );
    deps.taskRepo.findOne.mockResolvedValue({ executeMode: "single" });
    transitionMock.mockResolvedValue({
      affected: 1,
      rows: [{ id: EXEC_ID, executorAddress: null }],
      transitioned: true,
    });

    await new ExecutionCallback(deps).handleCallback([
      {
        executionId: EXEC_ID,
        status: "success",
        executorAddress: "executor-A",
        attemptSeq: 1,
      },
    ]);

    expect(deps.releaseBroadcastSlot).toHaveBeenCalledTimes(1);
    expect(deps.releaseBroadcastSlot).toHaveBeenCalledWith("executor-A");
    // 广播判定不再查 taskRepo：查了就可能随任务当前配置漂移。
    expect(deps.taskRepo.findOne).not.toHaveBeenCalled();
  });

  it("快照缺失（存量行）按非广播处理，绝不读任务当前 executeMode", async () => {
    const deps = makeDeps();
    deps.execRepo.findOne.mockResolvedValue(
      makeExecution({
        executorAddress: null,
        executeMode: null,
        isBroadcast: null,
        attemptSeq: 1,
      }),
    );
    deps.taskRepo.findOne.mockResolvedValue({ executeMode: "broadcast" });
    transitionMock.mockResolvedValue({
      affected: 1,
      rows: [{ id: EXEC_ID, executorAddress: null }],
      transitioned: true,
    });

    await new ExecutionCallback(deps).handleCallback([
      {
        executionId: EXEC_ID,
        status: "success",
        executorAddress: "executor-A",
        attemptSeq: 1,
      },
    ]);

    expect(deps.releaseBroadcastSlot).not.toHaveBeenCalled();
  });
});

describe("callback-contract：字段漂移 fail-fast", () => {
  const pipe = () =>
    new ParseArrayPipe({
      items: CallbackItemDto,
      whitelist: true,
      forbidNonWhitelisted: true,
    });
  const metadata = { type: "body", metatype: Array } as any;

  it("协议字段（attemptSeq / traceparent）被接受，不被静默剥离", async () => {
    const result = await pipe().transform(
      [
        {
          executionId: EXEC_ID,
          status: "success",
          attemptSeq: 7,
          traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
        },
      ],
      metadata,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ attemptSeq: 7 });
  });

  it("未知字段整批 400（不再静默吞掉）", async () => {
    await expect(
      pipe().transform(
        [
          {
            executionId: EXEC_ID,
            status: "success",
            newlyAddedByExecutor: "value",
          },
        ],
        metadata,
      ),
    ).rejects.toThrow();
  });

  it("静态守卫可执行：protocol.CallbackPayload ⊆ DTO 字段", () => {
    let root = __dirname;
    for (let i = 0; i < 12; i++) {
      if (
        existsSync(
          join(root, "packages", "executor-protocol", "protocol.json"),
        )
      )
        break;
      root = dirname(root);
    }
    const out = execFileSync(
      "node",
      [join(root, "scripts", "check-callback-contract-drift.mjs")],
      { encoding: "utf8" },
    );
    expect(out).toContain("callback contract ok");
  });
});

describe("callback-timeout：sweep 与回调终态口径一致【静态守卫级】", () => {
  it("失败状态全集同时含 FAILED 与 TIMEOUT（趋势读面不会漏 TIMEOUT）", () => {
    expect(FAILED_EXECUTION_STATUSES).toEqual([
      ExecutionStatus.FAILED,
      ExecutionStatus.TIMEOUT,
    ]);
  });

  it("stale sweep 超时桶落 TIMEOUT + failureReason=TIMEOUT，回调同口径", () => {
    const scheduler = readFileSync(
      join(__dirname, "../scheduler/scheduler.service.ts"),
      "utf8",
    );
    const start = scheduler.indexOf("for (const [timeoutSec, execs] of timedOut)");
    const end = scheduler.indexOf("// P2: 本桶是 sweep", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = scheduler.slice(start, end);
    expect(block).toContain("status: ExecutionStatus.TIMEOUT");
    expect(block).toContain("failureReason: ExecutionFailureReason.TIMEOUT");
    expect(block).not.toContain("status: ExecutionStatus.FAILED");

    const callback = readFileSync(
      join(__dirname, "execution-callback.collaborator.ts"),
      "utf8",
    );
    expect(callback).toMatch(
      /failureReason === ExecutionFailureReason\.TIMEOUT[\s\S]{0,160}ExecutionStatus\.TIMEOUT/,
    );
  });
});
