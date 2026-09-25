/**
 * P7a（agent-and-deployment）：执行器 Agent 的硬闸门（07 §7.1 / ADR-022 决策 7）。
 *
 * ## 为什么闸门独立成纯函数模块
 * 与 path-domain.ts / config-sanitize.ts / permission-profile.ts 同款理由：
 * 运行时循环会依赖 Electron 与网络，裸 node 加载即崩；而**闸门恰恰是最需要
 * 回归闸的部分**——它是 ADR-022「受控的任意代码执行」里那个「受控」的全部
 * 内容。闸门错了，其余设计都不作数。
 *
 * ## 两条纪律（从中台 Agent 的 P2 实现里继承，不重新论证）
 * 1. **闸门在循环开头判，不在末尾判**：末尾判会让最后一轮的副作用
 *    （可能已经写了文件、跑了代码）先发生再被拦，闸门形同虚设。
 *    测试专门钉住「恰好跑到上限就停，不多跑一轮」。
 * 2. **墙钟自首次迭代起算，resume 不重置**：否则「2 小时上限」可以被
 *    反复续命——挂起/恢复是常态（等澄清回复、等审批），重置等于没有上限。
 *
 * ## 「终止」不是失败
 * 触顶终止是一个**合法的终态**，必须带 reason 如实上报中台（07 §7.1：
 * 「终止 + 上报『无法在合理轮次内完成』」）。把它当异常抛出去会让中台
 * 看到的是一个崩溃而不是一个结论——中台因此无法区分「机器做不了」与
 * 「程序坏了」，也就无法决定换机器还是转人工。
 */

/** 硬闸门上限（07 §7.1 默认值）。 */
export interface GateLimits {
  /** 单次迭代最大轮数（观察→规划→试跑→诊断 记一轮）。 */
  maxIterations: number;
  /** 单会话墙钟上限（毫秒）。 */
  maxWallClockMs: number;
  /** 澄清轮次（与中台 maxRounds 协商，04 §clarification）。 */
  maxClarificationRounds: number;
  /** 试跑次数（这是"执行生成的代码"的次数，最敏感的一个）。 */
  maxTrialRuns: number;
  /** 依赖安装次数（防依赖地狱）。 */
  maxDependencyInstalls: number;
}

export const DEFAULT_GATE_LIMITS: GateLimits = {
  maxIterations: 15,
  maxWallClockMs: 2 * 60 * 60 * 1000,
  maxClarificationRounds: 5,
  maxTrialRuns: 30,
  maxDependencyInstalls: 10,
};

/** 终止原因（如实上报中台——中台据此决定换机器 / 转人工 / 修订 SOP）。 */
export type GateStopReason =
  | 'iteration_limit'
  | 'wall_clock'
  | 'clarification_limit'
  | 'trial_run_limit'
  | 'dependency_install_limit';

/** 闸门的运行计数（可序列化：要随会话持久化，resume 时原样恢复）。 */
export interface GateCounters {
  iterations: number;
  clarifications: number;
  trialRuns: number;
  dependencyInstalls: number;
  /** 首次迭代时刻（epoch ms）。0 = 尚未开始。 */
  startedAt: number;
}

export interface GateSnapshot {
  counters: GateCounters;
  limits: GateLimits;
}

export type GateDecision =
  | { allowed: true }
  | { allowed: false; reason: GateStopReason; message: string };

export function createCounters(now: number = Date.now()): GateCounters {
  return {
    iterations: 0,
    clarifications: 0,
    trialRuns: 0,
    dependencyInstalls: 0,
    startedAt: now,
  };
}

/** 归一化上限：任何非法/缺失/非正数 → 默认值（fail-safe 到**有闸**，不是到无闸）。 */
export function normalizeLimits(input: Partial<GateLimits> | null | undefined): GateLimits {
  const pick = (v: unknown, fallback: number, min: number): number => {
    const n = typeof v === 'number' ? Math.floor(v) : NaN;
    if (!Number.isFinite(n) || n < min) return fallback;
    return n;
  };
  return {
    maxIterations: pick(input?.maxIterations, DEFAULT_GATE_LIMITS.maxIterations, 1),
    maxWallClockMs: pick(input?.maxWallClockMs, DEFAULT_GATE_LIMITS.maxWallClockMs, 1),
    // 澄清轮次允许 0（= 不允许澄清，遇疑直接转人工）
    maxClarificationRounds: pick(input?.maxClarificationRounds, DEFAULT_GATE_LIMITS.maxClarificationRounds, 0),
    maxTrialRuns: pick(input?.maxTrialRuns, DEFAULT_GATE_LIMITS.maxTrialRuns, 0),
    maxDependencyInstalls: pick(input?.maxDependencyInstalls, DEFAULT_GATE_LIMITS.maxDependencyInstalls, 0),
  };
}

/**
 * 闸门判定：**在动作发生之前**调用。
 *
 * `kind` 是即将执行的动作类别。判定只看**当前**计数与上限——即"再执行一次
 * 是否会超出"，因此调用方必须在动作**前**问、在动作**后**记账。问反了
 * （先做后问）就是 P2 里论证过的「闸门在末尾」失效形态。
 */
export function checkGate(
  snapshot: GateSnapshot,
  kind: 'iterate' | 'clarify' | 'trial_run' | 'dependency_install',
  now: number = Date.now(),
): GateDecision {
  const { counters: c, limits: l } = snapshot;

  // 墙钟：自首次迭代起算，与具体动作无关——任何动作前都要先判。
  // 只在 startedAt > 0 时判（尚未开始的会话不该被 0 时间戳判死）。
  if (c.startedAt > 0 && now - c.startedAt >= l.maxWallClockMs) {
    return {
      allowed: false,
      reason: 'wall_clock',
      message: `会话墙钟已达上限（${Math.round((now - c.startedAt) / 1000)}s ≥ ${Math.round(l.maxWallClockMs / 1000)}s）`,
    };
  }

  switch (kind) {
    case 'iterate':
      if (c.iterations >= l.maxIterations) {
        return {
          allowed: false,
          reason: 'iteration_limit',
          message: `迭代轮次已达上限（${c.iterations} ≥ ${l.maxIterations}）`,
        };
      }
      return { allowed: true };
    case 'clarify':
      if (c.clarifications >= l.maxClarificationRounds) {
        return {
          allowed: false,
          reason: 'clarification_limit',
          message: `澄清轮次已达上限（${c.clarifications} ≥ ${l.maxClarificationRounds}）——按 04 §3 转人工上报`,
        };
      }
      return { allowed: true };
    case 'trial_run':
      if (c.trialRuns >= l.maxTrialRuns) {
        return {
          allowed: false,
          reason: 'trial_run_limit',
          message: `试跑次数已达上限（${c.trialRuns} ≥ ${l.maxTrialRuns}）`,
        };
      }
      return { allowed: true };
    case 'dependency_install':
      if (c.dependencyInstalls >= l.maxDependencyInstalls) {
        return {
          allowed: false,
          reason: 'dependency_install_limit',
          message: `依赖安装次数已达上限（${c.dependencyInstalls} ≥ ${l.maxDependencyInstalls}）`,
        };
      }
      return { allowed: true };
  }
}

/**
 * 记账：**在动作发生之后**调用（与 checkGate 成对）。
 *
 * 返回新对象（不改入参）——计数要随会话持久化，就地改写会让"落盘前的
 * 中间态"与"已落盘态"在内存里不可区分。
 *
 * `iterate` 首次调用时补记 startedAt：会话真正的起点是**第一次迭代**，
 * 不是会话对象创建的时刻（创建后可能长时间排队/等首次 poll）。
 */
export function recordAction(
  counters: GateCounters,
  kind: 'iterate' | 'clarify' | 'trial_run' | 'dependency_install',
  now: number = Date.now(),
): GateCounters {
  const next: GateCounters = { ...counters };
  if (kind === 'iterate') {
    if (next.startedAt <= 0) next.startedAt = now;
    next.iterations += 1;
    return next;
  }
  if (kind === 'clarify') next.clarifications += 1;
  else if (kind === 'trial_run') next.trialRuns += 1;
  else next.dependencyInstalls += 1;
  return next;
}

/**
 * 会话摘要（上报中台 / 托盘展示 / 审计留痕共用同一份形状）。
 *
 * 为什么把「还剩下多少」一并算出来：中台据此判断"换台机器有没有意义"
 * （试跑打满 vs 澄清打满，处置完全不同），而不必在中台侧复刻一份上限
 * 语义——复刻必然漂移（P2 里 getActiveRoute 已经踩过一次）。
 */
export function summarizeGates(
  snapshot: GateSnapshot,
  now: number = Date.now(),
): {
  iterations: { used: number; limit: number };
  clarifications: { used: number; limit: number };
  trialRuns: { used: number; limit: number };
  dependencyInstalls: { used: number; limit: number };
  elapsedMs: number;
  wallClockLimitMs: number;
} {
  const { counters: c, limits: l } = snapshot;
  return {
    iterations: { used: c.iterations, limit: l.maxIterations },
    clarifications: { used: c.clarifications, limit: l.maxClarificationRounds },
    trialRuns: { used: c.trialRuns, limit: l.maxTrialRuns },
    dependencyInstalls: { used: c.dependencyInstalls, limit: l.maxDependencyInstalls },
    elapsedMs: c.startedAt > 0 ? Math.max(0, now - c.startedAt) : 0,
    wallClockLimitMs: l.maxWallClockMs,
  };
}
