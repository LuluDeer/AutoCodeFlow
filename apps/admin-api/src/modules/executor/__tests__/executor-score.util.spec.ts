/**
 * CORE-05: 执行器负载评分纯函数矩阵——公式（0.5 load + 0.25 cpu + 0.25 mem
 * + 0.1 longTaskPenalty）、缺省时长、归一化参考窗、未知时长退化等序。
 */
import {
  computeExecutorLoadScore,
  longTaskPenalty,
  LOAD_SCORE_WEIGHTS,
  ESTIMATED_DURATION_DEFAULT_SEC,
  ESTIMATED_DURATION_REF_WINDOW_SEC,
} from "../executor-score.util";

describe("executor-score.util（CORE-05 loadScore 公式）", () => {
  it("权重常量与既有实现逐字对齐（0.5/0.25/0.25）且新增项 0.1", () => {
    expect(LOAD_SCORE_WEIGHTS).toEqual({
      load: 0.5,
      cpu: 0.25,
      mem: 0.25,
      estimated: 0.1,
    });
  });

  it("未知时长（无数组）时退化为旧公式：0.5 load + 0.25 cpu + 0.25 mem", () => {
    const score = computeExecutorLoadScore({
      runningTaskCount: 4,
      maxConcurrentTasks: 10,
      cpuUsage: 40,
      memUsage: 80,
    });
    // 旧公式逐字重算：0.4*0.5 + 0.4*0.25 + 0.8*0.25 = 0.5
    expect(score).toBeCloseTo(0.4 * 0.5 + 0.4 * 0.25 + 0.8 * 0.25, 12);
  });

  it("maxConcurrentTasks 缺省按 10 计（与既有实现一致）", () => {
    const score = computeExecutorLoadScore({ runningTaskCount: 5 });
    expect(score).toBeCloseTo(0.5 * (5 / 10), 12);
  });

  it("longTaskPenalty：短任务（300s）→ 300/3600 ≈ 0.083", () => {
    expect(longTaskPenalty([300])).toBeCloseTo(300 / 3600, 12);
  });

  it("longTaskPenalty：长任务（≥3600s）钳制到 1", () => {
    expect(longTaskPenalty([7200])).toBe(1);
    expect(longTaskPenalty([3600])).toBe(1);
  });

  it("longTaskPenalty：null/0/undefined 项按缺省 600s 计（未知=已知缺省）", () => {
    expect(longTaskPenalty([null, 0, undefined])).toBeCloseTo(
      ESTIMATED_DURATION_DEFAULT_SEC / ESTIMATED_DURATION_REF_WINDOW_SEC,
      12,
    );
  });

  it("longTaskPenalty：空数组（无运行任务）→ 0", () => {
    expect(longTaskPenalty([])).toBe(0);
  });

  it("混合集合取平均：[1800, null] → (1800+600)/2/3600", () => {
    expect(longTaskPenalty([1800, null])).toBeCloseTo(1200 / 3600, 12);
  });

  it("CORE-05 核心行为：同 load/cpu/mem 下，跑长任务的执行器评分更高（惩罚更大）", () => {
    const base = {
      runningTaskCount: 2,
      maxConcurrentTasks: 10,
      cpuUsage: 0,
      memUsage: 0,
    };
    const shortTaskExecutor = computeExecutorLoadScore(base, {
      estimatedDurations: [60],
    });
    const longTaskExecutor = computeExecutorLoadScore(base, {
      estimatedDurations: [3600],
    });
    expect(longTaskExecutor).toBeGreaterThan(shortTaskExecutor);
    expect(longTaskExecutor - shortTaskExecutor).toBeCloseTo(
      0.1 * (1 - 60 / 3600),
      6,
    );
  });

  it("长短混布分布语义：2 号执行器数值更满但只跑短任务时，1 号（跑长任务）反超", () => {
    // e1: load 0.3 + 长任务惩罚 1 → 0.15+0.1=0.25
    const e1 = computeExecutorLoadScore(
      { runningTaskCount: 3, maxConcurrentTasks: 10, cpuUsage: 0, memUsage: 0 },
      { estimatedDurations: [3600, 3600] },
    );
    // e2: load 0.4 + 短任务 → 0.2+0.1*(60/3600)≈0.2017
    const e2 = computeExecutorLoadScore(
      { runningTaskCount: 4, maxConcurrentTasks: 10, cpuUsage: 0, memUsage: 0 },
      { estimatedDurations: [60, 60] },
    );
    expect(e2).toBeLessThan(e1); // e2 更空闲，新长任务应派 e2
  });

  it("未知时长任务混入时长已知任务：未知项不产生额外差异方向性（按缺省 600s 计）", () => {
    const withUnknown = computeExecutorLoadScore(
      { runningTaskCount: 1, maxConcurrentTasks: 10 },
      { estimatedDurations: [null] },
    );
    const withDefault = computeExecutorLoadScore(
      { runningTaskCount: 1, maxConcurrentTasks: 10 },
      { estimatedDurations: [ESTIMATED_DURATION_DEFAULT_SEC] },
    );
    expect(withUnknown).toBeCloseTo(withDefault, 12);
  });
});
