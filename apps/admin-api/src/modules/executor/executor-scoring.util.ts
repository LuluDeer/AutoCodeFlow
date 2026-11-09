import type { Executor } from "./entities/executor.entity";
import {
  computeExecutorLoadScore,
  type EstimatedDurations,
} from "./executor-score.util";
import {
  buildDispatchDecisionLog,
  type DispatchDecisionLog,
} from "./dispatch-decision-log.schema";

/**
 * 执行器选优的**纯计算**部分（B0 拆分第 2 步）。
 *
 * ## 为什么是纯函数
 *
 * 「从候选里挑一台最空闲的」这件事的**决策逻辑**（容量闸 → 加权评分 → 升序
 * 排序）是纯计算：同样的候选集与同样的估时样本 ⇒ 同样的结果，不碰 DB、
 * 不读时钟、不发请求。把它从 `ExecutorService.selectLeastLoaded` 与
 * `ExecutorService.dispatch` 里剥出来，可以：
 *
 * - **表驱动穷举单测**：容量边界、评分并列、估时缺失各档都能单独钉住，
 *   而不必构造整个 service 与 9 个 Repository 替身。
 * - **两个调用点共用一份**：部署选机（`selectLeastLoaded`）与任务派发
 *   （`dispatch`）本来就共用 `computeExecutorLoadScore`（`executor-score.util.ts`
 *   的 CORE-05 公式），本文件把「谁用公式、怎么用」也统一到一处。
 *
 * ## 行为等价性（搬移时的硬约束）
 *
 * 本文件的每个函数都是**从原实现逐字搬出**的，参数化后语义不变：
 * - 容量闸用 `?? Infinity`（缺省容量视为无限），与既有实现一致；
 * - 评分升序用 `a.score - b.score`（**稳定排序**，分数相同则保持候选原序，
 *   与既有实现一致——`Array.prototype.sort` 在 ES2019+ 规范上是稳定的）；
 * - 估时缺失按 `null` 入池（不是 0），由 `computeExecutorLoadScore` 内部的
 *   `defaultSec` 缺省处理，与既有实现一致。
 */

/** 评分后的候选（执行器 + 其综合负载分；分越小越空闲）。 */
export interface ScoredExecutorCandidate {
  executor: Executor;
  score: number;
}

/**
 * 容量闸：滤掉已达容量上限的候选。
 *
 * `maxConcurrentTasks` 缺省按 `Infinity`（不限容量）——与既有实现逐字一致。
 * ⚠️ 注意 `maxConcurrentTasks` 为 **null**（显式 null = 未设置）与 undefined
 * 都走 `?? Infinity` 分支，二者同义。
 */
export function filterAvailableByCapacity(
  candidates: readonly Executor[],
): Executor[] {
  return candidates.filter((e) => {
    const max = e.maxConcurrentTasks ?? Infinity;
    return e.runningTaskCount < max;
  });
}

/**
 * 加权评分 + 升序排序（分小者在前）。
 *
 * `estimatedDurations` 是**取值器**（ADR-017 阶段 3）：调用方传
 * `EstimatedDurationsIndex.forExecutor` 的结果即可，本函数只负责对每个候选
 * 取一次样本并排序。
 *
 * @param candidates 已过容量闸的候选
 * @param estimatedDurationsFor 每台执行器的运行中任务估时样本（秒）取值器
 */
export function scoreAndSortCandidates(
  candidates: readonly Executor[],
  estimatedDurationsFor: (
    executor: Pick<Executor, "id" | "address">,
  ) => EstimatedDurations,
): ScoredExecutorCandidate[] {
  return candidates
    .map((executor) => ({
      executor,
      score: computeExecutorLoadScore(executor, {
        estimatedDurations: estimatedDurationsFor(executor),
      }),
    }))
    .sort((a, b) => a.score - b.score);
}

/** 估时样本池的取值器（ADR-017 阶段 3：行身份优先 + 地址兜底两支合并）。 */
export interface EstimatedDurationsIndex {
  forExecutor: (
    executor: Pick<Executor, "id" | "address">,
  ) => EstimatedDurations;
}

/** 空索引（无候选/查询失败降级）：恒返回空样本 → longTaskPenalty=0。 */
export const EMPTY_ESTIMATED_INDEX: EstimatedDurationsIndex = {
  forExecutor: () => [],
};

/**
 * 估时样本池的**分组**（纯计算部分；取数在 service 侧）。
 *
 * 输入两支：
 * - `running`：RUNNING 状态的执行行样本（行身份 + 任务 id）；
 * - `durationByTaskId`：任务 id → 预估时长（秒）的映射（查任务表得到）。
 *
 * 输出按**行身份优先 / 地址兜底**两支归组的取值器：
 * - 新派发执行行有 `executorId` → 归到**该行**（同址多行不互相污染）；
 * - 存量行（迁移 0055 刻意不回填 `executorId`）没有 → 只能归到地址，且
 *   同址并存时两台会共享这份池。这是**如实**的：那些历史执行在物理上无法
 *   归属到行。
 *
 * 取值器把两支合并返回，调用方无从只读其中一支（旧实现消费方只 `get(address)`，
 * 正是「改了归组键、忘了改取值键」的漏改形态）。
 */
export function buildEstimatedDurationsIndex(
  running: ReadonlyArray<{
    executorAddress: string;
    executorId: string | null;
    taskId: string;
  }>,
  durationByTaskId: ReadonlyMap<string, number | null>,
): EstimatedDurationsIndex {
  const byExecutorId = new Map<string, EstimatedDurations>();
  const byAddress = new Map<string, EstimatedDurations>();
  for (const row of running) {
    const [bucket, key] = row.executorId
      ? ([byExecutorId, row.executorId] as const)
      : ([byAddress, row.executorAddress] as const);
    const durations = bucket.get(key) ?? [];
    durations.push(durationByTaskId.get(row.taskId) ?? null);
    bucket.set(key, durations);
  }
  return {
    forExecutor: (executor) => [
      ...(byExecutorId.get(executor.id) ?? []),
      // 地址支只含**存量行**样本，故新派发执行器（有自己的 id 池）不会
      // 因同址并存而读到别人的数据；反之存量执行器能拿回自己的历史近似。
      ...(byAddress.get(executor.address) ?? []),
    ],
  };
}

/**
 * 调度决策日志的**载荷构造**（纯计算；输出动作留在 service）。
 *
 * ## 为什么抽出来
 *
 * 决策日志有两个出口（`dispatch` 与 `selectLeastLoaded`），它们的**字段集**
 * 已由 `dispatch-decision-log.schema.ts` 统一，但「怎么从评分结果拼出那份
 * 输入」仍是两处各写一份手写映射——`selected` 的取分方式尤其易漂移：
 *
 * - `selectLeastLoaded` 路径：直接用 `scored[0].score`；
 * - `dispatch` 路径：从 `scoredSnapshot` 里**按地址回查**选中者的分数
 *   （`find(...)?.score ?? null`）——因为占坑会**原地改** `runningTaskCount`，
 *   快照必须先截取，而选中者的分数要回查才拿得到。
 *
 * 两条路径的取分口径**本来就不该一样**（前者直接取、后者回查），但「拼载荷」
 * 这件事是同一类。把两份映射放到一处、让差异显式体现在参数上，可以避免
 * 第三次派发路径出现第三份手写映射。
 *
 * ## 行为等价性
 *
 * 两份载荷与原实现**逐字段一致**：`selected` 取分口径按参数
 * `selectedScoreSource` 显式区分（`"direct"` 直接给分 / `"lookup"` 按地址回查），
 * `topRunners` 恒取评分快照的前若干名。
 */
export interface DispatchDecisionCandidateLike {
  address: string;
  score: number;
  runningTaskCount: number;
  maxConcurrentTasks: number | null;
}

/**
 * `dispatch` 路径的「选中者」——**不含分数**。
 *
 * 分数不在这里给：占坑会**原地改** `runningTaskCount`/`version`，评分快照
 * 必须先截取；而选中者的分数是从**那份快照里按地址回查**得到的
 * （`scoredSnapshot.find(...)?.score ?? null`）——快照里找不到就是 null。
 * 因此「选中者」只需要身份与负载，分数由快照提供。
 */
export interface DispatchDecisionSelectedLike {
  address: string;
  runningTaskCount: number;
  maxConcurrentTasks: number | null;
}

/** `selectLeastLoaded` 路径的载荷输入（无任务上下文 ⇒ task/executionId 恒 null）。 */
export function buildSelectLeastLoadedDecisionLog(input: {
  poolSize: number;
  afterFilters: number;
  scored: ReadonlyArray<ScoredExecutorCandidate>;
}): DispatchDecisionLog {
  const selected = input.scored[0];
  return buildDispatchDecisionLog({
    event: "selectLeastLoaded.decision",
    task: null,
    executionId: null,
    poolSize: input.poolSize,
    afterFilters: input.afterFilters,
    scoredCount: input.scored.length,
    selected: {
      address: selected.executor.address,
      score: selected.score,
      runningTaskCount: selected.executor.runningTaskCount,
      maxConcurrentTasks: selected.executor.maxConcurrentTasks,
    },
    topRunners: input.scored.slice(1, 4).map((s) => ({
      address: s.executor.address,
      score: s.score,
      runningTaskCount: s.executor.runningTaskCount,
      maxConcurrentTasks: s.executor.maxConcurrentTasks,
    })),
  });
}

/** `dispatch` 路径的载荷输入（带任务上下文 + 三张可选命中面）。 */
export function buildDispatchDecisionLogInput(input: {
  taskName: string;
  executionId: string;
  poolSize: number;
  afterFilters: number;
  scoredCount: number;
  selected: DispatchDecisionSelectedLike;
  scoredSnapshot: DispatchDecisionCandidateLike[];
  deploymentAffinity?: {
    preferred: number;
    matchedByExecutorId: number;
    matchedByAddressOnly: number;
    runningDeployments: number;
  } | null;
  deploymentConstraint?: {
    mode: "strict";
    source: "task" | "global";
    setSize: number;
    onlineInSet: number;
  } | null;
  interpreterCacheAffinity?: { preferred: number; unreported: number } | null;
}): DispatchDecisionLog {
  // 占坑会原地改 runningTaskCount/version ⇒ 快照必须先截取；选中者的分数
  // 因此要**按地址回查**（快照里按地址找，找不到则 null）。
  const selectedScore =
    input.scoredSnapshot.find((s) => s.address === input.selected.address)
      ?.score ?? null;
  return buildDispatchDecisionLog({
    event: "dispatch.decision",
    task: input.taskName,
    executionId: input.executionId,
    poolSize: input.poolSize,
    afterFilters: input.afterFilters,
    scoredCount: input.scoredCount,
    selected: {
      address: input.selected.address,
      score: selectedScore,
      runningTaskCount: input.selected.runningTaskCount,
      maxConcurrentTasks: input.selected.maxConcurrentTasks,
    },
    topRunners: input.scoredSnapshot,
    // 部署归属偏好命中面（null 时显式输出 null 而非省略——「没这个字段」
    // 与「偏好未适用」必须可区分）。
    deploymentAffinity: input.deploymentAffinity ?? null,
    // strict 部署约束面（null=非 strict）。判读：setSize>0 且
    // onlineInSet=0 → 集合设备全离线；onlineInSet>0 且 afterFilters=0 →
    // 集合设备被 group/tags/解释器过滤挡光；两者皆 >0 仍失败 → 占坑全落
    // 空（满载/占坑竞态）。运维据此区分「约束把任务卡在哪一层」。
    deploymentConstraint: input.deploymentConstraint ?? null,
    // 解释器已缓存版本偏好命中面（null=未声明版本）。判读：
    // preferred>0 → 已把缓存好的那几台前置；preferred=0 且 unreported 少于
    // 候选数 → 全机队都没缓存该版本，本次必然有一次现场 uv python install
    // （预期行为，不是缺陷）；unreported=候选数 → 整队都是未上报解释器
    // 清单的旧执行器，偏好无从判定。
    interpreterCacheAffinity: input.interpreterCacheAffinity ?? null,
  });
}
