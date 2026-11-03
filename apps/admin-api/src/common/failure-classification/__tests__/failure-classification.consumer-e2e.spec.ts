/**
 * 失败分类守卫的**消费端端到端**层（Round 2 · guard-hardening）。
 *
 * ## 为什么有这份 spec（上一轮 27 条守卫的盲区）
 *
 * `failure-classification.path-parity.spec.ts` 的 27 条断言全部**直接调用**
 * `classifyFailure(...)` —— 它保护的是**函数**，不是**两条失败路径**。
 * 于是有一条致命的后果：
 *
 *   把裸子串 `enotfound`（正是 `09b5d3c0` 修掉的 H-2 缺陷形态）**加回消费者**
 *   （`task.service.ts` / `task.processor.ts`），那 27 条仍然**全绿**。
 *
 * 本 spec 把守卫从「函数级」升级为「**消费端端到端级**」：
 *
 *   · **回调路径**：走真实公开入口 `TaskService.handleCallback(...)`
 *     → `inferFailureReason(...)` → `classifyFailure(...)`，
 *     断言**落库的** `failureReason`（不是返回值）。
 *   · **派发路径**：走真实 `TaskProcessor.handle(job)` 的 **catch 链**
 *     → `classifyFailure(...)`，断言**终态条件 UPDATE 的 patch**。
 *
 * 两条路径都**不经过**任何测试替身的分类逻辑，故「消费者内联了裸
 * `enotfound`」这类回归**必然变红**（见 §3 反向验证实证）。
 *
 * ## 本 spec 与既有 27 条的分工（不重复造轮子）
 *
 * | 层 | 既有 `path-parity.spec.ts` | 本 spec |
 * |---|---|---|
 * | 判据表 | ✅ 逐条比对期望值 | 复用其期望值，但**从消费者入口**跑出来 |
 * | 单一事实源 | ✅ 常量唯一性 + 无内联副本 | 补「**消费者全集恰为两处**」+ 可测的**内联副本判据** |
 * | 端到端 | ❌ **无**（这是致命缺口） | ✅ 回调 + 派发，落库断言 |
 *
 * ## 消费端端到端能抓住什么（逐条反证）
 *
 * ① **裸 `enotfound` 加回消费者** ⇒ `ModuleNotFoundError` 落
 *    `executor_offline`（可重试、白烧预算）⇒ 本 spec 红。
 * ② **裸 `enotfound` 加回共享判据**（`\benotfound\b` → `enotfound`）⇒
 *    同上 ⇒ 本 spec 红。
 * ③ **消费者绕过 `classifyFailure` 自带内联正则链** ⇒ 同一文案在两条路径
 *    归因不同 ⇒ 本 spec 红。
 * ④ **新增第三条分类路径**（新文件也 import `classifyFailure`）⇒ 消费者全集
 *    守卫红，强制补上该路径的端到端断言。
 *
 * ## 本 spec **不能**抓住的（已知盲区，诚实声明）
 *
 * · 消费者内联一份**判据之外**的分类（例如自造 `CUSTOM_FAIL`）⇒ 归因值
 *   不在任何期望值表里，本 spec 抓不到（靠 §「消费者全集」+ 内联副本判据
 *   兜底，但那两条是**结构**判据，不是行为判据）。
 * · 判据**改措辞**但归因不变 ⇒ 端到端断言不红（这是**正确**行为：归因没变）。
 * · 改的是**规则顺序**但恰好这批文案不受影响 ⇒ 不红（顺序偏序由既有 27 条
 *   的期望值表覆盖一部分）。
 *
 * @see failure-classification.path-parity.spec.ts（函数级 27 条）
 * @see dependency-missing.semantic.spec.ts（`dependency_missing` 现状钉桩）
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

import * as ts from "typescript";

import {
  APPLICATION_MISSING_PATTERN,
  EXECUTOR_OFFLINE_PATTERN,
  INTERPRETER_UNAVAILABLE_PATTERN,
  PACKAGE_FETCH_PATTERN,
  SANDBOX_UNAVAILABLE_PATTERN,
  SCRIPT_ERROR_PATTERN,
  TIMEOUT_PATTERN,
  classifyFailure,
} from "../failure-patterns";
import {
  ExecutionFailureReason,
  ExecutionStatus,
} from "../../../modules/task/entities/task-execution.entity";
import { TaskStatus } from "../../../modules/task/entities/task.entity";
import { TaskService } from "../../../modules/task/task.service";
import { TaskProcessor } from "../../../modules/task/task.processor";

// ════════════════════════════════════════════════════════════════════════
// §1 消费端端到端：回调路径（TaskService.handleCallback → inferFailureReason）
// ════════════════════════════════════════════════════════════════════════

/**
 * 回调路径的**最小真实替身**。
 *
 * 为什么不用完整 Nest TestingModule：本 spec 只关心「归因从消费者入口出来后
 * 落成什么」，不关心 DI 装配。`Object.create(TaskService.prototype)` 是本仓
 * **既有手法**（见 `execution-attempt-seq.spec.ts` 的同名注释），它保留**真实
 * 方法体**（`handleCallback` / `inferFailureReason` 都是原型上的真方法），
 * 只把**副作用**（落库 / 扇出 / 释放槽位 / 存日志）替换成可观测的桩。
 *
 * 桩的纪律（与 `execution-attempt-seq.spec.ts` 同款）：
 *   · **判据逻辑一律不桩** —— 分类必须由真实 `classifyFailure` 产出；
 *   · 落库由 `execRepo.createQueryBuilder()` 的条件 UPDATE 替身**真的执行**
 *     （把 patch 应用回行），使断言能读到「写进库里的 failureReason」；
 *   · gate 判定（`status IN (open)`）由替身按 `whereSql` 里**实际出现**的
 *     谓词求值 —— 若生产代码不再拼终态门，替身就会命中 0 行、用例红。
 */
interface CallbackRow {
  id: string;
  taskId: string;
  status: string;
  executorAddress: string | null;
  attemptSeq?: number;
  failureReason?: string | null;
  status2?: never;
}

function makeCallbackExecRepo(row: CallbackRow) {
  const calls: Array<{
    whereSql: string;
    params: Record<string, unknown>;
    patch: Record<string, unknown>;
  }> = [];
  let whereSql = "";
  let params: Record<string, unknown> = {};
  let patch: Record<string, unknown> = {};
  const qb: Record<string, any> = {};
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
    const matched = rows.filter((r) => ids.includes(r.id) && gate.includes(r.status));
    for (const r of matched) Object.assign(r, patch);
    return {
      affected: matched.length,
      raw: matched.map((r) => ({
        id: r.id,
        executorAddress: r.executorAddress ?? null,
      })),
    };
  });
  const rows = [row];
  return {
    repo: {
      findOne: jest.fn(async () => row),
      createQueryBuilder: jest.fn(() => qb),
    },
    calls,
    row,
  };
}

/** 造一个**只装配回调主链必需件**的 TaskService 实例。 */
function makeCallbackService(row: CallbackRow) {
  const gate = makeCallbackExecRepo(row);
  const service = Object.create(TaskService.prototype) as Record<string, any>;
  service.execRepo = gate.repo;
  // 任务行查不到 ⇒ `autoAnalyzeCallbackFailure` 立即返回 ""（不牵出 AI 分析）。
  service.taskRepo = { findOne: jest.fn(async () => null) };
  service.logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  // 副作用桩（**不含任何分类逻辑**）。
  service.releaseExecutorSlot = jest.fn(async () => undefined);
  service.triggerDependentTasks = jest.fn(async () => undefined);
  service.storeLogLines = jest.fn(async () => undefined);
  service.hasStreamedLogLines = jest.fn(async () => false);
  // eventBus / executionWakeService / artifactIndexRepo 缺席 ⇒ 对应分支短路。
  return { service, gate };
}

describe("消费端端到端 · 回调路径（TaskService.handleCallback → 落库 failureReason）", () => {
  /**
   * 走**真实公开入口** `handleCallback`，读**落库的** `failureReason`。
   *
   * 断言对象是 `gate.calls[*].patch.failureReason` —— 即真实条件 UPDATE
   * 写进 `task_executions` 的那个值，而不是某个中间返回值。
   */
  const classifyViaCallback = async (input: {
    errorMessage?: string;
    logs?: string;
    exitCode?: number;
  }): Promise<ExecutionFailureReason | undefined> => {
    const row: CallbackRow = {
      id: "e1",
      taskId: "t1",
      // R-16/B-7 守卫：PENDING/WAITING 且 executorAddress 为 null ⇒ 回调被拒，
      // 根本走不到分类。故必须给一个**已派发**的行（RUNNING + 有地址）。
      status: ExecutionStatus.RUNNING,
      executorAddress: "10.0.0.1:8002",
    };
    const { service, gate } = makeCallbackService(row);
    await service["handleCallback"]([
      {
        executionId: "e1",
        status: "failed",
        // 刻意**不传** failureReason —— 强制走 `cb.failureReason ??
        // this.inferFailureReason(...)` 的兜底分支（这才是被守卫的那条路）。
        executorAddress: "10.0.0.1:8002",
        errorMessage: input.errorMessage,
        logs: input.logs,
        exitCode: input.exitCode,
      },
    ]);
    const written = gate.calls[gate.calls.length - 1]?.patch?.failureReason;
    return written as ExecutionFailureReason | undefined;
  };

  it("回调路径可达：分类结果真的落进了终态 UPDATE 的 patch", async () => {
    const reason = await classifyViaCallback({
      errorMessage: "ModuleNotFoundError: No module named 'pandas'",
    });
    // 这条断言同时证明：① 回调路径**可达**；② 归因**落库**（不是返回值）。
    expect(reason).toBe(ExecutionFailureReason.PACKAGE_FETCH_FAILED);
  });

  /**
   * **H-2 的核心否定式**（消费端级）：`ModuleNotFoundError` **绝不能**被说成
   * 「执行器离线」。
   *
   * 为什么这条比函数级的等价表更硬：函数级断言问的是「`classifyFailure` 返回
   * 什么」；这条问的是「**消费者**把什么写进了库」。裸 `enotfound` 加回任一
   * 消费者（或加回共享判据）⇒ 消费者写进库的就会变成 `executor_offline` ⇒
   * 本条红。
   */
  it("H-2（消费端级）：ModuleNotFoundError 绝不能落成 executor_offline", async () => {
    const reason = await classifyViaCallback({
      errorMessage:
        "Traceback (most recent call last):\n  File \"main.py\", line 1\nModuleNotFoundError: No module named 'pandas'",
    });
    expect(reason).not.toBe(ExecutionFailureReason.EXECUTOR_OFFLINE);
    expect(reason).toBe(ExecutionFailureReason.PACKAGE_FETCH_FAILED);
  });

  /**
   * **反向保护**：修 H-2 不能把真正的 DNS / 连接失败一起弄丢。
   * `executor_offline` 的 `\benotfound\b` / `\beconnrefused\b` 词边界必须仍能
   * 命中真实不可达文案 —— 否则「执行器离线」整类退化成 UNKNOWN。
   */
  it("反向（消费端级）：真实 DNS/连接失败仍落 executor_offline（词边界不得误伤）", async () => {
    for (const text of [
      "getaddrinfo ENOTFOUND registry.npmjs.org",
      "Error: connect ECONNREFUSED 127.0.0.1:8000",
    ]) {
      expect(await classifyViaCallback({ errorMessage: text })).toBe(
        ExecutionFailureReason.EXECUTOR_OFFLINE,
      );
    }
  });

  /**
   * 回调路径的**形状**差异：`exitCode` 非 0 是执行器跑完才有的证据。
   * 派发路径没有退出码 —— 故等值表不带 `exitCode`（既有 spec 已钉）。
   * 这里从**消费端**再钉一次：回调路径确实会因为 `exitCode` 改判。
   */
  it("回调路径独有：exitCode 非 0 是兜底证据（派发路径无退出码）", async () => {
    expect(
      await classifyViaCallback({ errorMessage: "boom", exitCode: 1 }),
    ).toBe(ExecutionFailureReason.SCRIPT_ERROR);
    expect(await classifyViaCallback({ errorMessage: "boom" })).toBe(
      ExecutionFailureReason.UNKNOWN,
    );
  });

  /**
   * **日志**也是分类证据（回调路径独有 logs 面）—— 执行器把真实失败写进
   * stdout/stderr 时，`errorMessage` 可能是空的。
   */
  it("回调路径：logs 单独也能驱动归因（errorMessage 为空时）", async () => {
    expect(
      await classifyViaCallback({
        errorMessage: undefined,
        logs: "bwrap: setting up uid map: Permission denied",
      }),
    ).toBe(ExecutionFailureReason.SANDBOX_UNAVAILABLE);
  });
});

// ════════════════════════════════════════════════════════════════════════
// §2 消费端端到端：派发路径（TaskProcessor.handle 的 catch 链）
// ════════════════════════════════════════════════════════════════════════

/**
 * 派发路径的最小真实替身。
 *
 * 真实链路：`handle(job)` → claim（条件 UPDATE）→ `executorService.dispatch`
 * **抛错** → catch → `classifyFailure({errorMessage, logs, errorCode})`
 * → `exec.failureReason` → finally 的终态条件 UPDATE patch。
 *
 * 与既有 `task.processor.spec.ts` 同款手法，但本 spec 额外**捕获 finally
 * 里那条条件 UPDATE 的 patch** —— 断言的是**落库的**归因。
 */
function makeDispatchHarness() {
  const exec: Record<string, any> = {
    id: "exec-1",
    taskId: "t1",
    status: ExecutionStatus.PENDING,
    params: {},
    attemptSeq: 0,
  };
  const task: Record<string, any> = {
    id: "t1",
    name: "task1",
    timeout: 10,
    executeMode: "single",
    status: TaskStatus.ACTIVE,
  };

  // ① claim 的条件 UPDATE（必须 affected>0，否则 handle 直接 return）。
  const claimQb: Record<string, any> = {};
  claimQb.update = jest.fn(() => claimQb);
  claimQb.set = jest.fn(() => claimQb);
  claimQb.where = jest.fn(() => claimQb);
  claimQb.andWhere = jest.fn(() => claimQb);
  claimQb.returning = jest.fn(() => claimQb);
  claimQb.execute = jest.fn(async () => ({
    affected: 1,
    raw: [{ attemptSeq: 1 }],
  }));

  // ② finally 的终态条件 UPDATE（patch 落在这里）。
  const persistCalls: Array<{
    whereSql: string;
    params: Record<string, unknown>;
    patch: Record<string, unknown>;
  }> = [];
  let whereSql = "";
  let params: Record<string, unknown> = {};
  let patch: Record<string, unknown> = {};
  const persistQb: Record<string, any> = {};
  persistQb.update = jest.fn(() => persistQb);
  persistQb.set = jest.fn((p: Record<string, unknown>) => {
    patch = p;
    return persistQb;
  });
  persistQb.where = jest.fn((sql: string, p: Record<string, unknown>) => {
    whereSql = sql;
    params = p;
    return persistQb;
  });
  persistQb.andWhere = jest.fn(() => persistQb);
  persistQb.returning = jest.fn(() => persistQb);
  persistQb.execute = jest.fn(async () => {
    persistCalls.push({ whereSql, params, patch });
    return { affected: 1, raw: [{ id: "exec-1", executorAddress: null }] };
  });

  const executorService = { dispatch: jest.fn(), dispatchBroadcast: jest.fn() };
  const processor = Object.create(TaskProcessor.prototype) as Record<string, any>;
  processor.execRepo = {
    findOne: jest.fn(async () => exec),
    createQueryBuilder: jest.fn(() => claimQb),
  };
  processor.taskRepo = { findOne: jest.fn(async () => task) };
  processor.executorService = executorService;
  processor.aiAnalysisService = { analyzeFailure: jest.fn(async () => "") };
  processor.logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  processor.taskService = {
    publishTerminalEventForDispatch: jest.fn(),
    publishExecutionWake: jest.fn(),
  };
  processor.configService = { get: jest.fn(() => "") };
  processor.dataSource = {
    createQueryRunner: jest.fn(() => ({
      connect: jest.fn(async () => undefined),
      startTransaction: jest.fn(async () => undefined),
      commitTransaction: jest.fn(async () => undefined),
      rollbackTransaction: jest.fn(async () => undefined),
      release: jest.fn(async () => undefined),
      manager: { createQueryBuilder: jest.fn(() => persistQb) },
    })),
  };

  return { processor, executorService, exec, persistCalls };
}

describe("消费端端到端 · 派发路径（TaskProcessor.handle 的 catch 链 → 落库 failureReason）", () => {
  /**
   * 走**真实** `TaskProcessor.handle(job)`，让 `dispatch` 抛错，读**落库的**
   * `failureReason`。
   */
  const classifyViaDispatch = async (
    error: Error,
  ): Promise<ExecutionFailureReason | undefined> => {
    const h = makeDispatchHarness();
    h.executorService.dispatch.mockRejectedValue(error);
    await expect(
      h.processor["handle"]({ data: { executionId: "exec-1" } } as any),
    ).rejects.toThrow();
    const written = h.persistCalls[h.persistCalls.length - 1]?.patch?.failureReason;
    return written as ExecutionFailureReason | undefined;
  };

  it("派发路径可达：分类结果真的落进了终态 UPDATE 的 patch", async () => {
    const reason = await classifyViaDispatch(
      new Error("ModuleNotFoundError: No module named 'pandas'"),
    );
    expect(reason).toBe(ExecutionFailureReason.PACKAGE_FETCH_FAILED);
  });

  /**
   * **H-2 的核心否定式**（派发端级）：与回调路径**同一条文案**必须得到**同一个**
   * 归因，且都**不是** `executor_offline`。
   *
   * 这条断言是「两条路径等值」的**端到端版**：它不再问「两个函数调用是否相等」
   * （那在两条路径共用同一个函数时会退化成恒真），而是问「**消费者各自写进
   * 库的值**是否相等且正确」。
   */
  it("H-2（派发端级）：ModuleNotFoundError 绝不能落成 executor_offline", async () => {
    const reason = await classifyViaDispatch(
      new Error(
        "Traceback (most recent call last):\n  File \"main.py\", line 1\nModuleNotFoundError: No module named 'requests'",
      ),
    );
    expect(reason).not.toBe(ExecutionFailureReason.EXECUTOR_OFFLINE);
    expect(reason).toBe(ExecutionFailureReason.PACKAGE_FETCH_FAILED);
  });

  it("反向（派发端级）：真实 DNS/连接失败仍落 executor_offline", async () => {
    for (const text of [
      "getaddrinfo ENOTFOUND registry.npmjs.org",
      "Error: connect ECONNREFUSED 127.0.0.1:8000",
    ]) {
      expect(await classifyViaDispatch(new Error(text))).toBe(
        ExecutionFailureReason.EXECUTOR_OFFLINE,
      );
    }
  });

  /**
   * **码化优先**（派发路径独有）：中台自产的 `AppError` 带业务码 ⇒
   * **码表命中即确定性归因，文案不得翻案**。
   *
   * 这条走的是**消费者**入口（processor catch 里读 `err.errorCode`），
   * 而非直接调 `classifyFailure`。
   */
  it("码化优先（派发端级）：AppError 的码命中码表 ⇒ 文案不得翻案", async () => {
    // 延迟 require，避免在模块顶层引入错误码表的加载顺序耦合。
    const { AppError } = require("../../../common/errors/app-error");
    const err = new AppError("PINNED_EXECUTOR_OFFLINE", {
      appName: "executor-python-e2e",
      executorId: "8a7e160b-80e5-4dff-b88a-b414908fc9c8",
    });
    // 故意让文案命中 TIMEOUT 规则 —— 码表必须赢。
    const reason = await classifyViaDispatch(err);
    expect(reason).toBe(ExecutionFailureReason.EXECUTOR_OFFLINE);
  });
});

// ════════════════════════════════════════════════════════════════════════
// §3 可测判据：消费者**不得**内联分类副本（含裸 enotfound）
// ════════════════════════════════════════════════════════════════════════

/**
 * 判别性令牌 —— 只可能出现在**分类判据**里的具体短语/整词。
 *
 * 为什么这份名单与既有 spec 的 `TOKENS` 不同：既有那份**刻意排除**了
 * `enotfound` 与中文词（因为它用**文本搜索**，注释里会出现这个词）。
 * 本份的判据**不看注释**（用 TypeScript AST 只取**代码位置**的字符串/正则
 * 字面量），所以可以放心纳入 `enotfound` 这类**裸子串**——
 * 这正是「裸 enotfound 加回消费者」这条回归的原始形态。
 *
 * ## 名单的**准入条件**（每一条都必须是「load-bearing」的）
 *
 * 一条令牌只有在「**存在某个被共享判据成功归因的真实文案**包含它」时，
 * 才是有意义的——否则它就是一条**永不触发**的装饰性令牌（空断言）。
 * 这条准入条件由下方 `判据名单必须逐条 load-bearing` 一条用例**机械校验**。
 *
 * ⛔ 因此**刻意不含** `no online executor`：共享判据**不**把它归成任何
 * 已知原因（它落 UNKNOWN）——它是**执行器侧**的文案族，不是中台判据的
 * 分支，纳入即装饰。
 */
const DISCRIMINATIVE_TOKENS = [
  "enotfound",
  "econnrefused",
  "getaddrinfo",
  "socket hang up",
  "modulenotfounderror",
  "no module named",
  "cannot find module",
  "module not found",
  "no interpreter found",
  "no download found",
  "python downloads are set to",
  "bwrap",
  "task_sandbox",
  "sandbox_unavailable",
  "task sandbox",
  "cannot resolve packageurl",
  "no available executor",
  "traceback",
  "syntaxerror",
  "referenceerror",
  "typeerror",
  "uncaught",
  "package fetch",
  "pull package",
  "download package",
  "npm install",
  "pip install",
  "解释器",
  "沙箱",
  "无法解析",
  "克隆代码",
  "代码拉取",
  "依赖安装",
  "安装依赖",
  "拉取依赖",
  "执行已超时",
  "无可用执行器",
  "没有可用",
];

/**
 * **见证文案**（witness corpus）——真实失败文本的样本集合。
 *
 * 用途：判据名单的准入条件靠它判定（见 `判据名单必须逐条 load-bearing`）。
 * 这份文案也是端到端断言用的样本，两处同源 ⇒ 改一处两处都红。
 */
const WITNESS_TEXTS: string[] = [
  // DNS / 连接（EXECUTOR_OFFLINE）
  "getaddrinfo ENOTFOUND registry.npmjs.org",
  "Error: connect ECONNREFUSED 127.0.0.1:8000",
  "socket hang up",
  "no available executor for task t1",
  "没有可用的执行器",
  "无可用执行器：全部候选均离线或满载",
  // 依赖缺失（PACKAGE_FETCH）
  "ModuleNotFoundError: No module named 'pandas'",
  "Cannot find module 'foo'",
  "module not found",
  "npm install failed with exit code 1",
  "pip install failed",
  "package fetch failed",
  "pull package timeout",
  "download package failed",
  "克隆代码失败：认证被拒绝",
  "代码拉取失败",
  "依赖安装失败",
  "安装依赖失败",
  "拉取依赖失败",
  // 解释器（INTERPRETER_UNAVAILABLE）
  "No interpreter found for Python 3.7",
  "No download found for request: cpython-3.7-x",
  "python downloads are set to 'manual'",
  "解释器 3.7 无法获取",
  // 沙箱（SANDBOX_UNAVAILABLE）
  "bwrap: setting up uid map: Permission denied",
  "task_sandbox unavailable",
  "task sandbox is disabled",
  "sandbox_unavailable",
  "沙箱不可用",
  // 应用缺失（APPLICATION_MISSING）
  "Cannot resolve packageUrl for application 0b7c1f2e not found",
  "无法解析 packageUrl",
  // 超时（TIMEOUT）
  "execution timed out after 300s",
  "执行已超时",
  // 脚本错误（SCRIPT_ERROR）
  "Traceback (most recent call last): SyntaxError: invalid syntax",
  "ReferenceError: foo is not defined",
  "TypeError: cannot read property",
  "Uncaught Error: boom",
];

/** 判据用到的共享判据（**唯一事实源**，从模块直接取，不抄一份）。 */
const SHARED_PATTERNS: Array<[string, RegExp]> = [
  ["INTERPRETER_UNAVAILABLE_PATTERN", INTERPRETER_UNAVAILABLE_PATTERN],
  ["EXECUTOR_OFFLINE_PATTERN", EXECUTOR_OFFLINE_PATTERN],
  ["SANDBOX_UNAVAILABLE_PATTERN", SANDBOX_UNAVAILABLE_PATTERN],
  ["APPLICATION_MISSING_PATTERN", APPLICATION_MISSING_PATTERN],
  ["TIMEOUT_PATTERN", TIMEOUT_PATTERN],
  ["PACKAGE_FETCH_PATTERN", PACKAGE_FETCH_PATTERN],
  ["SCRIPT_ERROR_PATTERN", SCRIPT_ERROR_PATTERN],
];

export interface InlineCopyFinding {
  line: number;
  literal: string;
  matchedPattern: string;
  /** `whole-pattern` = 整段命中共享判据；`substring-token` = 包含判别性令牌（裸子串形态）。 */
  kind: "whole-pattern" | "substring-token";
}

/** 「字符串/正则字面量出现在**内容比对位置**」的判定。 */
const MATCH_METHODS = new Set([
  "includes",
  "test",
  "startsWith",
  "endsWith",
  "match",
  "search",
  "matchAll",
  "replace",
  "split",
]);

/**
 * 判据函数：找出源码里**内联**的分类判据副本。
 *
 * ## 判据的三个维度
 *
 * ① **位置**——字面量必须出现在「拿它去比对运行时内容」的位置：
 *    `x.includes("…")` / `re.test(x)` / `new RegExp("…")` / `x === "…"`。
 *    纯**声明**位置的字面量（如 `const field = "timeout"`）**不算**——
 *    否则「字段名叫 timeout」这类无害写法会误报。
 * ② **形态**——正则字面量（`/…/i`）在**任何**位置都算（常量定义处就是
 *    「抄了一份正则」的典型形态）。
 * ③ **内容**——字面量命中下列**任一**条即算副本：
 *    (a) 它**整段**被某条共享判据命中（抄了整条判据的分支，如
 *        `"no module named"` / `"cannot resolve packageurl"`）；
 *    (b) 它**包含**某个判别性令牌（抄了判据的**子串**，如裸 `"enotfound"` /
 *        `"getaddrinfo"` / `"bwrap"` / `"解释器"`）。
 *
 * ## 为什么 (b) 不可省 —— 这是判据设计里最关键的一环
 *
 * 只用 (a) 的话，消费者内联 `msg.includes("getaddrinfo")` **检不出来**：
 * 裸字面量 `"getaddrinfo"` 本身**不**被任何共享判据命中（共享判据要的是
 * `getaddrinfo ENOTFOUND` 整句里的 `ENOTFOUND` 片段），于是 (a) 漏判。
 * 而 (b) 正是补这个洞的：**裸子串形态才是真实的回归形态**——H-2 的原始
 * 缺陷就是消费者（或判据）里写了裸 `enotfound`。
 *
 * ## 为什么用 AST 而不是文本搜索
 *
 * 文本搜索会被**注释**污染：消费者的注释里合法出现「解释器」「enotfound」
 * 等词（讲判据为什么这么写）。文本搜索要么漏（排除注释 ⇒ 复杂）、
 * 要么误报（不排除 ⇒ 一改注释就红）。AST 只看**代码位置**，天然区分两者。
 *
 * ## 返回值非空的证明（见下方三条自测用例）
 *
 * 本函数不是「写出来好看的断言」——spec 里有**正例 ×2 + 反例**三条自测，
 * 证明它对「消费者内联裸 enotfound」**确实非空**，对普通业务字符串**确实为空**。
 */
export function findInlineClassificationCopies(
  source: string,
  fileName: string,
): InlineCopyFinding[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const findings: InlineCopyFinding[] = [];
  const seen = new Set<string>();

  const lineOf = (n: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;

  const isModuleSpecifier = (
    n: ts.Node,
    parent: ts.Node | undefined,
  ): boolean => {
    if (!parent) return false;
    if (
      ts.isImportDeclaration(parent) ||
      ts.isExportDeclaration(parent) ||
      ts.isImportEqualsDeclaration(parent) ||
      ts.isExternalModuleReference(parent)
    ) {
      return true;
    }
    return (
      ts.isCallExpression(parent) &&
      ts.isIdentifier(parent.expression) &&
      parent.expression.text === "require"
    );
  };

  const check = (
    n: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.RegularExpressionLiteral,
    parent: ts.Node | undefined,
  ): void => {
    if (isModuleSpecifier(n, parent)) return;
    const lower = n.text.toLowerCase();
    // ③(a) 整段命中共享判据 → 抄了判据的分支。
    const whole = SHARED_PATTERNS.find(([, re]) => re.test(n.text));
    if (whole) {
      push(n, whole[0], "whole-pattern");
      return;
    }
    // ③(b) 包含判别性令牌 → 抄了判据的子串（**裸子串形态**）。
    const token = DISCRIMINATIVE_TOKENS.find((t) => lower.includes(t));
    if (token) {
      push(n, `TOKEN:${token}`, "substring-token");
    }
  };

  const push = (
    n: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.RegularExpressionLiteral,
    matchedPattern: string,
    kind: InlineCopyFinding["kind"],
  ): void => {
    const key = `${lineOf(n)}::${n.text}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({
      line: lineOf(n),
      literal: n.text,
      matchedPattern,
      kind,
    });
  };

  const visit = (node: ts.Node, parent?: ts.Node): void => {
    // ② 正则字面量：任何位置都算（抄一份正则的典型形态就是常量定义）。
    if (ts.isRegularExpressionLiteral(node)) check(node, parent);

    if (ts.isCallExpression(node)) {
      const ex = node.expression;
      const isMatchCall =
        (ts.isPropertyAccessExpression(ex) &&
          MATCH_METHODS.has(ex.name.text)) ||
        (ts.isIdentifier(ex) && ex.text === "RegExp");
      if (isMatchCall) {
        for (const a of node.arguments) {
          if (
            ts.isStringLiteral(a) ||
            ts.isNoSubstitutionTemplateLiteral(a) ||
            ts.isRegularExpressionLiteral(a)
          ) {
            check(a, node);
          }
        }
      }
    }

    // ① `x === "…"` / `x !== "…"` 也是比对位置。
    if (ts.isBinaryExpression(node)) {
      const kind = node.operatorToken.kind;
      if (
        kind >= ts.SyntaxKind.EqualsEqualsToken &&
        kind <= ts.SyntaxKind.EqualsEqualsEqualsToken
      ) {
        for (const side of [node.left, node.right]) {
          if (ts.isStringLiteral(side)) check(side, node);
        }
      }
    }

    ts.forEachChild(node, (child) => visit(child, node));
  };

  visit(sf);
  return findings;
}

describe("可测判据：消费者不得内联分类副本（含裸 enotfound）", () => {
  /**
   * **判据自测 · 正例**：消费者内联裸 `enotfound` ⇒ 判据**必须非空**。
   *
   * 这一条是本 spec 的**自证**：它证明「判据能检出 H-2 的原始形态」。
   * 若将来有人把判据改宽松（例如只扫注释、或只认带空格的分词形态），
   * 这条会红。
   *
   * 注意命中形态：裸 `"enotfound"` **整段**就被 `EXECUTOR_OFFLINE_PATTERN`
   * 的 `\benotfound\b` 命中 ⇒ 走 (a) 那条路径（`whole-pattern`）。
   * 这正是 H-2 的要害：裸 `enotfound` 与带词边界的 `\benotfound\b` 在
   * **字面上只差一个反斜杠**，而判据必须能认出这个裸形态。
   */
  it("判据自测 · 正例：内联裸 enotfound 必被检出（判据非空）", () => {
    const source = `
      const msg = String(err);
      if (msg.includes("enotfound")) {
        return "executor_offline";
      }
    `;
    const found = findInlineClassificationCopies(source, "synthetic.ts");
    expect(found.length).toBeGreaterThan(0);
    expect(found.some((f) => f.literal === "enotfound")).toBe(true);
    expect(
      found.some(
        (f) => f.matchedPattern === "EXECUTOR_OFFLINE_PATTERN",
      ),
    ).toBe(true);
  });

  /** 判据自测 · 正例：内联成**正则常量**的形态同样必被检出。 */
  it("判据自测 · 正例：内联正则常量形态（/enotfound/i）必被检出", () => {
    const source = `
      const OFFLINE_RE = /enotfound/i;
      if (OFFLINE_RE.test(msg)) { return "executor_offline"; }
    `;
    const found = findInlineClassificationCopies(source, "synthetic.ts");
    expect(found.length).toBeGreaterThan(0);
    expect(found.some((f) => f.literal.includes("enotfound"))).toBe(true);
  });

  /**
   * 判据自测 · 正例：内联**整条判据分支**（`"no module named"`）必被检出。
   *
   * 这一条覆盖 (a) 那条路径（整段命中共享判据）——它与 (b) 是**两条独立**
   * 的检出路径，缺一条就漏一种抄法。
   */
  it("判据自测 · 正例：内联整条判据分支（\"no module named\"）必被检出", () => {
    const source = `
      if (msg.includes("no module named")) {
        return "package_fetch_failed";
      }
    `;
    const found = findInlineClassificationCopies(source, "synthetic.ts");
    expect(found.length).toBeGreaterThan(0);
    expect(found.some((f) => f.kind === "whole-pattern")).toBe(true);
  });

  /**
   * 判据自测 · **反例**：普通业务字符串**不得**被误报。
   *
   * 这条证明判据是**位置敏感**的：`"timeout"` 作为字段名 / 错误码出现时
   * 不算副本（否则判据会变成「一改文案即红」的脆弱断言）。
   */
  it("判据自测 · 反例：字段名/普通文案不得被误报（判据位置敏感）", () => {
    const source = `
      const field = "timeout";
      const code = "TASK_DEPENDENCY_NOT_FOUND";
      const msg = "boom";
      if (msg === "boom") { return field; }
      if (msg.includes(code)) { return "other"; }
    `;
    expect(findInlineClassificationCopies(source, "synthetic.ts")).toEqual([]);
  });

  /**
   * **消费者全集**：全 `src/` 里只有这两处 import `classifyFailure`。
   *
   * 这条的**作用**是把「消费者集合」变成**显式且被强制**的清单：
   * · 新增第三条分类路径（某个新文件也 import `classifyFailure`）⇒ 本条红
   *   ⇒ 强制补上该路径的**端到端**断言（而不是默默多一条分类路径）；
   * · 既有 27 条的「常量唯一性」守卫**挡不住**这个 —— 它只管**判据常量**
   *   的定义处，管不到「谁在调 classifyFailure」。
   */
  it("消费者全集恰为两处（新增第三条分类路径会红，强制补端到端断言）", () => {
    const SRC_ROOT = join(__dirname, "../../..");
    const importers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "dist") continue;
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".spec.ts")) {
          continue;
        }
        const src = readFileSync(full, "utf8");
        if (
          /import\s*\{[^}]*\bclassifyFailure\b[^}]*\}\s*from\s*["'][^"']*failure-classification/.test(
            src,
          )
        ) {
          importers.push(
            full.slice(SRC_ROOT.length + 1).replace(/\\/g, "/"),
          );
        }
      }
    };
    walk(SRC_ROOT);
    expect(importers.sort()).toEqual([
      "modules/task/task.processor.ts",
      "modules/task/task.service.ts",
    ]);
  });

  /**
   * **两个消费者都不得内联分类副本**（裸 `enotfound` 加回消费者 ⇒ 本条红）。
   *
   * 这是 §3 反向验证的**结构侧**钉子，与 §1/§2 的**行为侧**钉子互为备份：
   * 行为侧抓「内联副本改变了归因」，结构侧抓「内联副本存在但当前恰好没改归因」。
   */
  it("两个消费者都不得内联分类副本（0 处判据命中）", () => {
    const SRC_ROOT = join(__dirname, "../../..");
    for (const rel of [
      "modules/task/task.processor.ts",
      "modules/task/task.service.ts",
    ]) {
      const full = join(SRC_ROOT, rel);
      const found = findInlineClassificationCopies(
        readFileSync(full, "utf8"),
        rel,
      );
      // 失败信息带出命中位置，便于直接定位「又抄了一份」。
      expect({
        file: rel,
        findings: found.map((f) => `L${f.line} ${f.matchedPattern} ${f.literal}`),
      }).toEqual({ file: rel, findings: [] });
    }
  });

  /**
   * **判据名单本身**钉桩：`enotfound` **必须**在名单里。
   *
   * 为什么这条重要：既有 `path-parity.spec.ts` 的 `TOKENS` **刻意排除**了
   * `enotfound`（因为它用**文本搜索**，注释里会出现这个词）。本判据用
   * AST 只看代码位置，故可以纳入。若将来有人「为了少误报」把它从名单里
   * 删掉 ⇒ 本条红（那时就得同时给出替代判据，否则裸 enotfound 回归会漏）。
   */
  it("判据名单必须含裸 enotfound（既有 TOKENS 刻意排除的正是这条）", () => {
    expect(DISCRIMINATIVE_TOKENS).toContain("enotfound");
    expect(DISCRIMINATIVE_TOKENS).toContain("modulenotfounderror");
  });

  /**
   * **判据名单必须逐条 load-bearing**——每一条令牌都必须真的出现在某条
   * **被共享判据成功归因**的真实文案里。
   *
   * ## 为什么这条是关键的自检（不是装饰）
   *
   * 一条令牌若**不**满足这个条件，它就是一条**永不触发**的装饰性令牌——
   * 它出现在名单里看起来很吓人，实际上从不禁���任何东西。
   * 本轮写这条断言时**真的抓到了**一个：初版名单里的 `getaddrinfo` 与
   * `no online executor` 都不被任何共享判据整段命中（前者要的是
   * `ENOTFOUND` 片段，后者根本落 UNKNOWN）⇒ 它们在 (a) 那条路径上是
   * 死的。改为按**令牌子串**（(b) 路径）判定后，`getaddrinfo` 才真正
   * load-bearing（消费者内联 `"getaddrinfo"` 会被检出）。
   *
   * 这条断言把「load-bearing」变成**机械可验**的：将来有人往名单里加一条
   * 装饰性令牌 ⇒ 本条红。
   */
  it("判据名单必须逐条 load-bearing（每条令牌都出现在被成功归因的真实文案里）", () => {
    const corpus = WITNESS_TEXTS.join("\n").toLowerCase();
    const dead = DISCRIMINATIVE_TOKENS.filter((t) => !corpus.includes(t));
    expect({ deadTokens: dead }).toEqual({ deadTokens: [] });
  });

  /**
   * **见证文案必须真的被共享判据归成已知原因**（不是全落 UNKNOWN）。
   *
   * 这条保证「见证文案」这份样本是**有效的归因证据**——若某条文案其实
   * 落 UNKNOWN，把它当见证就会让上��条 load-bearing 断言失去意义。
   */
  it("见证文案必须都被共享判据归成已知原因（不得全落 UNKNOWN）", () => {
    const unknown = WITNESS_TEXTS.filter(
      (t) => classifyFailure({ errorMessage: t }) === ExecutionFailureReason.UNKNOWN,
    );
    expect({ unknownWitnesses: unknown }).toEqual({ unknownWitnesses: [] });
  });
});
