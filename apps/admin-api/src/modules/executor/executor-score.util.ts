/**
 * CORE-05: 执行器负载评分纯函数（selectLeastLoaded / dispatch 共享）。
 *
 * ── 公式与量纲（实现前定稿，测试按此断言）───────────────────────────
 * score = 0.5 × loadRatio + 0.25 × cpuRatio + 0.25 × memRatio + 0.1 × longTaskPenalty
 *
 *   loadRatio      无量纲，[0,1)：runningTaskCount / maxConcurrentTasks
 *                  （max 缺省按 10 计，与既有实现一致；容量判定另用 Infinity 兜底）
 *   cpuRatio       无量纲，[0,1]：cpuUsage / 100
 *   memRatio       无量纲，[0,1]：memUsage / 100
 *   longTaskPenalty 无量纲，[0,1]：执行器当前运行中任务的「预期占用」项——
 *                  avg(estimatedDurationSec)（未知=600s 缺省）÷ 3600s 参考窗，
 *                  由 refWindowSec 归一化。含义：该执行器接下新任务后，本任务
 *                  要与"预估更长的存量任务"共处更久；预估长者对评分惩罚更高，
 *                  长短混布时长任务倾向被派给更空闲的执行器。
 *
 * 权重 0.5/0.25/0.25 与既有实现逐字节一致（零回归前提）；新增项权重 0.1
 * 刻意取小——它是打破平局的次级信号（长任务是否被导向空闲执行器），不是
 * 主导项；未知时长（estimatedDurationSec 全缺省）时该退化为常数
 * 0.1 × DEFAULT/refWindow，所有执行器同值 → 排序与旧公式完全同序（零破坏）。
 */

/** 未声明 estimatedDurationSec 时的缺省预估时长（秒）= 10 分钟 */
export const ESTIMATED_DURATION_DEFAULT_SEC = 600;
/** 预估时长归一化参考窗（秒）= 1 小时：≥1h 的任务给满惩罚 */
export const ESTIMATED_DURATION_REF_WINDOW_SEC = 3600;

export interface LoadScoreExecutorInput {
  runningTaskCount: number;
  maxConcurrentTasks?: number | null;
  cpuUsage?: number | null;
  memUsage?: number | null;
}

/** 运行中任务的预估时长集合（秒；null/undefined 项按缺省计） */
export type EstimatedDurations = (number | null | undefined)[];

export interface LoadScoreWeights {
  load: number;
  cpu: number;
  mem: number;
  estimated: number;
}

export const LOAD_SCORE_WEIGHTS: LoadScoreWeights = {
  load: 0.5,
  cpu: 0.25,
  mem: 0.25,
  estimated: 0.1,
};

/**
 * longTaskPenalty：运行中任务平均预估时长 ÷ 参考窗，[0,1] 钳制。
 * 无运行任务（估时数组为空）→ 0；逐项 null → 逐项缺省。
 */
export function longTaskPenalty(
  estimatedDurations: EstimatedDurations,
  refWindowSec = ESTIMATED_DURATION_REF_WINDOW_SEC,
  defaultSec = ESTIMATED_DURATION_DEFAULT_SEC,
): number {
  if (estimatedDurations.length === 0) return 0;
  const total = estimatedDurations.reduce<number>(
    (sum, d) => sum + (typeof d === "number" && d > 0 ? d : defaultSec),
    0,
  );
  const avg = total / estimatedDurations.length;
  return Math.min(Math.max(avg / refWindowSec, 0), 1);
}

/** 单执行器综合负载评分（值越小越空闲，调用方升序取首） */
export function computeExecutorLoadScore(
  executor: LoadScoreExecutorInput,
  options?: {
    /** 该执行器运行中任务的预估时长（秒）集合 */
    estimatedDurations?: EstimatedDurations;
    weights?: LoadScoreWeights;
  },
): number {
  const w = options?.weights ?? LOAD_SCORE_WEIGHTS;
  const max = executor.maxConcurrentTasks ?? 10;
  const loadRatio = executor.runningTaskCount / max;
  const cpuRatio = (executor.cpuUsage ?? 0) / 100;
  const memRatio = (executor.memUsage ?? 0) / 100;
  const penalty = longTaskPenalty(options?.estimatedDurations ?? []);
  return (
    w.load * loadRatio + w.cpu * cpuRatio + w.mem * memRatio + w.estimated * penalty
  );
}
