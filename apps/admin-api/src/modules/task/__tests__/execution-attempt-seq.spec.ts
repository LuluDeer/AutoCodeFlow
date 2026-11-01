import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { getQueueToken } from "@nestjs/bullmq";
import { getMetadataArgsStorage } from "typeorm";
import { DECORATORS } from "@nestjs/swagger";
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
import {
  transitionOneToTerminal,
  transitionToTerminal,
} from "../execution-terminal";
import {
  TaskExecutionResponseDto,
  ExecutionListItemDto,
} from "../dto/task-response.dto";

/**
 * G3（P2 · 迁移 1790000000092）：**尝试世代**维度。
 *
 * ## 缺陷（本文五条断言的对象）
 *
 * 终态门是**纯状态**的（`WHERE "id" IN (:...ids) AND "status" IN (:...gate)`），
 * 它只回答「这行现在还开着吗」，不回答「这是**第几回合**的开着」。而同一个
 * `executionId` 会被重新 claim 成 RUNNING（`task.processor` 的 claim 把 FAILED
 * 也算可 claim——BullMQ 重试复用同一个 `{executionId}` job；互斥/部署等待的唤醒
 * 同款），且这条路径上 `retryCount` **从不自增**——「第几回合」此前在库里没有
 * 任何列表达。于是「上一回合的迟到回调」与「本回合的正常回调」在
 * (id, status, executorAddress) 上完全同形，纯状态门只能两者都放行。
 *
 * ## 为什么替身必须**真的**应用谓词（而不是只断言字符串）
 *
 * 若替身忽略 `"attemptSeq" = :expectedAttemptSeq`（像多数用例那样直接返回固定
 * 数组），那么「旧世代被拒」这件事根本测不到——删掉生产代码里的谓词，用例照样
 * 绿。故 `makeGateRepo` 的 `execute` **按 whereSql 里实际出现的谓词**筛行
 *（`whereSql.includes('"attemptSeq"')` 才比世代），绿/红由「生产代码有没有把
 * 谓词拼上去」决定。与 `execution-synthetic.spec.ts` 的 `makeExecRepo` 同款纪律。
 *
 * ## 五条断言与对应 describe
 *
 * ① claim 自增（并发两次 claim 只有一个成功） → "claim 的尝试世代"
 * ② 回调带**旧**世代 → 终态写入命中 0 行           → "终态门的世代谓词" + "回调路径"
 * ③ 回调带**当前**世代 → 正常写入                  → 同上
 * ④ **回归锁**：不传 expected 的既有调用点逐字节等价 → "回归锁"
 * ⑤ 存量行 attemptSeq = 0 = 第一次尝试             → "存量行语义"
 */

// ─────────────────────────── 替身：条件 UPDATE 的 DB 语义 ───────────────────────────

interface GateRow {
  id: string;
  status: string;
  /** 库中当前世代（`attemptSeq`）。 */
  attemptSeq?: number;
  executorAddress?: string | null;
}

interface GateCall {
  whereSql: string;
  params: Record<string, unknown>;
  patch: Record<string, unknown>;
}

/**
 * 终态写入替身：按 `whereSql` 里**实际存在**的谓词筛行（id / status / attemptSeq），
 * 命中则把 patch 应用回行（模拟 UPDATE 的持久化效果），并按 PG 形态返回
 * `{affected, raw}`。
 */
function makeGateRepo(rows: GateRow[]) {
  const calls: GateCall[] = [];
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
  qb.andWhere = jest.fn(() => qb);
  qb.returning = jest.fn(() => qb);
  qb.execute = jest.fn(async () => {
    calls.push({ whereSql, params, patch });
    const ids = (params.ids as string[] | undefined) ?? [];
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

  const repo = {
    createQueryBuilder: jest.fn(() => qb),
  };
  return { repo: repo as unknown as Record<string, jest.Mock>, calls, rows, qb };
}

// ─────────────────────────── 替身：claim 语句 ───────────────────────────

interface ClaimRow {
  id: string;
  taskId: string;
  status: string;
  attemptSeq: number;
  startTime?: Date;
}

/**
 * claim 替身：把 `task.processor` 那条条件 UPDATE 的**语义**落地——
 * 谓词 `status IN (claimable)` 决定命中，`attemptSeq` 的**函数式赋值**按
 * `SET "attemptSeq" = "attemptSeq" + 1` 执行（不是读改写）。
 *
 * 诚实边界：单测无法证伪/证实真库的行锁；这里证明的是「生产代码拼出的语句
 * 形状 + 自增语义」，而真实并发安全由 PG 的行锁 + 同一条条件 UPDATE 保证
 *（谓词与自增在同一条语句里求值，这一点在测试里是可见的）。
 */
function makeClaimRepo(rows: ClaimRow[]) {
  const claimCalls: Array<{ patch: Record<string, unknown> }> = [];
  const repo = {
    findOne: jest.fn(async (opts?: Record<string, any>) => {
      const id = opts?.where?.id;
      const row = rows.find((r) => r.id === id);
      return row ? ({ ...row } as never) : (null as never);
    }),
    createQueryBuilder: jest.fn(() => {
      let patch: Record<string, unknown> = {};
      let params: Record<string, any> = {};
      const qb: Record<string, any> = {};
      qb.update = jest.fn(() => qb);
      qb.set = jest.fn((p: Record<string, unknown>) => {
        patch = p;
        return qb;
      });
      qb.where = jest.fn((_sql: string, p?: Record<string, any>) => {
        params = { ...params, ...(p ?? {}) };
        return qb;
      });
      qb.andWhere = jest.fn((_sql: string, p?: Record<string, any>) => {
        params = { ...params, ...(p ?? {}) };
        return qb;
      });
      qb.returning = jest.fn(() => qb);
      qb.execute = jest.fn(async () => {
        claimCalls.push({ patch });
        const row = rows.find((r) => r.id === params.id);
        const claimable = (params.claimable as string[] | undefined) ?? [];
        if (!row || !claimable.includes(row.status)) {
          return { affected: 0, raw: [] };
        }
        for (const [key, value] of Object.entries(patch)) {
          if (typeof value === "function") {
            // 模拟 `SET "attemptSeq" = "attemptSeq" + 1`：读的是**库里**的值。
            row.attemptSeq = row.attemptSeq + 1;
          } else {
            (row as unknown as Record<string, unknown>)[key] = value;
          }
        }
        return { affected: 1, raw: [{ attemptSeq: row.attemptSeq }] };
      });
      return qb;
    }),
  };
  return { repo, claimCalls, rows };
}

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
      createQueryBuilder: jest.fn(() => {
        const qb: Record<string, any> = {};
        qb.update = jest.fn(() => qb);
        qb.set = jest.fn(() => qb);
        qb.where = jest.fn(() => qb);
        qb.andWhere = jest.fn(() => qb);
        qb.returning = jest.fn(() => qb);
        qb.execute = jest.fn().mockResolvedValue({ affected: 1 });
        return qb;
      }),
    },
  })),
});

// ─────────────────────────── ① claim 的尝试世代 ───────────────────────────

describe("G3 ① claim 时自增尝试世代（迁移 1790000000092）", () => {
  let rows: ClaimRow[];
  let claimRepo: ReturnType<typeof makeClaimRepo>;
  let dispatch: jest.Mock;
  let processor: TaskProcessor;

  const task = {
    id: "t1",
    name: "task1",
    timeout: 10,
    executeMode: "single",
    status: TaskStatus.ACTIVE,
  } as unknown as Task;

  const build = async () => {
    dispatch = jest.fn().mockResolvedValue({ status: "accepted" });
    const taskRepo = {
      findOne: jest.fn(async () => task),
      createQueryBuilder: jest.fn(),
    };
    const dataSource = makeDataSource();
    const module = await Test.createTestingModule({
      providers: [
        TaskProcessor,
        {
          provide: getRepositoryToken(TaskExecution),
          useValue: claimRepo.repo,
        },
        { provide: getRepositoryToken(Task), useValue: taskRepo },
        {
          provide: getRepositoryToken(ExecutionLogLine),
          useValue: { count: jest.fn(async () => 0) },
        },
        {
          provide: ExecutorService,
          useValue: { dispatch, dispatchBroadcast: jest.fn() },
        },
        {
          provide: AiAnalysisService,
          useValue: { analyzeFailure: jest.fn(async () => "") },
        },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        {
          provide: TaskService,
          useValue: {
            trigger: jest.fn(),
            publishTerminalEventForDispatch: jest.fn(),
            publishExecutionWake: jest.fn(),
          },
        },
        { provide: getQueueToken("task-queue"), useValue: { add: jest.fn() } },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    processor = module.get(TaskProcessor);
  };

  beforeEach(async () => {
    rows = [
      {
        id: "exec-1",
        taskId: "t1",
        status: ExecutionStatus.PENDING,
        attemptSeq: 0,
      },
    ];
    claimRepo = makeClaimRepo(rows);
    await build();
  });

  it("claim 用**函数式赋值**自增（SET \"attemptSeq\" = \"attemptSeq\" + 1），不是读改写", async () => {
    await processor.handle({ data: { executionId: "exec-1" } } as any);

    expect(claimRepo.claimCalls).toHaveLength(1);
    const patch = claimRepo.claimCalls[0].patch;
    // 关键结构断言：attemptSeq 的值必须是一个**函数**（TypeORM 的原始 SQL 表达式）。
    // 改成 `exec.attemptSeq + 1`（读改写）→ 本断言立刻红，而并发用例也会跟着红。
    expect(typeof patch.attemptSeq).toBe("function");
    expect((patch.attemptSeq as () => string)()).toBe('"attemptSeq" + 1');
  });

  it("第一次 claim：attemptSeq 0 → 1，且 RETURNING 取回的正是自增后的值", async () => {
    await processor.handle({ data: { executionId: "exec-1" } } as any);

    expect(rows[0].attemptSeq).toBe(1);
    expect(rows[0].status).toBe(ExecutionStatus.RUNNING);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("第三次 claim（RUNNING 之后又被置 FAILED / 唤醒）继续单调自增，不回头", async () => {
    await processor.handle({ data: { executionId: "exec-1" } } as any);
    rows[0].status = ExecutionStatus.FAILED; // BullMQ 重试前置（FAILED 可 claim）
    await processor.handle({ data: { executionId: "exec-1" } } as any);
    rows[0].status = ExecutionStatus.WAITING; // 互斥等待后被唤醒
    await processor.handle({ data: { executionId: "exec-1" } } as any);

    expect(rows[0].attemptSeq).toBe(3);
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it("**并发**两次 claim 只有一个成功：世代只自增一次（不是 2）", async () => {
    // 两个 worker 同时拿到同一个 job（BullMQ 重投 / 多副本），并发跑 claim。
    await Promise.all([
      processor.handle({ data: { executionId: "exec-1" } } as any),
      processor.handle({ data: { executionId: "exec-1" } } as any),
    ]);

    // 命中者只有一个：世代 0 → 1（读改写会双双读到 0、双双写 1，仍为 1；
    // 但配合上面那条「函数式赋值」断言，这里排除了读改写形态）。
    expect(rows[0].attemptSeq).toBe(1);
    // 只有一个真的派发了出去（另一个 claim 命中 0 行 → 静默返回 idle）。
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("claim 失败（0 行）时世代不变，也不派发", async () => {
    rows[0].status = ExecutionStatus.RUNNING; // RUNNING 不可 claim（CONSISTENCY-01）
    await processor.handle({ data: { executionId: "exec-1" } } as any);

    expect(rows[0].attemptSeq).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

// ─────────────────────────── ②③ 终态门的世代谓词 ───────────────────────────

describe("G3 ②③ 终态门的世代谓词（不传即不加）", () => {
  const runningRow = (attemptSeq?: number): GateRow => ({
    id: "e1",
    status: ExecutionStatus.RUNNING,
    attemptSeq,
    executorAddress: "10.0.0.1:8002",
  });

  it("② 回调带**旧**世代 ⇒ 写入命中 0 行（迟到回合被拒）", async () => {
    // 库中已是第 1 回合（重新 claim 过），而这次写入认领的是第 0 回合。
    const { repo, calls, rows } = makeGateRepo([runningRow(1)]);
    const res = await transitionToTerminal(repo as never, {
      ids: ["e1"],
      patch: { status: ExecutionStatus.SUCCESS },
      expectedAttemptSeq: 0,
    });

    expect(calls[0].whereSql).toContain('"attemptSeq" = :expectedAttemptSeq');
    expect(calls[0].params.expectedAttemptSeq).toBe(0);
    expect(res.affected).toBe(0);
    expect(res.rows).toEqual([]);
    expect(res.transitioned).toBe(false);
    // 行没被改写——这正是「迟到回调不再提前终态化当前回合」的证据。
    expect(rows[0].status).toBe(ExecutionStatus.RUNNING);
  });

  it("③ 回调带**当前**世代 ⇒ 正常写入（winner 语义不变）", async () => {
    const { repo, calls, rows } = makeGateRepo([runningRow(1)]);
    const res = await transitionToTerminal(repo as never, {
      ids: ["e1"],
      patch: { status: ExecutionStatus.SUCCESS },
      expectedAttemptSeq: 1,
    });

    expect(calls[0].whereSql).toContain('"attemptSeq" = :expectedAttemptSeq');
    expect(res.affected).toBe(1);
    expect(res.rows).toEqual([
      { id: "e1", executorAddress: "10.0.0.1:8002" },
    ]);
    expect(rows[0].status).toBe(ExecutionStatus.SUCCESS);
  });

  it("世代谓词与状态门**同时**求值（终态行即使世代相符也写不进去）", async () => {
    const { repo } = makeGateRepo([
      { id: "e1", status: ExecutionStatus.SUCCESS, attemptSeq: 1 },
    ]);
    const res = await transitionToTerminal(repo as never, {
      ids: ["e1"],
      patch: { status: ExecutionStatus.FAILED },
      expectedAttemptSeq: 1,
    });
    expect(res.affected).toBe(0);
  });

  it("单执行便捷入口同样透传世代（transitionOneToTerminal）", async () => {
    const { repo, calls } = makeGateRepo([runningRow(2)]);
    const res = await transitionOneToTerminal(repo as never, {
      id: "e1",
      patch: { status: ExecutionStatus.KILLED },
      expectedAttemptSeq: 2,
    });
    expect(calls[0].params.expectedAttemptSeq).toBe(2);
    expect(res.affected).toBe(1);
  });

  it("防御：世代是逐行事实，与多个 id 同传直接抛错（不静默变成 affected=0）", async () => {
    const { repo } = makeGateRepo([]);
    await expect(
      transitionToTerminal(repo as never, {
        ids: ["e1", "e2"],
        patch: { status: ExecutionStatus.FAILED },
        expectedAttemptSeq: 0,
      }),
    ).rejects.toThrow(/expectedAttemptSeq/);
  });
});

// ─────────────────────────── ④ 回归锁 ───────────────────────────

describe("G3 ④ 回归锁：不传 expected 的既有调用点逐字节等价", () => {
  it("whereSql 与 params **恰好**是引入世代谓词之前的形态（多一个字符都算红）", async () => {
    const { repo, calls } = makeGateRepo([
      { id: "e1", status: ExecutionStatus.RUNNING, attemptSeq: 5 },
    ]);
    const res = await transitionToTerminal(repo as never, {
      ids: ["e1"],
      patch: { status: ExecutionStatus.SUCCESS },
    });

    // 逐字节：这是引入前的那一条字符串，没有被追加任何东西。
    expect(calls[0].whereSql).toBe(
      '"id" IN (:...ids) AND "status" IN (:...gate)',
    );
    expect(Object.keys(calls[0].params)).toEqual(["ids", "gate"]);
    expect(calls[0].params).not.toHaveProperty("expectedAttemptSeq");
    // 行为：世代为 5 的行照旧被终态化（既有语义一字未改）。
    expect(res.affected).toBe(1);
  });

  it("带 from 收窄 + finalizationGuard 时也不受影响（谓词顺序与参数集合不变）", async () => {
    const { repo, calls } = makeGateRepo([
      { id: "e1", status: ExecutionStatus.PENDING, attemptSeq: 0 },
    ]);
    await transitionToTerminal(repo as never, {
      ids: ["e1"],
      patch: { status: ExecutionStatus.FAILED },
      from: [ExecutionStatus.PENDING],
      finalizationGuard: { leaseOwner: "host:1", guardNewerWork: true },
    });
    expect(calls[0].whereSql).not.toContain('"attemptSeq"');
    expect(Object.keys(calls[0].params)).toEqual([
      "ids",
      "gate",
      "finalizationNow",
      "finalizationLeaseOwner",
      "openStatuses",
    ]);
  });

  it("回调路径未带该列（替身/存量行）时不加谓词——既有 handleCallback 行为不变", async () => {
    // 行里**没有** attemptSeq 字段：服务端快照规范化成 undefined ⇒ 不加谓词。
    const { repo, calls } = makeGateRepo([
      { id: "e1", status: ExecutionStatus.RUNNING },
    ]);
    await transitionToTerminal(repo as never, {
      ids: ["e1"],
      patch: { status: ExecutionStatus.SUCCESS },
      expectedAttemptSeq: undefined,
    });
    expect(calls[0].whereSql).toBe(
      '"id" IN (:...ids) AND "status" IN (:...gate)',
    );
    expect(Object.keys(calls[0].params)).toEqual(["ids", "gate"]);
  });
});

// ─────────────────────────── ⑤ 存量行语义 ───────────────────────────

describe("G3 ⑤ 存量行 attemptSeq = 0 = 第一次尝试", () => {
  it("实体列存在且默认 0（存量行零回填即语义正确，metadata-only）", () => {
    const column = getMetadataArgsStorage().columns.find(
      (c) => c.target === TaskExecution && c.propertyName === "attemptSeq",
    );
    expect(column).toBeDefined();
    expect(column?.options.type).toBe("int");
    expect(column?.options.default).toBe(0);
    // 不是可空列：语义上只有「第几回合」，没有「不知道」。
    expect(column?.options.nullable).not.toBe(true);
  });

  it("存量行（世代 0）的第一次回调正常写入——0 是合法世代，不是「未设置」", async () => {
    const { repo, rows } = makeGateRepo([
      { id: "legacy-1", status: ExecutionStatus.RUNNING, attemptSeq: 0 },
    ]);
    const res = await transitionToTerminal(repo as never, {
      ids: ["legacy-1"],
      patch: { status: ExecutionStatus.SUCCESS },
      expectedAttemptSeq: 0,
    });
    expect(res.affected).toBe(1);
    expect(rows[0].status).toBe(ExecutionStatus.SUCCESS);
  });

  it("attemptSeq 已进执行读 DTO（实体列 ⊆ DTO 的机械不变量在此项上的落点）", () => {
    const meta = Reflect.getMetadata(
      DECORATORS.API_MODEL_PROPERTIES,
      new TaskExecutionResponseDto(),
      "attemptSeq",
    );
    expect(meta).toBeDefined();
    // 列表读面同步覆盖（ExecutionListItemDto 继承该声明）。
    const listMeta = Reflect.getMetadata(
      DECORATORS.API_MODEL_PROPERTIES,
      new ExecutionListItemDto(),
      "attemptSeq",
    );
    expect(listMeta).toBeDefined();
    // 中文 description（check:user-facing-language 要求），同批已补英文映射。
    expect(String((meta as { description?: string }).description)).toMatch(
      /尝试世代/,
    );
  });
});

// ─────────────────────────── ②③ 回调路径端到端 ───────────────────────────

describe("G3 ②③ 回调路径：服务端世代快照 + 终态门", () => {
  /**
   * 构造一个**只装配 handleCallback 主链必需件**的 TaskService 实例
   * （`Object.create(prototype)` 的既有手法，见 execution-synthetic.spec.ts）。
   *
   * `findOne` 刻意在第 1 次读返回「读时刻的快照」（旧世代）、其后返回「库中现值」
   * （新世代）——精确模拟「读行之后、写行之前该行被重新 claim」这个窗口。
   */
  const makeService = (opts: {
    snapshotAttemptSeq?: number;
    currentAttemptSeq?: number;
  }) => {
    const current: GateRow = {
      id: "e1",
      status: ExecutionStatus.RUNNING,
      attemptSeq: opts.currentAttemptSeq,
      executorAddress: "10.0.0.1:8002",
    };
    const gate = makeGateRepo([current]);
    const snapshot = { ...current, attemptSeq: opts.snapshotAttemptSeq };
    let reads = 0;
    const service = Object.create(TaskService.prototype) as Record<
      string,
      any
    >;
    service.execRepo = {
      createQueryBuilder: gate.repo.createQueryBuilder,
      findOne: jest.fn(async () => {
        reads += 1;
        // 第 1 次 = 回调处理开头的那次读（快照）；其后 = 库中现值。
        return reads === 1 ? snapshot : current;
      }),
      find: jest.fn(async () => [snapshot]),
    };
    service.taskRepo = { findOne: jest.fn(async () => null) };
    service.logger = {
      warn: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    service.releaseExecutorSlot = jest.fn(async () => undefined);
    service.publishExecutionWake = jest.fn();
    service.emitTerminalEvent = jest.fn();
    service.triggerDependentTasks = jest.fn(async () => undefined);
    service.storeLogLines = jest.fn(async () => undefined);
    service.hasStreamedLogLines = jest.fn(async () => false);
    return { service, gate, current };
  };

  const cb = {
    executionId: "e1",
    status: "success" as const,
    executorAddress: "10.0.0.1:8002",
  };

  it("② 读到的世代已被推进 ⇒ 终态写入 0 行，且不把旧回合的日志写进新回合", async () => {
    // 读时刻是第 0 回合；写入时库里已是第 1 回合（期间被重新 claim）。
    const { service, gate, current } = makeService({
      snapshotAttemptSeq: 0,
      currentAttemptSeq: 1,
    });

    const res = await service["handleCallback"]([
      { ...cb, logs: "stale round output" },
    ]);

    // 终态没被旧回合改写。
    expect(gate.calls[0].params.expectedAttemptSeq).toBe(0);
    expect(gate.calls[0].whereSql).toContain('"attemptSeq"');
    expect(current.status).toBe(ExecutionStatus.RUNNING);
    expect(service["storeLogLines"]).not.toHaveBeenCalled();
    // 对执行器仍报成功：这条回调重试永远不会再命中。
    expect(res).toEqual([{ executionId: "e1", success: true }]);
    // 观测面：明确区分「迟到回合」与「重复回调」。
    expect(
      service["logger"].warn.mock.calls.some((c: any[]) =>
        /stale-attempt/.test(String(c[0])),
      ),
    ).toBe(true);
  });

  it("③ 读到的世代仍成立 ⇒ 正常终态写入（winner 路径一字未改）", async () => {
    const { service, gate, current } = makeService({
      snapshotAttemptSeq: 1,
      currentAttemptSeq: 1,
    });

    const res = await service["handleCallback"]([cb]);

    expect(gate.calls[0].params.expectedAttemptSeq).toBe(1);
    expect(current.status).toBe(ExecutionStatus.SUCCESS);
    expect(service["releaseExecutorSlot"]).toHaveBeenCalledWith(
      "10.0.0.1:8002",
    );
    expect(res).toEqual([{ executionId: "e1", success: true }]);
  });

  it("④ 快照不带该列（替身/存量路径）⇒ 不加谓词，行为与引入前一致", async () => {
    const { service, gate, current } = makeService({
      snapshotAttemptSeq: undefined,
      currentAttemptSeq: 0,
    });

    await service["handleCallback"]([cb]);

    expect(gate.calls[0].whereSql).toBe(
      '"id" IN (:...ids) AND "status" IN (:...gate)',
    );
    expect(Object.keys(gate.calls[0].params)).toEqual(["ids", "gate"]);
    expect(current.status).toBe(ExecutionStatus.SUCCESS);
  });
});
