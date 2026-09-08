import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { setRuntimeGauge } from "./runtime-metrics-entry";

/**
 * UI-14 第一阶段：GET /metrics/stream（Dashboard 汇总 SSE）并发槽位注册表。
 *
 * 与 task.service 的日志流槽位（TASK-008）同语义但独立计数——日志流与汇总流
 * 的容量画像不同（日志流按 execution 维度限流，汇总流是每客户端一条），混用
 * 同一注册表会让任意一侧挤占另一侧的上限。两级限制只取全局级：
 * - 默认上限 32（METRICS_STREAM_MAX_GLOBAL 可覆盖）——Dashboard 页面数量
 *   （浏览器 Tab 数）远小于日志流并发量；
 * - 释放幂等（released 标记 + finally 双保险，同 task.controller logs/stream
 *   先例）。
 *
 * BUG-05 容量纪律：占用/释放两点同步写 runtime gauge
 * （autoflow_metrics_streams_active/limit），PrometheusMetricsService 渲染侧
 * 已支持同款 set() 绝对值 gauge（autoflow_sse_streams_* 先例）。
 */
@Injectable()
export class MetricsStreamSlotService {
  private readonly logger = new Logger(MetricsStreamSlotService.name);

  private activeStreams = 0;

  private static readonly MAX_GLOBAL_DEFAULT = 32;

  private get maxGlobal(): number {
    const raw = this.configService.get<number | string>(
      "metricsStream.maxStreamsGlobal",
    );
    const n = typeof raw === "string" ? parseInt(raw, 10) : raw;
    return Number.isFinite(n) && n > 0
      ? n
      : MetricsStreamSlotService.MAX_GLOBAL_DEFAULT;
  }

  constructor(private readonly configService: ConfigService) {}

  /**
   * 尝试占用一个汇总流槽位；超限抛 503（全局异常过滤器渲染为标准 503，
   * 而非半开的 SSE 流——同 task.controller 先例）。
   * 返回幂等 release 函数。
   */
  acquireSlot(): () => void {
    const max = this.maxGlobal;
    if (this.activeStreams >= max) {
      throw new ServiceUnavailableException(
        `Too many concurrent metrics streams (max ${max})`,
      );
    }
    this.activeStreams++;
    setRuntimeGauge("autoflow_metrics_streams_active", this.activeStreams);
    setRuntimeGauge("autoflow_metrics_streams_limit", max);
    this.logger.debug(
      `Metrics stream slot acquired (${this.activeStreams}/${max})`,
    );

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeStreams = Math.max(0, this.activeStreams - 1);
      setRuntimeGauge("autoflow_metrics_streams_active", this.activeStreams);
      this.logger.debug(
        `Metrics stream slot released (${this.activeStreams}/${max})`,
      );
    };
  }

  /** 当前活跃流数（测试/诊断用）。 */
  get active(): number {
    return this.activeStreams;
  }
}
