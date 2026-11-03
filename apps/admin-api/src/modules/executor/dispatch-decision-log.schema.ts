/**
 * 调度决策日志的 **schema**（单一事实源）。
 *
 * ## 为什么需要它
 *
 * 调度决策日志是「**为什么派到这台、为什么没派到那台**」的唯一留痕，运维与
 * 排障都靠它。本仓此前有**两个**出口，各自手写一份 JSON：
 *
 *   ① `dispatch()`            → `event: "dispatch.decision"`
 *   ② `selectLeastLoaded()`   → `event: "selectLeastLoaded.decision"`
 *
 * 两份的**字段集不同**：② 缺 `task` / `executionId`（选机路径确实没有任务
 * 上下文，但它有自己的字段需要补），且**顶层结构**也不同（② 把
 * `poolSize` 等平铺在顶层，① 也有——但 ① 的 `selected`/`topRunners` 子结构
 * 与 ② 的写法有细微差别：`score` 的取整方式不同：① 用 `selectedScore`
 * （从快照里找，可能为 `null`），② 用 `Number(score.toFixed(3))`）。
 *
 * 后果：
 *   · 日志消费方（grep / 日志系统索引 / 未来的看板）必须写**两套**解析；
 *   · 字段增删没有守卫——加字段时容易只加一处，两边就不齐了；
 *   · `score` 的两种取整方式 ⇒ 同一语义字段的值格式不一致。
 *
 * 本模块把两份 JSON 收敛到**一份 schema**：字段集固定、缺失显式 `null`、
 * 取整方式唯一。
 *
 * ## 为什么用「运行时校验」而不是纯 TypeScript 类型
 *
 * 纯类型只能约束**编译期**的调用方，而日志是**运行时**产物——一旦某个调用
 * 点漏传字段，类型系统拦不住（可选字段的 `undefined` 在 `JSON.stringify`
 * 里会被**整个省略**，于是「这个字段没值」与「这个字段不存在」在日志里
 * 不可区分——而这正是本模块要消除的歧义）。
 *
 * 故：schema 里每个字段都是**必填**（缺失即抛），「无值」用显式 `null`
 * 表达。校验失败**抛错而非静默输出畸形 JSON**——畸形 JSON 进日志系统后
 * 会污染面板，而抛错会被立刻发现。
 */

/** 决策日志的顶层事件名。 */
export type DispatchDecisionEvent =
  | "dispatch.decision"
  | "selectLeastLoaded.decision";

/** 候选执行器的评分快照条目（「为什么没派到某台」的证据）。 */
export interface DispatchDecisionCandidate {
  /** 执行器地址。 */
  address: string;
  /** 负载评分（保留 3 位小数）。 */
  score: number;
  /** 当前在跑任务数。 */
  runningTaskCount: number;
  /** 最大并发（`null` = 无上限）。 */
  maxConcurrentTasks: number | null;
}

/** 决策日志的完整形状（**所有字段必填**，无值用 `null`）。 */
export interface DispatchDecisionLog {
  /** 事件名（区分派发/选机两条路径）。 */
  event: DispatchDecisionEvent;
  /** 任务名（选机路径**无任务上下文** ⇒ `null`）。 */
  task: string | null;
  /** 执行 ID（选机路径 ⇒ `null`）。 */
  executionId: string | null;
  /** SQL Top-K 后的候选池基数。 */
  poolSize: number;
  /** 过滤后的剩余候选数。 */
  afterFilters: number;
  /** 参与计分的候选数。 */
  scoredCount: number;
  /** 选中执行器（地址 + 评分 + 负载）。 */
  selected: DispatchDecisionCandidate;
  /** 落选者（评分前三）。 */
  topRunners: DispatchDecisionCandidate[];
  /** 部署归属偏好命中面（`null` = 偏好未适用）。 */
  deploymentAffinity: {
    preferred: number;
    matchedByExecutorId: number;
    matchedByAddressOnly: number;
    runningDeployments: number;
  } | null;
  /** strict 部署约束面（`null` = 非 strict）。 */
  deploymentConstraint: {
    mode: "strict";
    source: "task" | "global";
    setSize: number;
    onlineInSet: number;
  } | null;
  /** 解释器缓存版本偏好命中面（`null` = 未声明版本）。 */
  interpreterCacheAffinity: {
    preferred: number;
    unreported: number;
  } | null;
}

/**
 * 评分取整（**唯一**口径）。
 *
 * 此前两个出口各用一种：`dispatch` 从快照里取（可能为 `null`——选中的机器
 * 若不在快照里），`selectLeastLoaded` 用 `toFixed(3)`。本函数把两者统一：
 * **一律 3 位小数**，缺失时 `null`。
 */
export function roundScore(score: number | null | undefined): number | null {
  if (score === null || score === undefined) return null;
  if (!Number.isFinite(score)) return null;
  return Number(score.toFixed(3));
}

/**
 * 构造决策日志（**并做运行时校验**）。
 *
 * ## 校验失败为什么抛错
 *
 * 决策日志是**排障的唯一证据**。一份畸形/字段缺失的 JSON 进日志系统后，
 * 面板上的「为什么没派到那台」会**静默**少一个维度——而排障的人不会知道
 * 少的是哪个维度（他只会看到「没记录」）。抛错让问题在产生点暴露。
 *
 * 抛错**不会**影响派发主链：调用点在本模块之外自行捕获（见
 * `ExecutorService` 的用法）——决策日志是**可观测性**，不是业务逻辑，
 * 它坏了不该让派发失败。
 *
 * @param input 决策日志的原始输入
 * @returns 通过校验的决策日志（字段集完整，缺失显式 `null`）
 * @throws 输入缺必填字段或类型不符时抛 `TypeError`
 */
export function buildDispatchDecisionLog(
  input: Partial<DispatchDecisionLog> & {
    event: DispatchDecisionEvent;
    poolSize: number;
    afterFilters: number;
    scoredCount: number;
    selected: DispatchDecisionCandidate;
  },
): DispatchDecisionLog {
  const problems: string[] = [];

  const requireNumber = (name: string, value: unknown): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      problems.push(`${name} 必须是有限数字（收到 ${JSON.stringify(value)}）`);
      return 0;
    }
    return value;
  };

  const requireCandidate = (
    name: string,
    value: unknown,
  ): DispatchDecisionCandidate => {
    if (!value || typeof value !== "object") {
      problems.push(`${name} 必须是对象`);
      return {
        address: "",
        score: null as unknown as number,
        runningTaskCount: 0,
        maxConcurrentTasks: null,
      };
    }
    const c = value as Partial<DispatchDecisionCandidate>;
    if (typeof c.address !== "string") {
      problems.push(`${name}.address 必须是字符串`);
    }
    // D-8（R1 复核 2026-11-03）：`score` **不得静默兜底**。
    //
    // 原实现是 `roundScore(...) ?? 0` —— undefined / NaN / null 全被压成 `0`
    // 且**不记入 problems**。而本函数的契约是「缺必填字段即抛 TypeError」
    // （类型声明 `score: number` 也是必填），两头不靠。
    //
    // 为什么这条值得修（复核实测：`NO-THROW selected.score=undefined -> score:0`）：
    // `score=0` 在这份日志里的语义是「负载评分最低 = 最空闲 = 最优」——
    // **恰恰是最有误导性的值**。排障者会得出「这台完全空闲却被别的因素淘汰」
    // 的错误结论，而日志里**没有任何缺字段痕迹**。这正是本 schema 想消灭的那类歧义。
    //
    // 可达性（如实）：`computeExecutorLoadScore`（executor-score.util.ts）恒返回 number
    // （`cpuUsage ?? 0` 等全兜底）⇒ 当前**生产不可达**，属**契约一致性收口**，
    // 不是线上缺陷。保留 `?? 0` 仅为维持下游字段形状（number），但**必须记录 problem**。
    const roundedScore = roundScore(c.score as number | null | undefined);
    if (roundedScore === null) {
      problems.push(
        `${name}.score 必须是有限数字（收到 ${JSON.stringify(c.score)}）`,
      );
    }
    return {
      address: typeof c.address === "string" ? c.address : "",
      score: roundedScore ?? 0,
      runningTaskCount: requireNumber(
        `${name}.runningTaskCount`,
        c.runningTaskCount,
      ),
      maxConcurrentTasks:
        c.maxConcurrentTasks === null || c.maxConcurrentTasks === undefined
          ? null
          : requireNumber(`${name}.maxConcurrentTasks`, c.maxConcurrentTasks),
    };
  };

  const log: DispatchDecisionLog = {
    event: input.event,
    task: typeof input.task === "string" ? input.task : null,
    executionId:
      typeof input.executionId === "string" ? input.executionId : null,
    poolSize: requireNumber("poolSize", input.poolSize),
    afterFilters: requireNumber("afterFilters", input.afterFilters),
    scoredCount: requireNumber("scoredCount", input.scoredCount),
    selected: requireCandidate("selected", input.selected),
    topRunners: Array.isArray(input.topRunners)
      ? input.topRunners.map((c, i) => requireCandidate(`topRunners[${i}]`, c))
      : [],
    deploymentAffinity: input.deploymentAffinity ?? null,
    deploymentConstraint: input.deploymentConstraint ?? null,
    interpreterCacheAffinity: input.interpreterCacheAffinity ?? null,
  };

  if (problems.length > 0) {
    throw new TypeError(
      `调度决策日志字段校验失败：${problems.join("；")}`,
    );
  }

  return log;
}
