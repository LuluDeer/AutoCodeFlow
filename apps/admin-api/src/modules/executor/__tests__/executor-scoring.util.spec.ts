import {
  buildDispatchDecisionLogInput,
  buildEstimatedDurationsIndex,
  buildSelectLeastLoadedDecisionLog,
  EMPTY_ESTIMATED_INDEX,
  filterAvailableByCapacity,
  scoreAndSortCandidates,
  type ScoredExecutorCandidate,
} from "../executor-scoring.util";
import type { Executor } from "../entities/executor.entity";

/**
 * B0 拆分的独立单测（不走 DI 装配，直接调用纯函数）。
 *
 * ## 为什么这些用例是「B 方案的核心资产」
 *
 * 搬出这三个文件之后，`executor.service.ts` 的选优/估时/决策日志逻辑就可以
 * **不构造整个 service**（21 个位置参数、9 个 Repository 替身、1 个 BullMQ
 * 队列）就单测。这是 A 方案（只抽 util）给不了的东西——A 抽出来的 util
 * 同样能单测，但**决策逻辑仍在 service 里**（比如「评分后要不要先取快照」
 * 这类跨步骤的顺序约束无法脱离 service 验证）。
 *
 * 本文件把**顺序约束**也钉住了：估时取样发生在评分之前（占坑会原地改
 * `runningTaskCount`，晚取就拿到被改过的数）。
 */

/** 造一个最小 Executor（只需评分与容量闸关心的字段）。 */
function makeExecutor(over: Partial<Executor> = {}): Executor {
  return {
    id: "exec-1",
    address: "10.0.0.1",
    appName: "app",
    runningTaskCount: 0,
    maxConcurrentTasks: 10,
    cpuUsage: 0,
    memUsage: 0,
    ...over,
  } as Executor;
}

describe("filterAvailableByCapacity — 容量闸", () => {
  it("滤掉已达容量上限的候选（runningTaskCount >= max）", () => {
    const full = makeExecutor({ id: "full", runningTaskCount: 10, maxConcurrentTasks: 10 });
    const room = makeExecutor({ id: "room", runningTaskCount: 9, maxConcurrentTasks: 10 });
    expect(filterAvailableByCapacity([full, room]).map((e) => e.id)).toEqual(["room"]);
  });

  it("maxConcurrentTasks 缺省（null/undefined）视为不限容量", () => {
    const noLimitNull = makeExecutor({ id: "n", runningTaskCount: 999, maxConcurrentTasks: null });
    const noLimitUndef = makeExecutor({ id: "u", runningTaskCount: 999, maxConcurrentTasks: undefined });
    expect(filterAvailableByCapacity([noLimitNull, noLimitUndef]).map((e) => e.id)).toEqual(["n", "u"]);
  });

  it("runningTaskCount 恰好等于上限时**被滤掉**（闸是 < max，不是 <=）", () => {
    const atLimit = makeExecutor({ runningTaskCount: 3, maxConcurrentTasks: 3 });
    expect(filterAvailableByCapacity([atLimit])).toHaveLength(0);
  });

  it("空候选集返回空数组（不抛错）", () => {
    expect(filterAvailableByCapacity([])).toEqual([]);
  });
});

describe("scoreAndSortCandidates — 加权评分 + 升序", () => {
  it("按综合负载分升序（分小者在前）", () => {
    const busy = makeExecutor({ id: "busy", runningTaskCount: 5, maxConcurrentTasks: 10 });
    const idle = makeExecutor({ id: "idle", runningTaskCount: 0, maxConcurrentTasks: 10 });
    const scored = scoreAndSortCandidates([busy, idle], () => []);
    expect(scored.map((s) => s.executor.id)).toEqual(["idle", "busy"]);
    expect(scored[0].score).toBeLessThan(scored[1].score);
  });

  it("同分时保持候选原序（稳定排序）——并列时不得换机", () => {
    const a = makeExecutor({ id: "a", runningTaskCount: 1, maxConcurrentTasks: 10 });
    const b = makeExecutor({ id: "b", runningTaskCount: 1, maxConcurrentTasks: 10 });
    const c = makeExecutor({ id: "c", runningTaskCount: 1, maxConcurrentTasks: 10 });
    const scored = scoreAndSortCandidates([a, b, c], () => []);
    expect(scored.map((s) => s.executor.id)).toEqual(["a", "b", "c"]);
    expect(scored[0].score).toBe(scored[1].score);
  });

  it("估时样本影响评分：长任务惩罚使分数变高（同等负载下）", () => {
    const e = makeExecutor({ runningTaskCount: 1, maxConcurrentTasks: 10 });
    const without = scoreAndSortCandidates([e], () => []);
    const withLong = scoreAndSortCandidates([e], () => [7200]);
    expect(withLong[0].score).toBeGreaterThan(without[0].score);
  });

  it("估时取值器按候选逐台取值（每台只取一次自己的样本）", () => {
    const seen: string[] = [];
    const a = makeExecutor({ id: "a" });
    const b = makeExecutor({ id: "b" });
    scoreAndSortCandidates([a, b], (executor) => {
      seen.push(executor.id);
      return [];
    });
    expect(seen.sort()).toEqual(["a", "b"]);
  });

  it("空候选集返回空数组（不抛错）", () => {
    expect(scoreAndSortCandidates([], () => [])).toEqual([]);
  });
});

describe("buildEstimatedDurationsIndex — 估时样本池（ADR-017 阶段 3）", () => {
  it("有行身份的样本归到**该行**（同址多行不互相污染）", () => {
    const index = buildEstimatedDurationsIndex(
      [{ executorAddress: "10.0.0.1", executorId: "row-1", taskId: "t1" }],
      new Map([["t1", 600]]),
    );
    expect(index.forExecutor({ id: "row-1", address: "10.0.0.1" })).toEqual([600]);
    // 同址的另一行**不得**读到这份样本
    expect(index.forExecutor({ id: "row-2", address: "10.0.0.1" })).toEqual([]);
  });

  it("无行身份的存量样本归到**地址**（迁移 0055 刻意不回填 executorId）", () => {
    const index = buildEstimatedDurationsIndex(
      [{ executorAddress: "10.0.0.1", executorId: null, taskId: "t1" }],
      new Map([["t1", 300]]),
    );
    expect(index.forExecutor({ id: "any-row", address: "10.0.0.1" })).toEqual([300]);
  });

  it("行身份样本与地址样本在取值时**合并**（存量机也能拿回自己的历史近似）", () => {
    const index = buildEstimatedDurationsIndex(
      [
        { executorAddress: "10.0.0.1", executorId: "row-1", taskId: "t1" },
        { executorAddress: "10.0.0.1", executorId: null, taskId: "t2" },
      ],
      new Map([
        ["t1", 100],
        ["t2", 200],
      ]),
    );
    const samples = index.forExecutor({ id: "row-1", address: "10.0.0.1" });
    expect(samples).toHaveLength(2);
    expect(samples).toContain(100);
    expect(samples).toContain(200);
  });

  it("任务 id 查不到时长时入池 **null**（不是 0）——由评分公式按缺省处理", () => {
    const index = buildEstimatedDurationsIndex(
      [{ executorAddress: "10.0.0.1", executorId: "row-1", taskId: "gone" }],
      new Map(),
    );
    expect(index.forExecutor({ id: "row-1", address: "10.0.0.1" })).toEqual([null]);
  });

  it("空索引恒返回空样本（longTaskPenalty=0 的降级路径）", () => {
    expect(EMPTY_ESTIMATED_INDEX.forExecutor({ id: "x", address: "y" })).toEqual([]);
  });

  it("空输入返回等价于空索引的取值器", () => {
    const index = buildEstimatedDurationsIndex([], new Map());
    expect(index.forExecutor({ id: "x", address: "y" })).toEqual([]);
  });
});

describe("buildSelectLeastLoadedDecisionLog — 选机路径决策日志", () => {
  const scored: ScoredExecutorCandidate[] = [
    { executor: makeExecutor({ id: "a", address: "10.0.0.1", runningTaskCount: 0 }), score: 0.1 },
    { executor: makeExecutor({ id: "b", address: "10.0.0.2", runningTaskCount: 1 }), score: 0.2 },
    { executor: makeExecutor({ id: "c", address: "10.0.0.3", runningTaskCount: 2 }), score: 0.3 },
    { executor: makeExecutor({ id: "d", address: "10.0.0.4", runningTaskCount: 3 }), score: 0.4 },
    { executor: makeExecutor({ id: "e", address: "10.0.0.5", runningTaskCount: 4 }), score: 0.5 },
  ];

  it("事件名为 selectLeastLoaded.decision 且任务上下文恒为 null", () => {
    const log = buildSelectLeastLoadedDecisionLog({
      poolSize: 5,
      afterFilters: 5,
      scored,
    });
    expect(log.event).toBe("selectLeastLoaded.decision");
    expect(log.task).toBeNull();
    expect(log.executionId).toBeNull();
  });

  it("selected 是评分第一名，topRunners 取其后**前三名**", () => {
    const log = buildSelectLeastLoadedDecisionLog({
      poolSize: 5,
      afterFilters: 5,
      scored,
    });
    expect(log.selected.address).toBe("10.0.0.1");
    expect(log.topRunners.map((t) => t.address)).toEqual([
      "10.0.0.2",
      "10.0.0.3",
      "10.0.0.4",
    ]);
  });

  it("候选不足 4 台时 topRunners 只取实际有的", () => {
    const log = buildSelectLeastLoadedDecisionLog({
      poolSize: 2,
      afterFilters: 2,
      scored: scored.slice(0, 2),
    });
    expect(log.topRunners).toHaveLength(1);
    expect(log.scoredCount).toBe(2);
  });
});

describe("buildDispatchDecisionLogInput — 派发路径决策日志", () => {
  it("事件名为 dispatch.decision 且带任务上下文", () => {
    const log = buildDispatchDecisionLogInput({
      taskName: "my-task",
      executionId: "exec-9",
      poolSize: 10,
      afterFilters: 5,
      scoredCount: 5,
      selected: {
        address: "10.0.0.1",
        runningTaskCount: 0,
        maxConcurrentTasks: 10,
      },
      scoredSnapshot: [
        {
          address: "10.0.0.1",
          score: 0.25,
          runningTaskCount: 0,
          maxConcurrentTasks: 10,
        },
      ],
    });
    expect(log.event).toBe("dispatch.decision");
    expect(log.task).toBe("my-task");
    expect(log.executionId).toBe("exec-9");
  });

  it("选中者的分数**从快照按地址回查**（占坑会原地改负载，故须先截快照）", () => {
    const log = buildDispatchDecisionLogInput({
      taskName: "t",
      executionId: "e",
      poolSize: 1,
      afterFilters: 1,
      scoredCount: 1,
      selected: {
        address: "10.0.0.1",
        runningTaskCount: 99, // 已被占坑改过的值
        maxConcurrentTasks: 10,
      },
      scoredSnapshot: [
        {
          address: "10.0.0.1",
          score: 0.42,
          runningTaskCount: 0, // 截取时的原值
          maxConcurrentTasks: 10,
        },
      ],
    });
    // 分数来自快照（0.42），不是 selected 上被改过的字段
    expect(log.selected.score).toBe(0.42);
    expect(log.selected.runningTaskCount).toBe(99);
  });

  it("快照里查不到选中者时**抛错**（score=null 不被 schema 接受）——与原实现同", () => {
    // schema 明确要求 selected.score 是有限数字：`score=0` 在这份日志里的语义是
    // 「负载评分最低 = 最优」，恰恰是最有误导性的值（见 schema 的注释）。
    // ⇒ 查不到选中者时**必须抛错**而不是落一个假分数。
    //
    // ⚠️ 生产不可达（schema 注释原话）：选中者必然来自被评分的候选集 ⇒ 必然在
    // 快照里。真正落到这条路径时，service 侧会 catch 并降级成一条 warn
    // （「决策日志坏了不该让派发失败」）。
    expect(() =>
      buildDispatchDecisionLogInput({
        taskName: "t",
        executionId: "e",
        poolSize: 1,
        afterFilters: 1,
        scoredCount: 1,
        selected: {
          address: "not-in-snapshot",
          runningTaskCount: 1,
          maxConcurrentTasks: 10,
        },
        scoredSnapshot: [],
      }),
    ).toThrow(/selected\.score 必须是有限数字/);
  });

  it("三张命中面缺省时**显式输出 null**（「没这个字段」与「不适用」可区分）", () => {
    const log = buildDispatchDecisionLogInput({
      taskName: "t",
      executionId: "e",
      poolSize: 1,
      afterFilters: 1,
      scoredCount: 1,
      selected: {
        address: "10.0.0.1",
        runningTaskCount: 0,
        maxConcurrentTasks: 10,
      },
      scoredSnapshot: [
        {
          address: "10.0.0.1",
          score: 0.1,
          runningTaskCount: 0,
          maxConcurrentTasks: 10,
        },
      ],
    });
    expect(log.deploymentAffinity).toBeNull();
    expect(log.deploymentConstraint).toBeNull();
    expect(log.interpreterCacheAffinity).toBeNull();
    // 字段**存在**且为 null（不是被 JSON.stringify 省略）
    expect("deploymentAffinity" in log).toBe(true);
    expect("deploymentConstraint" in log).toBe(true);
    expect("interpreterCacheAffinity" in log).toBe(true);
  });

  it("三张命中面有值时原样透传", () => {
    const log = buildDispatchDecisionLogInput({
      taskName: "t",
      executionId: "e",
      poolSize: 1,
      afterFilters: 1,
      scoredCount: 1,
      selected: {
        address: "10.0.0.1",
        runningTaskCount: 0,
        maxConcurrentTasks: 10,
      },
      scoredSnapshot: [
        {
          address: "10.0.0.1",
          score: 0.3,
          runningTaskCount: 0,
          maxConcurrentTasks: 10,
        },
      ],
      deploymentAffinity: {
        preferred: 1,
        matchedByExecutorId: 1,
        matchedByAddressOnly: 0,
        runningDeployments: 1,
      },
      deploymentConstraint: {
        mode: "strict",
        source: "global",
        setSize: 3,
        onlineInSet: 1,
      },
      interpreterCacheAffinity: { preferred: 2, unreported: 1 },
    });
    expect(log.deploymentAffinity?.preferred).toBe(1);
    expect(log.deploymentConstraint?.mode).toBe("strict");
    expect(log.interpreterCacheAffinity?.unreported).toBe(1);
  });
});
