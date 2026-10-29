import { Injectable, Logger } from "@nestjs/common";

import { MetricsService } from "./metrics.service";

/**
 * rt-4（第 3 轮运行时审计）：Dashboard 快照的**跨连接复用**。
 *
 * ## 缺陷
 * `/metrics/stream` 的快照曾在**每条连接**的循环里各自重算：`getSummary`
 * （4 个 COUNT + 30 天 GROUP BY + 30 天 AVG）+ `getExecutorStats` + 调度器
 * 指标（打 Redis）。槽位默认 32 → 32×7÷3s ≈ 75 SQL/s，其中 64 条是 30 天
 * 窗口聚合；白皮书建议扩到 300 时是 600 SQL/s——监控自己会把 DB 池打满，
 * 而这些连接请求的是**同一份**数据。
 *
 * ## 修法（最小、不改 SSE 协议）
 * 单飞 + 短 TTL 缓存：同一时刻只有一个计算在飞，2s 内的后续请求复用同一
 * Promise。连接仍按自己的节奏发帧（帧可能重复上一拍的数据），协议零变化；
 * 数据最多陈旧一个缓存窗口（默认 2s，远小于 Dashboard 的容忍度）。
 *
 * 为什么不是「进程级定时泵广播」：那要引入订阅者生命周期、定时器与优雅停机
 * 的新面；单飞缓存用同样的复用收益，但失败语义仍是「这一拍各连接各自
 * fail-open」——一个查询挂了不会影响别的连接。
 *
 * 失败不抛出：任一查询失败记入 `errors`（连接据此发 error 帧），快照仍返回
 * 可用的其余段。失败结果同样进缓存——DB 抖动时 2s 内不重复打 DB 是好事。
 */
export interface DashboardSnapshot {
  summary: unknown;
  executors: unknown;
  scheduler: unknown;
  errors: string[];
}

/** 缓存窗口：2s（Dashboard 3s 一拍，最坏多陈旧 2s）。 */
export const DASHBOARD_SNAPSHOT_TTL_MS = 2_000;

@Injectable()
export class MetricsSnapshotCacheService {
  private readonly logger = new Logger(MetricsSnapshotCacheService.name);
  private cached: { at: number; promise: Promise<DashboardSnapshot> } | null =
    null;
  /**
   * 单飞句柄（第 6 轮审计 P2）：TTL 从**开始**计时，慢查询下 TTL 可能先于
   * 计算完成到期——没有独立的 inflight 闸时，后续请求会再起一次 30 天聚合，
   * 连接数级地重新打 PG（正是本缓存要消除的负载）。有 inflight 时一律合流。
   */
  private inflight: Promise<DashboardSnapshot> | null = null;

  constructor(private readonly metrics: MetricsService) {}

  /** 取当前快照：TTL 内/在飞时复用同一 Promise。 */
  getSnapshot(now: number = Date.now()): Promise<DashboardSnapshot> {
    // 在飞的计算优先合流：慢查询下 TTL 已到期也不能再起一份。
    if (this.inflight) return this.inflight;
    if (this.cached && now - this.cached.at < DASHBOARD_SNAPSHOT_TTL_MS) {
      return this.cached.promise;
    }
    const promise = this.compute().finally(() => {
      if (this.inflight === promise) this.inflight = null;
    });
    this.inflight = promise;
    this.cached = { at: now, promise };
    return promise;
  }

  /** 测试/运维用：丢弃缓存（下一拍重新计算）。 */
  invalidate(): void {
    this.cached = null;
  }

  private async compute(): Promise<DashboardSnapshot> {
    const errors: string[] = [];
    const [summary, executors, scheduler] = await Promise.all([
      this.metrics.getSummary().catch((err: unknown) => {
        errors.push("summary");
        this.logFailure("summary", err);
        return null;
      }),
      this.metrics.getExecutorStats().catch((err: unknown) => {
        errors.push("executors");
        this.logFailure("executors", err);
        return null;
      }),
      this.metrics.getSchedulerMetrics().catch((err: unknown) => {
        errors.push("scheduler");
        this.logFailure("scheduler", err);
        return null;
      }),
    ]);
    return { summary, executors, scheduler, errors };
  }

  private logFailure(name: string, err: unknown): void {
    // fail-open：单查询失败只降级该段（帧内 failed 数组透出），不终止流
    this.logger.warn(
      `Metrics snapshot query ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
