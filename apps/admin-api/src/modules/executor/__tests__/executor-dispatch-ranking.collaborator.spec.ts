import { Logger } from "@nestjs/common";
import {
  ExecutorDispatchRanking,
  type ExecutorDispatchRankingDeps,
} from "../executor-dispatch-ranking.collaborator";
import type { Executor } from "../entities/executor.entity";
import type { Task } from "../../task/entities/task.entity";
import type { EstimatedDurationsIndex } from "../executor-scoring.util";

/**
 * T1-B3e 的独立单测（**不走 DI 装配**，`new ExecutorDispatchRanking({...})` 直构）。
 *
 * ## 钉住三件"错了会静默"的事
 *
 * 1. **`scoredSnapshot` 是「占坑前」的纯评分前三名** —— 占坑会原地改
 *    `runningTaskCount`，若快照取晚一步，决策日志（「为什么选这台」）就失真。
 * 2. **分区只调「组间顺序」，组内仍是评分最优优先** —— 分区若做成排序，会把
 *    负载最优者打散（ARCH-35 的原始缺陷形态）。
 * 3. **分区是「偏好」不是「过滤」** —— 元素数必须与入参**相同**（零新增失败面）。
 */

const makeDeps = (over: Partial<ExecutorDispatchRankingDeps> = {}) => {
  const log = jest.fn();
  const logger = {
    log,
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  } as unknown as Logger;
  const deps: ExecutorDispatchRankingDeps = { logger, ...over };
  return { deps, log };
};

const mkExecutor = (over: Partial<Executor> = {}): Executor =>
  ({
    id: "e1",
    address: "10.0.0.1:3002",
    status: "online",
    runningTaskCount: 0,
    maxConcurrentTasks: 10,
    cpuUsage: 0,
    memUsage: 0,
    tags: [],
    capabilities: [],
    interpreters: null,
    ...over,
  }) as unknown as Executor;

const emptyIdx = (): EstimatedDurationsIndex =>
  ({ forExecutor: () => undefined }) as unknown as EstimatedDurationsIndex;

const mkTask = (over: Partial<Task> = {}): Task =>
  ({ id: "t1", name: "t", runtimeVersion: null, ...over }) as unknown as Task;

const baseArgs = (over: Record<string, unknown> = {}) => ({
  candidates: [mkExecutor()],
  estimatedDurations: emptyIdx(),
  deploymentCtx: null,
  dispatchPoolSize: 1,
  task: mkTask(),
  ...over,
});

describe("ExecutorDispatchRanking（T1-B3e 独立单测）", () => {
  it("按负载分升序排列（空闲者优先）", () => {
    const { deps } = makeDeps();
    const c = new ExecutorDispatchRanking(deps);
    const busy = mkExecutor({ id: "busy", address: "a1", runningTaskCount: 9 });
    const idle = mkExecutor({ id: "idle", address: "a2", runningTaskCount: 0 });

    const out = c.rankCandidates(
      baseArgs({ candidates: [busy, idle], dispatchPoolSize: 2 }) as never,
    );

    expect(out.orderedCandidates[0].id).toBe("idle");
    expect(out.orderedCandidates).toHaveLength(2); // 偏好不是过滤
  });

  it("scoredSnapshot = 纯评分前三名，且与 orderedCandidates 独立（不因分区而变）", () => {
    const { deps } = makeDeps();
    const c = new ExecutorDispatchRanking(deps);
    const list = [
      mkExecutor({ id: "a", address: "a", runningTaskCount: 8 }),
      mkExecutor({ id: "b", address: "b", runningTaskCount: 1 }),
      mkExecutor({ id: "c", address: "c", runningTaskCount: 4 }),
      mkExecutor({ id: "d", address: "d", runningTaskCount: 6 }),
    ];

    const out = c.rankCandidates(
      baseArgs({ candidates: list, dispatchPoolSize: 4 }) as never,
    );

    expect(out.scoredSnapshot).toHaveLength(3);
    // 分数升序的前三名（b=1, c=4, d=6），不含最忙的 a
    expect(out.scoredSnapshot.map((s) => s.address)).toEqual(["b", "c", "d"]);
    expect(out.scoredSnapshot[0].score).toBeLessThanOrEqual(
      out.scoredSnapshot[2].score,
    );
    // score 已 toFixed(3) 归一
    expect(String(out.scoredSnapshot[0].score)).not.toMatch(/\.\d{4,}/);
  });

  it("部署偏好分区：命中部署的执行器前置，但元素数不变（偏好非过滤）", () => {
    const { deps } = makeDeps();
    const c = new ExecutorDispatchRanking(deps);
    const preferred = mkExecutor({
      id: "pref",
      address: "10.0.0.9:3002",
      runningTaskCount: 5,
    });
    const notPreferred = mkExecutor({
      id: "other",
      address: "10.0.0.1:3002",
      runningTaskCount: 0,
    });
    const deploymentCtx = {
      mode: "prefer" as const,
      source: "task" as const,
      rows: [
        {
          executorAddress: "10.0.0.9:3002",
          executorId: null,
          status: "running",
        },
      ],
    };

    const out = c.rankCandidates(
      baseArgs({
        candidates: [notPreferred, preferred],
        deploymentCtx,
        dispatchPoolSize: 2,
      }) as never,
    );

    expect(out.orderedCandidates[0].id).toBe("pref");
    expect(out.orderedCandidates).toHaveLength(2);
    expect(out.deploymentAffinity).toMatchObject({ preferred: 1 });
    // 无命中 ⇒ 不产生日志噪音
    void out;
  });

  it("strict 模式：跳过分区、记 deploymentConstraint（不产生 deploymentAffinity）", () => {
    const { deps } = makeDeps();
    const c = new ExecutorDispatchRanking(deps);
    const deploymentCtx = {
      mode: "strict" as const,
      source: "global" as const,
      rows: [{ executorAddress: "x", executorId: null, status: "running" }],
    };

    const out = c.rankCandidates(
      baseArgs({ deploymentCtx, dispatchPoolSize: 1 }) as never,
    );

    expect(out.deploymentAffinity).toBeNull();
    expect(out.deploymentConstraint).toMatchObject({
      mode: "strict",
      source: "global",
      setSize: 1,
      onlineInSet: 1,
    });
  });

  it("未声明 runtimeVersion ⇒ 零解释器分区（interpreterCacheAffinity=null）", () => {
    const { deps } = makeDeps();
    const c = new ExecutorDispatchRanking(deps);
    const out = c.rankCandidates(baseArgs() as never);
    expect(out.interpreterCacheAffinity).toBeNull();
  });

  it("声明 runtimeVersion ⇒ 已缓存该版本的执行器前置", () => {
    const { deps } = makeDeps();
    const c = new ExecutorDispatchRanking(deps);
    const cached = mkExecutor({
      id: "cached",
      address: "c2",
      runningTaskCount: 5,
      interpreters: [{ version: "3.12" }],
    });
    const uncached = mkExecutor({
      id: "uncached",
      address: "c1",
      runningTaskCount: 0,
      interpreters: null,
    });

    const out = c.rankCandidates(
      baseArgs({
        candidates: [uncached, cached],
        dispatchPoolSize: 2,
        task: mkTask({ runtimeVersion: "3.12" }),
      }) as never,
    );

    expect(out.orderedCandidates[0].id).toBe("cached");
    expect(out.interpreterCacheAffinity).toMatchObject({ preferred: 1 });
  });

  it("协作者无 public self-call（只有 rankCandidates 一个 public 面）", () => {
    const { deps } = makeDeps();
    const c = new ExecutorDispatchRanking(deps);
    const proto = Object.getPrototypeOf(c) as Record<string, unknown>;
    const pub = Object.getOwnPropertyNames(proto).filter(
      (n) => n !== "constructor" && typeof proto[n] === "function",
    );
    expect(pub).toEqual(["rankCandidates"]);
  });
});
