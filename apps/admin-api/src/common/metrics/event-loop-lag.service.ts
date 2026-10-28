import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { SchedulerMetricsService } from "../../modules/scheduler/scheduler-metrics.service";

/**
 * INCIDENT-2026-10-28（P1-2）：事件循环阻塞监控。
 *
 * ## 为什么需要它
 *
 * 10-28 11:59 那次冻结，应用侧**零数据留存**：`AutoCodeFlow.log` 里
 * 11:59:04 之后到 11:59:44 之间有 40.6 秒、0 行输出，除此之外什么都没留下。
 * 事故时间线完全靠 nginx access、PG log、redis.log 三条外部证据交叉对齐才
 * 还原出来——这不该是常态。
 *
 * 当时全仓 `grep monitorEventLoopDelay|perf_hooks|eventLoopLag` → 0 命中。
 *
 * ## 阈值为什么是 1s
 *
 * 与 P0-3 的 `missedExecutionTolerance` 对齐：引擎的漏跑容错最小 1s，超过
 * 1s 的阻塞就**可能已经丢了调度落点**。用故障语义定阈值，比拍脑袋的百分比
 * 更可操作。
 *
 * ## 为什么用 histogram 而不是 setTimeout 差值
 *
 * `monitorEventLoopDelay()` 由 Node 内建、零新依赖（`perf_hooks`），并且在
 * **C++ 侧**采样，比在 JS 里用 `setTimeout(0)` 测差值更准（后者本身就被
 * 事件循环阻塞影响，且高频自旋）。它给出 max 与任意分位数。
 *
 * 注意：模块求值期不能用它——必须在 `onModuleInit` 里 `enable()`。
 */
export const EVENT_LOOP_LAG_WARN_MS = 1_000;

/** 采样上报周期。30s 足以覆盖"一次冻结"的粒度，又不至于刷屏。 */
export const EVENT_LOOP_SAMPLE_INTERVAL_MS = 30_000;

/** 单次采样窗口的观测结果（毫秒）。 */
export interface EventLoopLagSample {
  /** 窗口内最大阻塞时长 */
  maxMs: number;
  /** 窗口内 p99 阻塞时长 */
  p99Ms: number;
  /** 采样时刻（ISO） */
  at: string;
}

@Injectable()
export class EventLoopLagService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventLoopLagService.name);
  private readonly histogram = monitorEventLoopDelay({ resolution: 20 });
  private timer: NodeJS.Timeout | null = null;

  /** 进程启动以来观测到的最大阻塞（毫秒）——单调不降，供指标读取 */
  private worstMaxMs = 0;
  /** 累计触发告警的次数 */
  private warnCount = 0;
  /** 最近一次采样 */
  private last: EventLoopLagSample | null = null;

  constructor(private readonly schedulerMetrics: SchedulerMetricsService) {}

  onModuleInit(): void {
    this.histogram.enable();
    this.timer = setInterval(
      () => this.sample(),
      EVENT_LOOP_SAMPLE_INTERVAL_MS,
    );
    // unref：监控自身绝不能阻止进程退出
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.histogram.disable();
  }

  /**
   * 采样一次并归零直方图。
   *
   * 归零是刻意的：每次采样的语义是"**上一个 30s 窗口内**的最坏阻塞"，
   * 不是进程生命周期的最坏值。后者另由 `worstMaxMs` 单调累计保存。
   */
  private sample(): void {
    // monitorEventLoopDelay 返回纳秒
    const maxMs = this.histogram.max / 1e6;
    const p99Ms = this.histogram.percentile(99) / 1e6;
    this.histogram.reset();

    // 空窗口时 max 为 0；NaN 也可能出现在极早期（无样本）
    const safeMax = Number.isFinite(maxMs) ? Math.round(maxMs) : 0;
    const safeP99 = Number.isFinite(p99Ms) ? Math.round(p99Ms) : 0;

    this.last = {
      maxMs: safeMax,
      p99Ms: safeP99,
      at: new Date().toISOString(),
    };
    if (safeMax > this.worstMaxMs) this.worstMaxMs = safeMax;

    if (safeMax >= EVENT_LOOP_LAG_WARN_MS) {
      this.warnCount += 1;
      this.logger.warn(
        `Event loop blocked for ${safeMax}ms in the last ` +
          `${EVENT_LOOP_SAMPLE_INTERVAL_MS / 1000}s window ` +
          `(p99=${safeP99}ms) — timers/watchdogs may have been starved; ` +
          `scheduler fire points could be missed`,
      );
    }
  }

  /** 供 /api/metrics 读取的快照（纯内存，无副作用） */
  getSnapshot(): {
    lastSampleMaxMs: number;
    lastSampleP99Ms: number;
    worstMaxMs: number;
    warnCount: number;
    lastSampleAt: string | null;
    thresholdMs: number;
  } {
    return {
      lastSampleMaxMs: this.last?.maxMs ?? 0,
      lastSampleP99Ms: this.last?.p99Ms ?? 0,
      worstMaxMs: this.worstMaxMs,
      warnCount: this.warnCount,
      lastSampleAt: this.last?.at ?? null,
      thresholdMs: EVENT_LOOP_LAG_WARN_MS,
    };
  }

  /** 仅供测试：强制跑一次采样 */
  __sampleForTest(): void {
    this.sample();
  }
}
