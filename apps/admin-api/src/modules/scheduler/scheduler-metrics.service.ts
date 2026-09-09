import { Injectable } from "@nestjs/common";

/**
 * R4-§5.5 可观测性：进程内调度指标计数器（零新依赖）。
 *
 * 设计权衡：
 * - prom-client 未出现在 apps/admin-api/package.json，按任务约束不引入；
 *   这里用纯内存单调计数 + 读取时计算速率的轻量方案，由
 *   MetricsService GET /metrics/scheduler 端点暴露。
 * - 计数是 per-process 的：多实例部署时每个实例暴露自己的计数（端点
 *   响应里带 instance 标识）；跨实例聚合留给外部抓取方（Prometheus
 *   per-target 天然支持），不在本服务内引入共享存储。
 * - resetSnapshotAt 支持读取端按"自上次快照以来的增量"观察趋势，
 *   计数本身永不重置（单调计数器语义，与 Prometheus counter 对齐）。
 */
export interface SchedulerMetricsSnapshot {
  /** 扫描 tick（reload）执行次数与累计耗时（毫秒） */
  ticks: number;
  tickDurationMsTotal: number;
  /** tick 最近一次耗时（毫秒），便于观察毛刺 */
  lastTickDurationMs: number;
  /** 上次 tick 时间（ISO），null 表示本进程尚未 tick */
  lastTickAt: string | null;
  /** enqueue 触发结果分类计数 */
  triggersClaimed: number;
  triggersSkippedLockHeld: number;
  triggersSkippedDbClaim: number;
  triggersSkippedInactive: number;
  triggersSkippedBlockStrategy: number;
  /** FEAT-06：命中任务级维护窗口被跳过的触发数 */
  triggersSkippedMaintenance: number;
  triggersFailed: number;
  /** 依赖扇出触发计数（R4-P3 claim 赢家）与被去重跳过数 */
  dependencyTriggersClaimed: number;
  dependencyTriggersSkipped: number;
  /** CORE-06：定时触发 fire→入队延迟直方图（仅 fixed_rate/cron 记录） */
  triggerLatencyCount: number;
  triggerLatencySumMs: number;
  /** 与 TRIGGER_LATENCY_BUCKETS_MS 对齐的累计桶计数（<= le） */
  triggerLatencyBuckets: number[];
  /** 最近一次延迟（毫秒），毛刺观测 */
  lastTriggerLatencyMs: number;
  /** 进程启动时间（ISO），供速率计算 */
  startedAt: string;
}

/** CORE-06：延迟直方图桶上界（毫秒），渲染端 le 标签与此逐字对齐 */
export const TRIGGER_LATENCY_BUCKETS_MS = [
  10, 50, 100, 250, 500, 1000, 2500, 5000,
];

/** 读取时计算的派生速率（每秒），基于进程启动时间 */
export interface SchedulerMetricsDerived {
  avgTickDurationMs: number;
  tickRatePerSec: number;
  triggerClaimRatePerSec: number;
  /** CORE-06：触发延迟均值/P99（无样本时为 0） */
  avgTriggerLatencyMs: number;
  p99TriggerLatencyMs: number;
}

@Injectable()
export class SchedulerMetricsService {
  private startedAt = new Date();
  private ticks = 0;
  private tickDurationMsTotal = 0;
  private lastTickDurationMs = 0;
  private lastTickAt: Date | null = null;
  private triggersClaimed = 0;
  private triggersSkippedLockHeld = 0;
  private triggersSkippedDbClaim = 0;
  private triggersSkippedInactive = 0;
  private triggersSkippedBlockStrategy = 0;
  private triggersSkippedMaintenance = 0;
  private triggersFailed = 0;
  private dependencyTriggersClaimed = 0;
  private dependencyTriggersSkipped = 0;
  private triggerLatencyCount = 0;
  private triggerLatencySumMs = 0;
  private triggerLatencyBuckets = new Array<number>(
    TRIGGER_LATENCY_BUCKETS_MS.length,
  ).fill(0);
  private lastTriggerLatencyMs = 0;

  /** 记录一次调度扫描 tick 及其耗时 */
  recordTick(durationMs: number): void {
    this.ticks++;
    this.tickDurationMsTotal += durationMs;
    this.lastTickDurationMs = durationMs;
    this.lastTickAt = new Date();
  }

  /** 记录一次触发被成功 claim（即将/已创建执行并入队） */
  recordTriggerClaimed(): void {
    this.triggersClaimed++;
  }

  /** 记录一次触发因"Redis 去重锁被持有"被跳过 */
  recordTriggerSkippedLockHeld(): void {
    this.triggersSkippedLockHeld++;
  }

  /** 记录一次触发因"DB claim 窗口内已被领取"被跳过 */
  recordTriggerSkippedDbClaim(): void {
    this.triggersSkippedDbClaim++;
  }

  /** 记录一次触发因"任务已非 ACTIVE"被跳过 */
  recordTriggerSkippedInactive(): void {
    this.triggersSkippedInactive++;
  }

  /** 记录一次触发因"blockStrategy=DISCARD 命中运行中执行"被跳过 */
  recordTriggerSkippedBlockStrategy(): void {
    this.triggersSkippedBlockStrategy++;
  }

  /** FEAT-06: 记录一次触发因"命中任务级维护窗口"被跳过 */
  recordTriggerSkippedMaintenance(): void {
    this.triggersSkippedMaintenance++;
  }

  /** 记录一次触发失败（入队/补偿失败等） */
  recordTriggerFailed(): void {
    this.triggersFailed++;
  }

  /** 记录一次依赖扇出 claim 成功（下游将被触发） */
  recordDependencyTriggerClaimed(): void {
    this.dependencyTriggersClaimed++;
  }

  /** 记录一次依赖扇出因短窗去重被跳过 */
  recordDependencyTriggerSkipped(): void {
    this.dependencyTriggersSkipped++;
  }

  /** CORE-06：记录一次定时触发的 fire→入队延迟（毫秒） */
  recordTriggerLatency(latencyMs: number): void {
    const clamped = Math.max(0, latencyMs);
    this.triggerLatencyCount++;
    this.triggerLatencySumMs += clamped;
    this.lastTriggerLatencyMs = clamped;
    for (let i = 0; i < TRIGGER_LATENCY_BUCKETS_MS.length; i++) {
      if (clamped <= TRIGGER_LATENCY_BUCKETS_MS[i]) {
        this.triggerLatencyBuckets[i]++;
      }
    }
  }

  get snapshot(): SchedulerMetricsSnapshot {
    return {
      ticks: this.ticks,
      tickDurationMsTotal: this.tickDurationMsTotal,
      lastTickDurationMs: this.lastTickDurationMs,
      lastTickAt: this.lastTickAt ? this.lastTickAt.toISOString() : null,
      triggersClaimed: this.triggersClaimed,
      triggersSkippedLockHeld: this.triggersSkippedLockHeld,
      triggersSkippedDbClaim: this.triggersSkippedDbClaim,
      triggersSkippedInactive: this.triggersSkippedInactive,
      triggersSkippedBlockStrategy: this.triggersSkippedBlockStrategy,
      triggersSkippedMaintenance: this.triggersSkippedMaintenance,
      triggersFailed: this.triggersFailed,
      dependencyTriggersClaimed: this.dependencyTriggersClaimed,
      dependencyTriggersSkipped: this.dependencyTriggersSkipped,
      triggerLatencyCount: this.triggerLatencyCount,
      triggerLatencySumMs: this.triggerLatencySumMs,
      triggerLatencyBuckets: [...this.triggerLatencyBuckets],
      lastTriggerLatencyMs: this.lastTriggerLatencyMs,
      startedAt: this.startedAt.toISOString(),
    };
  }

  /** 派生速率（每秒），基于进程启动时间——单调计数器语义，不重置 */
  get derived(): SchedulerMetricsDerived {
    const uptimeSec = Math.max(
      (Date.now() - this.startedAt.getTime()) / 1000,
      0.001,
    );
    return {
      avgTickDurationMs:
        this.ticks > 0 ? this.tickDurationMsTotal / this.ticks : 0,
      tickRatePerSec: this.ticks / uptimeSec,
      triggerClaimRatePerSec: this.triggersClaimed / uptimeSec,
      avgTriggerLatencyMs:
        this.triggerLatencyCount > 0
          ? this.triggerLatencySumMs / this.triggerLatencyCount
          : 0,
      p99TriggerLatencyMs: this.p99TriggerLatency(),
    };
  }

  /** CORE-06：由累计桶插值 P99（+Inf 桶 = count） */
  private p99TriggerLatency(): number {
    if (this.triggerLatencyCount === 0) return 0;
    const rank = Math.ceil(0.99 * this.triggerLatencyCount);
    let cumulative = 0;
    for (let i = 0; i < TRIGGER_LATENCY_BUCKETS_MS.length; i++) {
      cumulative = this.triggerLatencyBuckets[i];
      if (cumulative >= rank) {
        const lower = i === 0 ? 0 : TRIGGER_LATENCY_BUCKETS_MS[i - 1];
        const upper = TRIGGER_LATENCY_BUCKETS_MS[i];
        const prevCum = i === 0 ? 0 : this.triggerLatencyBuckets[i - 1];
        const inBucket = this.triggerLatencyBuckets[i] - prevCum;
        if (inBucket <= 0) return upper;
        return Math.round(
          lower + ((rank - prevCum) / inBucket) * (upper - lower),
        );
      }
    }
    return this.lastTriggerLatencyMs;
  }
}
