import type { Logger } from "@nestjs/common";
import type { Executor } from "./entities/executor.entity";
import type { AppDeployment } from "../application/entities/app-deployment.entity";
import type { Task } from "../task/entities/task.entity";
import { computeExecutorLoadScore } from "./executor-score.util";
import type { EstimatedDurationsIndex } from "./executor-scoring.util";
import { partitionByDeploymentAffinity } from "./executor-deployment-affinity.util";
import {
  hasRequestedVersion,
  partitionByInterpreterCache,
} from "./interpreter-match.util";

/**
 * T1-B3e：`dispatch` 的**候选排序与偏好分区**协作者。
 *
 * ## 边界：把**已抽好的纯函数串起来**，不新增逻辑
 *
 * 本类只做「调用顺序 + 快照截取 + 日志」：
 *   · 加权评分（`computeExecutorLoadScore`，CORE-05 共享公式）；
 *   · `scoredSnapshot`（**占坑前**截取，E-2 决策日志回溯用）；
 *   · 部署归属软偏好分区（`partitionByDeploymentAffinity`）；
 *   · 解释器真缓存优先分区（`partitionByInterpreterCache`）。
 *
 * ## ⚠️ 唯一 IO 留在 Facade
 *
 * `estimatedDurationsByExecutor(candidates)` 是本段**唯一**的 DB 读，**留在 Facade**
 * 调用、把结果传入（`estimatedDurations`）。这样「IO 与纯计算」的边界是干净的：
 * 本类**零 repo、零事务、零锁、零事件**。
 *
 * ## ⚠️ 零 QB 不变量（**改这个文件前必读**）
 *
 * dispatch 路径上有两处**索引型断言**：
 *   · `executor.service.security.spec.ts:287` —— `createQueryBuilder.mock.results[1]`
 *     必须是回滚 QB，且 `toHaveBeenCalledTimes(2)`（占坑 qb#0 + 回滚 qb#1）；
 *   · `executor.service.spec.ts:8928` —— `results[0]` 必须是 fleet 查询 QB。
 * ⇒ **本类绝不允许调用 `createQueryBuilder`**（否则 QB 序号漂移，那两条断言会
 * 「改前改后都绿但绿的含义变了」——六种耦合形式里最会静默假过的一种）。
 *
 * ## 排序位置纪律（勿调换顺序）
 *
 * 三个阶段的偏序是语义的一部分：
 *   评分排序 → 部署偏好分区 → 解释器缓存分区，
 * 且都必须在**占坑循环之前**（分区只调整组间顺序、组内仍是评分最优优先，
 * 占坑按此序逐个尝试，满了/离线自动降级到下一台）。
 */

/** 部署约束上下文（Facade 的 `resolveDeploymentConstraintContext` 返回值）。 */
export interface DispatchDeploymentContext {
  mode: "prefer" | "strict";
  source: "task" | "global";
  rows: AppDeployment[];
}

/** 决策日志的评分快照项（E-2）。 */
export interface ScoredSnapshotEntry {
  address: string;
  score: number;
  runningTaskCount: number;
  maxConcurrentTasks: number | null;
}

/** 协作者依赖。 */
export interface ExecutorDispatchRankingDeps {
  /** 日志（**必须是 Facade 的实例**——既有 spec spy 的是它）。 */
  logger: Logger;
}

export class ExecutorDispatchRanking {
  private readonly logger: Logger;

  constructor(deps: ExecutorDispatchRankingDeps) {
    this.logger = deps.logger;
  }

  /**
   * 评分 → 部署偏好分区 → 解释器缓存分区。
   *
   * 返回 `orderedCandidates`（占坑循环的实际顺序）与四个决策日志面。
   * `scoredSnapshot` 必须在**占坑前**截取（占坑会原地改 runningTaskCount/version）。
   */
  rankCandidates(args: {
    candidates: Executor[];
    /** Facade 侧 `estimatedDurationsByExecutor` 的结果（唯一 IO 在 Facade）。 */
    estimatedDurations: EstimatedDurationsIndex;
    deploymentCtx: DispatchDeploymentContext | null;
    dispatchPoolSize: number;
    task: Task;
  }): {
    orderedCandidates: Executor[];
    scoredSnapshot: ScoredSnapshotEntry[];
    deploymentAffinity: {
      preferred: number;
      matchedByExecutorId: number;
      matchedByAddressOnly: number;
      runningDeployments: number;
    } | null;
    deploymentConstraint: {
      mode: "strict";
      source: "task" | "global";
      setSize: number;
      onlineInSet: number;
    } | null;
    interpreterCacheAffinity: {
      preferred: number;
      unreported: number;
    } | null;
  } {
    const {
      candidates,
      estimatedDurations,
      deploymentCtx,
      dispatchPoolSize,
      task,
    } = args;
    // 3. Weighted scoring via the shared CORE-05 formula (load 50% + CPU 25% +
    // mem 25% + long-task penalty 10%, see executor-score.util.ts), try
    // optimistic lock in order.
    const withScores = candidates.map((c) => ({
      executor: c,
      score: computeExecutorLoadScore(c, {
        estimatedDurations: estimatedDurations.forExecutor(c),
      }),
    }));
    // E-2（中台↔执行器深度审查）：占坑前的**评分快照**（occupation 会原地
    // 改 runningTaskCount/version，必须在 mutate 之前截取，供决策日志回溯）。
    const scoredSnapshot = withScores
      .slice()
      .sort((a, b) => a.score - b.score)
      .slice(0, 3)
      .map((s) => ({
        address: s.executor.address,
        score: Number(s.score.toFixed(3)),
        runningTaskCount: s.executor.runningTaskCount,
        maxConcurrentTasks: s.executor.maxConcurrentTasks,
      }));
    const sorted = withScores
      .sort((a, b) => a.score - b.score)
      .map((s) => s.executor);

    // 3b. ARCH-35 P1（生产事故 2026-09-23）：**部署归属偏好**。
    //
    // 位置刻意选在「评分排序之后、原子占坑之前」：
    //   - 必须在排序**之后**：分区只调整分组、组内保序，故组内首选仍是评分
    //     最优者。若在排序前分区，紧接着的全量 sort 会把分组彻底打散（本文件
    //     上方 `withScores.sort` 是稳定排序但键是 score，分组信息不参与比较）。
    //   - 必须在占坑**之前**：占坑循环按 `sorted` 顺序逐个尝试，前置的部署
    //     执行器因此被优先占用；它满了/离线了，循环继续往下走 → **自动降级
    //     回全机队**，零新增失败面（`ordered` 与入参同元素集）。
    //
    // 语义是「偏好」而非「过滤」：执行器侧的任务执行**不依赖**本地是否部署过
    // 该应用（部署产物树 `<workDir>/apps/<appId>/` 与执行树
    // `<workDir>/<executionId>/` 互不相交；executor-python 甚至没有 deploy
    // 路由）。硬过滤会把全部未部署任务与 python 执行器踢出候选集 → 派发失败。
    // 完整论证见 executor-deployment-affinity.util.ts 头注。
    //
    // `scoredSnapshot`（上方）保持为**纯评分**前三名不变——决策日志里的 score
    // 必须始终是真实负载分，否则「为什么选这台」无法回溯。偏好命中面另记
    // `deploymentAffinity` 字段。
    // 3b-ARCH-35 P1：部署归属**软偏好**（deploymentPolicy=prefer，现状不变）
    // ——上下文已在候选池查询前解析（deploymentCtx），此处不再二次查库。
    // 3b-FEAT-22：strict 模式**跳过**分区——候选集已经是部署集合本身（约束
    // 收窄发生在池查询之前），分区只会把全部候选前置（无信息量），决策日志
    // 改记 deploymentConstraint。
    const preferRows =
      deploymentCtx && deploymentCtx.mode === "prefer"
        ? deploymentCtx.rows
        : null;
    let deploymentAffinity: {
      preferred: number;
      matchedByExecutorId: number;
      matchedByAddressOnly: number;
      runningDeployments: number;
    } | null = null;
    // FEAT-22：strict 约束的决策日志面（null=非 strict，与 deploymentAffinity
    // 同款「显式 null 而非缺字段」纪律）。onlineInSet 取自 dispatchPoolSize
    // （= 集合 ∩ ONLINE 直查行数，过滤前）；过滤后剩余即下方 afterFilters。
    // v2：source = 模式来源（task=任务级覆盖 / global=全局配置）。
    let deploymentConstraint: {
      mode: "strict";
      source: "task" | "global";
      setSize: number;
      onlineInSet: number;
    } | null = null;
    if (deploymentCtx?.mode === "strict") {
      deploymentConstraint = {
        mode: "strict",
        source: deploymentCtx.source,
        setSize: deploymentCtx.rows.length,
        onlineInSet: dispatchPoolSize,
      };
    }
    let orderedCandidates = sorted;
    if (preferRows) {
      const affinity = partitionByDeploymentAffinity(sorted, preferRows);
      orderedCandidates = affinity.ordered;
      deploymentAffinity = {
        preferred: affinity.preferredCount,
        matchedByExecutorId: affinity.matchedByExecutorId,
        matchedByAddressOnly: affinity.matchedByAddressOnly,
        runningDeployments: affinity.runningDeployments,
      };
      if (affinity.preferredCount > 0) {
        this.logger.log(
          `ARCH-35: 任务 "${task.name}" 关联应用 ${task.applicationId} 的部署归属命中 ` +
            `${affinity.preferredCount} 台候选执行器（id 命中 ${affinity.matchedByExecutorId} / ` +
            `address 兜底 ${affinity.matchedByAddressOnly}），已前置优先占坑`,
        );
      }
    }
    // 2026-10-31：解释器**真缓存优先**（与上方 ARCH-35 部署偏好同构的稳定
    // 分区）。位置同一条纪律：评分排序**之后**（分区只在组间调整，组内仍是
    // 最优负载优先）、原子占坑**之前**（占坑循环按此序逐个尝试，前置那台满了/
    // 离线了自动落到下一台 → 零新增失败面）。
    //
    // 收益面很小但真实（完整论证见 interpreter-match.util.ts 尾部注释）：
    // applyInterpreterFilter 是**硬过滤**——有满足者就收窄到那几台，只有全员
    // 都不满足才放行。所以本分区唯一能区分的情形是**「真缓存」vs「legacy
    // 兜底假设」**：`interpreters === null` 的旧执行器被 interpreterSatisfies
    // 按 ["3.12"] 兜底放行，但那只是**假设**；把真缓存的机器前置，可避免任务
    // 落在"可能根本没装"的机器上赌一把（赌输＝现场下 250MB 或
    // interpreter_unavailable）。
    //
    // 仅声明了 runtimeVersion 的任务参与；无声明 → 快速路径原序返回。
    let interpreterCacheAffinity: {
      preferred: number;
      unreported: number;
    } | null = null;
    if (hasRequestedVersion(task.runtimeVersion)) {
      const cacheAffinity = partitionByInterpreterCache(
        orderedCandidates,
        task.runtimeVersion,
      );
      orderedCandidates = cacheAffinity.ordered;
      interpreterCacheAffinity = {
        preferred: cacheAffinity.preferredCount,
        unreported: cacheAffinity.unreportedCount,
      };
      if (cacheAffinity.preferredCount > 0) {
        this.logger.log(
          `INTERP-CACHE: 任务 "${task.name}" 声明 Python ${String(task.runtimeVersion)}，` +
            `候选中有 ${cacheAffinity.preferredCount} 台已缓存该版本` +
            `（${cacheAffinity.unreportedCount} 台未上报解释器清单），已前置优先占坑`,
        );
      }
    }
    if (deploymentConstraint) {
      this.logger.log(
        `FEAT-22: 任务 "${task.name}" 关联应用 ${task.applicationId} 启用部署约束` +
          `（strict）：候选集收窄为已部署设备（集合 ${deploymentConstraint.setSize} 台，` +
          `在线 ${deploymentConstraint.onlineInSet} 台），集合全部不可派发时排队等待、不换机`,
      );
    }
    return {
      orderedCandidates,
      scoredSnapshot,
      deploymentAffinity,
      deploymentConstraint,
      interpreterCacheAffinity,
    };
  }
}
