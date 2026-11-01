import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { getQueueToken } from "@nestjs/bullmq";
import { TaskProcessor } from "../task.processor";
import {
  ExecutionStatus,
  TaskExecution,
} from "../entities/task-execution.entity";
import { ExecutionLogLine } from "../entities/execution-log-line.entity";
import { Task, TaskStatus } from "../entities/task.entity";
import { ExecutorService } from "../../executor/executor.service";
import { AiAnalysisService } from "../../ai/ai-analysis.service";
import { TaskService } from "../task.service";

/**
 * G3（迁移 1790000000092）· **两条低成本遗留**的定向用例。
 *
 * ## 遗留 ① —— `readClaimedAttemptSeq` 的「RETURNING 缺行 ⇒ 紧随一次 SELECT」
 *
 * claim 语句是 `UPDATE … RETURNING "attemptSeq"`。PG 回行，但**部分驱动不返回行**
 * （只回 `{affected}`），替身也常这样。那种情况下生产代码紧跟一次 `SELECT` 取当前
 * 世代；仍读不到返回 `null`（「不知道」），**不编 0**（0 是合法的第一回合）。
 *
 * 此前所有 spec 的替身恒返回 `raw`，所以「RETURNING 缺行 → SELECT」这一支**从未
 * 被执行过**——那段代码删掉，测试照样绿。本节因此不止断言返回值，还断言
 * **findOne 被调用了几次**：多查一次（每次都白跑一条 SQL）与少查一次（拿不到世代）
 * 都是缺陷，但只看返回值两种都测不出来。
 *
 * ## 遗留 ② —— processor 自己的 dispatch 失败终态写要带世代
 *
 * 上一轮只给**回调路径**的终态写传了 `expectedAttemptSeq`，processor 的**派发失败**
 * 路径没传 ⇒ 陈旧 worker 的终态写仍不受世代保护（与回调路径不同口径）。本节钉住：
 * 世代已知 ⇒ 终态写带谓词且**真的按世代筛行**；世代未知（null）⇒ 谓词整段不拼，
 * whereSql / params 与引入前**逐字节**一致。
 *
 * ## 替身为什么必须**真的**应用谓词
 *
 * 若终态写替身只回固定的 `{affected: 1}`，那么「陈旧 worker 被拒」这件事根本测不到
 * ——把生产代码里的 `expectedAttemptSeq` 删掉，用例照样绿。故 `makeGate` 的 `execute`
 * **按 whereSql 里实际出现的谓词**筛行（`whereSql.includes('"attemptSeq"')` 才比世代），
 * 绿/红由「生产代码有没有把谓词拼上去」决定（与 `execution-attempt-seq.spec.ts`
 * 的 `makeGateRepo` 同款纪律）。
 */

// ─────────────────────────── 替身：claim 的 RETURNING + SELECT 兜底 ───────────────────────────

interface ExecRow {
  id: string;
  taskId: string;
  status: string;
  attemptSeq: number;
}

/**
 * 执行行仓库替身，**把两类读分开计数**：
 * - 无 `select.attemptSeq` 的 `findOne` = `handle` 开头那次装载（`loadCalls`）；
 * - 带 `select.attemptSeq` 的 `findOne` = `readClaimedAttemptSeq` 的 SELECT 兜底
 *   （`selectCalls`，本节的调用次数断言就是它）。
 *
 * `claimRaw` 决定 claim 语句回什么样的 RETURNING（可空/可缺列/可回字符串）。
 */
function makeExecRepo(row: ExecRow) {
  const state = {
    loadCalls: 0,
    selectCalls: [] as Array<Record<string, any>>,
  };
  let claimRaw: unknown = [];
  let claimAffected = 1;
  let readBack: Record<string, unknown> | null = null;
  let selectError: Error | null = null;

  const repo = {
    findOne: jest.fn(async (options?: Record<string, any>) => {
      if (options?.select?.attemptSeq === true) {
        state.selectCalls.push(options);
        if (selectError) throw selectError;
        return readBack ? { ...readBack } : null;
      }
      state.loadCalls += 1;
      return { ...row };
    }),
    createQueryBuilder: jest.fn(() => {
      const qb: Record<string, any> = {};
      qb.update = jest.fn(() => qb);
      qb.set = jest.fn(() => qb);
      qb.where = jest.fn(() => qb);
      qb.andWhere = jest.fn(() => qb);
      qb.returning = jest.fn(() => qb);
      qb.execute = jest.fn(async () => ({
        affected: claimAffected,
        raw: claimRaw,
      }));
      return qb;
    }),
  };

  return {
    repo,
    state,
    /** claim 的 RETURNING（模拟不同驱动的形状）。 */
    setClaimRaw(raw: unknown, affected = 1) {
      claimRaw = raw;
      claimAffected = affected;
    },
    /** SELECT 兜底读到的行（null = 列不存在 / 行为空）。 */
    setReadBack(value: Record<string, unknown> | null) {
      readBack = value;
    },
    /** SELECT 兜底**抛错**（列不存在 / 连接抖动）——仍要被记成「查了 1 次」。 */
    setSelectError(error: Error) {
      selectError = error;
    },
  };
}

// ─────────────────────────── 替身：终态写（按 whereSql 真筛行） ───────────────────────────

interface GateRow {
  id: string;
  status: string;
  attemptSeq?: number;
  executorAddress?: string | null;
}

interface GateCall {
  whereSql: string;
  params: Record<string, unknown>;
  patch: Record<string, unknown>;
}

type ExecuteStep = { affected: number } | { error: Error };

/**
 * 终态写替身：`execute` 按 whereSql 里**实际出现**的谓词筛行（id / status / attemptSeq），
 * 命中则把 patch 应用回行（模拟 UPDATE 的持久化效果），并按 PG 形态返回 `{affected, raw}`。
 *
 * `plan` 可让**某一次** execute 抛错（用来走到「事务失败 → 修复写」那条兜底）。
 */
function makeGate(rows: GateRow[], plan: ExecuteStep[] = []) {
  const calls: GateCall[] = [];

  const makeQb = () => {
    const qb: Record<string, any> = {};
    let whereSql = "";
    let params: Record<string, unknown> = {};
    let patch: Record<string, unknown> = {};

    qb.update = jest.fn(() => qb);
    qb.set = jest.fn((p: Record<string, unknown>) => {
      patch = p;
      return qb;
    });
    qb.where = jest.fn((sql: string, p: Record<string, unknown>) => {
      whereSql = sql;
      params = p;
      return qb;
    });
    // 终态门只用 where()；非终态（RUNNING 持久化）分支用 andWhere，本文件不关心其文本。
    qb.andWhere = jest.fn(() => qb);
    qb.returning = jest.fn(() => qb);
    qb.execute = jest.fn(async () => {
      calls.push({ whereSql, params, patch });
      const step = plan.shift();
      if (step && "error" in step) throw step.error;

      const ids = Array.isArray(params.ids) ? (params.ids as string[]) : null;
      if (!ids) {
        // 非终态条件 UPDATE（`WHERE id = :id AND status IN (:...writable)`）。
        const row = rows.find((r) => r.id === params.id);
        if (row) Object.assign(row, patch);
        return { affected: row ? 1 : 0, raw: [] };
      }

      const gate = (params.gate as string[] | undefined) ?? [];
      // 判据由**生产代码拼出来的 whereSql** 决定：谓词不在，世代就不参与筛选。
      const gateOnAttempt = whereSql.includes('"attemptSeq"');
      const matched = rows.filter(
        (r) =>
          ids.includes(r.id) &&
          gate.includes(r.status) &&
          (!gateOnAttempt || r.attemptSeq === params.expectedAttemptSeq),
      );
      for (const r of matched) Object.assign(r, patch);
      return {
        affected: matched.length,
        raw: matched.map((r) => ({
          id: r.id,
          executorAddress: r.executorAddress ?? null,
        })),
      };
    });
    return qb;
  };

  return { calls, makeQb };
}

const makeDataSource = (gate: ReturnType<typeof makeGate>) => ({
  createQueryRunner: jest.fn(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    manager: {
      save: jest.fn((e: unknown) => Promise.resolve(e)),
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn(() => gate.makeQb()),
    },
  })),
});

// ─────────────────────────── 公共装配 ───────────────────────────

const task = {
  id: "t1",
  name: "task1",
  timeout: 10,
  executeMode: "single",
  status: TaskStatus.ACTIVE,
} as unknown as Task;

async function buildProcessor(opts: {
  execRepo: ReturnType<typeof makeExecRepo>;
  gate: ReturnType<typeof makeGate>;
  dispatch: jest.Mock;
  taskService: Record<string, jest.Mock>;
}) {
  const module = await Test.createTestingModule({
    providers: [
      TaskProcessor,
      {
        provide: getRepositoryToken(TaskExecution),
        useValue: opts.execRepo.repo,
      },
      {
        provide: getRepositoryToken(Task),
        useValue: { findOne: jest.fn(async () => task) },
      },
      {
        provide: getRepositoryToken(ExecutionLogLine),
        useValue: { count: jest.fn(async () => 0) },
      },
      {
        provide: ExecutorService,
        useValue: { dispatch: opts.dispatch, dispatchBroadcast: jest.fn() },
      },
      {
        provide: AiAnalysisService,
        useValue: { analyzeFailure: jest.fn(async () => "") },
      },
      { provide: ConfigService, useValue: { get: jest.fn() } },
      { provide: TaskService, useValue: opts.taskService },
      { provide: getQueueToken("task-queue"), useValue: { add: jest.fn() } },
      { provide: DataSource, useValue: makeDataSource(opts.gate) },
    ],
  }).compile();
  return module.get(TaskProcessor);
}

const makeTaskService = () => ({
  trigger: jest.fn().mockResolvedValue(undefined),
  publishTerminalEventForDispatch: jest.fn().mockResolvedValue(undefined),
  publishExecutionWake: jest.fn().mockResolvedValue(undefined),
});

const makeJob = (data: Record<string, unknown> = {}) =>
  ({ data: { executionId: "exec-1", ...data } }) as any;

// ─────────────────────────── ① RETURNING → SELECT 兜底 ───────────────────────────

describe("G3 遗留① readClaimedAttemptSeq：RETURNING 优先，缺行紧随 SELECT（调用次数钉住）", () => {
  let execRepo: ReturnType<typeof makeExecRepo>;
  let processor: TaskProcessor;
  let dispatch: jest.Mock;

  /** 直接调私有方法——本节的被测对象就是这一次读回，用 handle 走一遍会混进装载读。 */
  const readSeq = (raw: unknown) =>
    (
      processor as unknown as {
        readClaimedAttemptSeq(
          executionId: string,
          raw: unknown,
        ): Promise<number | null>;
      }
    ).readClaimedAttemptSeq("exec-1", raw);

  beforeEach(async () => {
    execRepo = makeExecRepo({
      id: "exec-1",
      taskId: "t1",
      status: ExecutionStatus.PENDING,
      attemptSeq: 0,
    });
    dispatch = jest.fn().mockResolvedValue({ status: "accepted" });
    processor = await buildProcessor({
      execRepo,
      gate: makeGate([]),
      dispatch,
      taskService: makeTaskService(),
    });
  });

  it("① RETURNING 有值 ⇒ 直接返回，**不发** SELECT（findOne 0 次）", async () => {
    const seq = await readSeq([{ attemptSeq: 7 }]);

    expect(seq).toBe(7);
    // 关键：多查一次 = 每个 claim 都白跑一条 SQL。次数断言把「没查」也钉住了。
    expect(execRepo.repo.findOne).not.toHaveBeenCalled();
    expect(execRepo.state.selectCalls).toHaveLength(0);
  });

  it("① RETURNING 回字符串形式的整数 ⇒ 归一化成 number（驱动差异，同一条分支）", async () => {
    // 部分驱动（/部分 PG 客户端配置）把 int 列回成 "7"；不归一化会漏判成「读到但非整数」。
    const seq = await readSeq([{ attemptSeq: "7" }]);

    expect(seq).toBe(7);
    expect(execRepo.state.selectCalls).toHaveLength(0);
  });

  it("② RETURNING 为空数组（驱动不回行）⇒ 紧随 **1 次** SELECT 并返回其值", async () => {
    execRepo.setReadBack({ attemptSeq: 3 });

    const seq = await readSeq([]);

    expect(seq).toBe(3);
    // 恰好一次：0 次 = 拿不到世代（谓词失效）；2 次 = 多打一条无用 SQL。
    expect(execRepo.state.selectCalls).toHaveLength(1);
    // 读的是**同一行**的**那一列**（换行/换列都会让 CAS 比错东西）。
    expect(execRepo.state.selectCalls[0]).toEqual({
      where: { id: "exec-1" },
      select: { attemptSeq: true },
    });
  });

  it("② RETURNING 为 undefined（替身只回 {affected}）⇒ 同样发 1 次 SELECT", async () => {
    execRepo.setReadBack({ attemptSeq: 4 });

    const seq = await readSeq(undefined);

    expect(seq).toBe(4);
    expect(execRepo.state.selectCalls).toHaveLength(1);
  });

  it("② RETURNING 行里缺 attemptSeq 列 ⇒ 也走 SELECT（不把缺列当 0）", async () => {
    execRepo.setReadBack({ attemptSeq: 5 });

    const seq = await readSeq([{ id: "exec-1" }]);

    expect(seq).toBe(5);
    expect(execRepo.state.selectCalls).toHaveLength(1);
  });

  it("③ SELECT 也空 ⇒ 返回 null（**不是 0**：不知道 ≠ 第一回合）", async () => {
    execRepo.setReadBack(null);

    const seq = await readSeq([]);

    expect(seq).toBeNull();
    // 0 是**第一回合**的合法取值：编 0 会拼出 `"attemptSeq" = 0` 且恒不命中，
    // 把「读不到」变成「静默丢弃终态写」。这条断言就是防这个。
    expect(seq).not.toBe(0);
    expect(execRepo.state.selectCalls).toHaveLength(1);
  });

  it("③ SELECT 抛错（列不存在 / 连接抖动）⇒ 仍返回 null，不把异常抛给派发主链", async () => {
    execRepo.setSelectError(new Error('column "attemptSeq" does not exist'));

    await expect(readSeq([])).resolves.toBeNull();
    expect(execRepo.state.selectCalls).toHaveLength(1);
  });

  it("in situ：claim 的 RETURNING 缺行 ⇒ handle 确实走 SELECT 取回世代并带给 dispatch", async () => {
    execRepo.setClaimRaw([]); // 驱动不回 RETURNING 行
    execRepo.setReadBack({ attemptSeq: 3 });

    await processor.handle(makeJob());

    // 装载读 1 次 + SELECT 兜底 1 次（不是 2 次兜底，也不是 0 次）。
    expect(execRepo.state.loadCalls).toBe(1);
    expect(execRepo.state.selectCalls).toHaveLength(1);
    // 读回的世代真的被用上了：dispatch 收到的执行行带着它。
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][1].attemptSeq).toBe(3);
  });
});

// ─────────────────────────── ② dispatch 失败的终态写带世代 ───────────────────────────

describe("G3 遗留② dispatch 失败的终态写带上本次 claim 的世代", () => {
  let execRepo: ReturnType<typeof makeExecRepo>;
  let gate: ReturnType<typeof makeGate>;
  let rows: GateRow[];
  let processor: TaskProcessor;
  let dispatch: jest.Mock;
  let taskService: ReturnType<typeof makeTaskService>;

  beforeEach(async () => {
    execRepo = makeExecRepo({
      id: "exec-1",
      taskId: "t1",
      status: ExecutionStatus.PENDING,
      attemptSeq: 0,
    });
    rows = [
      {
        id: "exec-1",
        status: ExecutionStatus.RUNNING,
        attemptSeq: 1,
        executorAddress: null,
      },
    ];
    gate = makeGate(rows);
    dispatch = jest.fn().mockRejectedValue(new Error("exec failed"));
    taskService = makeTaskService();
    processor = await buildProcessor({ execRepo, gate, dispatch, taskService });
  });

  it("世代已知 ⇒ 终态写**带** expectedAttemptSeq（whereSql + params 逐个断言）", async () => {
    execRepo.setClaimRaw([{ attemptSeq: 1 }]); // 本次 claim 自增到 1
    rows[0].attemptSeq = 1;

    await expect(processor.handle(makeJob())).rejects.toThrow("exec failed");

    expect(gate.calls).toHaveLength(1);
    expect(gate.calls[0].whereSql).toBe(
      '"id" IN (:...ids) AND "status" IN (:...gate)' +
        ' AND "attemptSeq" = :expectedAttemptSeq',
    );
    expect(gate.calls[0].params.expectedAttemptSeq).toBe(1);
    expect(gate.calls[0].patch.status).toBe(ExecutionStatus.FAILED);
  });

  it("陈旧 worker 的终态写被世代谓词拒绝：affected 0 ⇒ 行不被改写、不发终态事件", async () => {
    // 本次 claim 领到第 1 回合；写入时库里已是第 2 回合（期间被重新 claim）。
    execRepo.setClaimRaw([{ attemptSeq: 1 }]);
    rows[0].attemptSeq = 2;

    await expect(processor.handle(makeJob())).rejects.toThrow("exec failed");

    expect(gate.calls[0].params.expectedAttemptSeq).toBe(1);
    // 这一行仍是 RUNNING（新回合在跑），没有被上一回合的派发失败写成 FAILED。
    expect(rows[0].status).toBe(ExecutionStatus.RUNNING);
    // 终态没落库 ⇒ 事件不发（事件必须对应真实持久化的终态，由新回合的赢家发布）。
    expect(taskService.publishTerminalEventForDispatch).not.toHaveBeenCalled();
    expect(taskService.publishExecutionWake).not.toHaveBeenCalled();
  });

  it("世代未知（null）⇒ **不**带谓词：whereSql/params 与引入前逐字节一致", async () => {
    // RETURNING 缺行 + SELECT 也读不到（列不存在 / 替身未建模该列）。
    execRepo.setClaimRaw([]);
    execRepo.setReadBack(null);

    await expect(processor.handle(makeJob())).rejects.toThrow("exec failed");

    expect(gate.calls).toHaveLength(1);
    // 逐字节：一个字都没多，参数集合也没有 expectedAttemptSeq。
    expect(gate.calls[0].whereSql).toBe(
      '"id" IN (:...ids) AND "status" IN (:...gate)',
    );
    expect(Object.keys(gate.calls[0].params)).toEqual(["ids", "gate"]);
    expect(gate.calls[0].params).not.toHaveProperty("expectedAttemptSeq");
    // 行为等价：世代为 1 的行照旧被终态化，事件照发（既有语义一字未改）。
    expect(rows[0].status).toBe(ExecutionStatus.FAILED);
    expect(taskService.publishTerminalEventForDispatch).toHaveBeenCalledTimes(
      1,
    );
  });

  it("回归锁：世代已知且命中 ⇒ FAILED 终态、原错误重抛、终态事件照发（BUG-21 口径不变）", async () => {
    execRepo.setClaimRaw([{ attemptSeq: 1 }]);
    rows[0].attemptSeq = 1;

    await expect(processor.handle(makeJob())).rejects.toThrow("exec failed");

    expect(rows[0].status).toBe(ExecutionStatus.FAILED);
    const [execArg, cbArg] =
      taskService.publishTerminalEventForDispatch.mock.calls[0];
    expect(execArg.status).toBe(ExecutionStatus.FAILED);
    expect(cbArg.errorMessage).toContain("exec failed");
    expect(taskService.publishExecutionWake).toHaveBeenCalledTimes(1);
  });

  it("修复写（主事务失败后的兜底）同样带世代——与主写同口径", async () => {
    execRepo.setClaimRaw([{ attemptSeq: 1 }]);
    rows[0].attemptSeq = 1;
    // 第一次 execute（主写）抛错 → 回滚 → 修复写（第二次 execute）照常执行。
    gate = makeGate(rows, [{ error: new Error("deadlock detected") }]);
    processor = await buildProcessor({ execRepo, gate, dispatch, taskService });

    await expect(processor.handle(makeJob())).rejects.toThrow("exec failed");

    // 两次终态写（主写 + 修复写）都带同一个世代谓词。
    expect(gate.calls).toHaveLength(2);
    for (const call of gate.calls) {
      expect(call.whereSql).toContain(
        ' AND "attemptSeq" = :expectedAttemptSeq',
      );
      expect(call.params.expectedAttemptSeq).toBe(1);
    }
    expect(rows[0].status).toBe(ExecutionStatus.FAILED);
    expect(taskService.publishTerminalEventForDispatch).toHaveBeenCalledTimes(
      1,
    );
  });
});
