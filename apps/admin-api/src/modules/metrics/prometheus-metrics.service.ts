import { forwardRef, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Counter, Gauge, Registry, collectDefaultMetrics } from "prom-client";
import { SchedulerMetricsService } from "../scheduler/scheduler-metrics.service";
import { SchedulerService } from "../scheduler/scheduler.service";
import {
  EXECUTION_CALLBACK_AUTH_RESULTS,
  ExecutionCallbackMetricsService,
} from "../task/execution-callback-metrics.service";

/** BullMQ 队列深度状态维度（与 SchedulerService.getQueueDepth 的返回键一致） */
const QUEUE_STATES = [
  "waiting",
  "active",
  "delayed",
  "failed",
  "completed",
] as const;

/**
 * R7: Prometheus 抓取端点（GET /api/metrics，text exposition format）。
 *
 * 映射策略：抓取时读取 SchedulerMetricsService 的进程内快照，reset+inc
 * 同步进本服务自有的独立 Registry——快照本身是单调计数器（唯一事实来源），
 * 因此相邻两次抓取的取值序列保持单调（counter 语义成立），且无需在调度
 * 热路径的每个 record* 调用点挂钩（对 scheduler 零侵入）。
 * 独立 Registry 而非全局默认 registry：避免与依赖库注册的指标互相污染，
 * 也让单元测试天然隔离。
 *
 * 鉴权姿态与 GET /metrics/scheduler 完全一致（MetricsController 类级
 * JwtAuthGuard）；多实例部署时每个实例暴露自己的进程内计数，由 Prometheus
 * per-target 抓取天然区分。
 */
@Injectable()
export class PrometheusMetricsService {
  private readonly registry = new Registry();
  private readonly ticks: Counter;
  private readonly tickDurationMsTotal: Counter;
  private readonly lastTickDurationMs: Gauge;
  private readonly triggers: Counter;
  private readonly triggersSkipped: Counter;
  private readonly dependencyTriggers: Counter;
  private readonly queueUp: Gauge;
  private readonly queueDepth: Gauge;
  private readonly callbackAuth: Counter;
  private readonly _enabled: boolean;
  /** N31: 进行中的 render（并发抓取共享同一次重建，见 render 注释） */
  private renderInFlight: Promise<string> | null = null;

  constructor(
    configService: ConfigService,
    private readonly schedulerMetrics: SchedulerMetricsService,
    // 与 MetricsService 相同的 forwardRef 模式：SchedulerModule 提供
    // SchedulerService（getQueueDepth 的唯一入口），无模块环。
    @Inject(forwardRef(() => SchedulerService))
    private readonly schedulerService: SchedulerService,
    // N32: callback 401 分类计数（TaskModule 提供并导出，进程内单例）。
    private readonly callbackMetrics: ExecutionCallbackMetricsService,
  ) {
    this._enabled =
      configService.get<boolean>("metrics.prometheus.enabled") !== false;
    // 进程默认指标（CPU/内存/GC/event-loop）：默认开启，
    // METRICS_PROMETHEUS_DEFAULT_METRICS_ENABLED=false 可关（裁剪抓取体积）。
    if (
      configService.get<boolean>("metrics.prometheus.defaultMetricsEnabled") !==
      false
    ) {
      collectDefaultMetrics({ register: this.registry });
    }

    this.ticks = new Counter({
      name: "autoflow_scheduler_ticks_total",
      help: "Scheduler scan ticks (reload) executed by this process",
      registers: [this.registry],
    });
    this.tickDurationMsTotal = new Counter({
      name: "autoflow_scheduler_tick_duration_ms_total",
      help: "Cumulative scheduler tick duration in milliseconds",
      registers: [this.registry],
    });
    this.lastTickDurationMs = new Gauge({
      name: "autoflow_scheduler_last_tick_duration_ms",
      help: "Duration of the most recent scheduler tick in milliseconds",
      registers: [this.registry],
    });
    this.triggers = new Counter({
      name: "autoflow_scheduler_triggers_total",
      help: "Scheduler trigger outcomes by result (claimed / failed)",
      labelNames: ["result"] as const,
      registers: [this.registry],
    });
    this.triggersSkipped = new Counter({
      name: "autoflow_scheduler_triggers_skipped_total",
      help: "Scheduler triggers skipped, by reason",
      labelNames: ["reason"] as const,
      registers: [this.registry],
    });
    this.dependencyTriggers = new Counter({
      name: "autoflow_scheduler_dependency_triggers_total",
      help: "Dependency fan-out triggers by result (claimed / skipped)",
      labelNames: ["result"] as const,
      registers: [this.registry],
    });
    this.queueUp = new Gauge({
      name: "autoflow_queue_up",
      help: "1 when BullMQ queue counters are readable from Redis, 0 otherwise",
      registers: [this.registry],
    });
    this.queueDepth = new Gauge({
      name: "autoflow_queue_depth",
      help: "BullMQ task queue job counts by state (0 when Redis is unavailable)",
      labelNames: ["state"] as const,
      registers: [this.registry],
    });
    // N32 (round-9): execution callback 认证结果分类计数——per-execution
    // `v1.` token 落地后，生产排障需要按 result 标签区分 401 原因。
    this.callbackAuth = new Counter({
      name: "autoflow_execution_callback_auth_total",
      help: "Execution callback authentication outcomes by result (ok / failure category)",
      labelNames: ["result"] as const,
      registers: [this.registry],
    });
  }

  /** METRICS_PROMETHEUS_ENABLED 开关（false 时控制器对端点返回 404） */
  get enabled(): boolean {
    return this._enabled;
  }

  /** 响应 Content-Type（prom-client registry 提供，勿手写） */
  get contentType(): string {
    return this.registry.contentType;
  }

  /** 同步进程内快照 → Registry，并渲染 text exposition format */
  async render(): Promise<string> {
    // N31: render 是"reset + 按绝对值重建"的复合写——并发交错（A reset 后
    // 被 B reset，A 再按旧快照 inc）会让 Registry 短暂呈现计数回退，违反
    // counter 单调不变量。快照本身单调，串行化 render 即可保证输出序列
    // 单调；互斥只覆盖本服务，不影响调度热路径。
    if (this.renderInFlight) {
      return this.renderInFlight;
    }
    this.renderInFlight = this.doRender().finally(() => {
      this.renderInFlight = null;
    });
    return this.renderInFlight;
  }

  private async doRender(): Promise<string> {
    const s = this.schedulerMetrics.snapshot;

    // reset 后按快照绝对值重建 series：inc(0) 也会保留 0 值 series，
    // 保证 rate() 在首次计数前就有可计算的基线。
    this.ticks.reset();
    this.ticks.inc(s.ticks);
    this.tickDurationMsTotal.reset();
    this.tickDurationMsTotal.inc(s.tickDurationMsTotal);
    this.lastTickDurationMs.set(s.lastTickDurationMs);

    this.triggers.reset();
    this.triggers.inc({ result: "claimed" }, s.triggersClaimed);
    this.triggers.inc({ result: "failed" }, s.triggersFailed);

    this.triggersSkipped.reset();
    this.triggersSkipped.inc(
      { reason: "lock_held" },
      s.triggersSkippedLockHeld,
    );
    this.triggersSkipped.inc({ reason: "db_claim" }, s.triggersSkippedDbClaim);
    this.triggersSkipped.inc({ reason: "inactive" }, s.triggersSkippedInactive);
    this.triggersSkipped.inc(
      { reason: "block_strategy" },
      s.triggersSkippedBlockStrategy,
    );

    this.dependencyTriggers.reset();
    this.dependencyTriggers.inc(
      { result: "claimed" },
      s.dependencyTriggersClaimed,
    );
    this.dependencyTriggers.inc(
      { result: "skipped" },
      s.dependencyTriggersSkipped,
    );

    // N32: callback 认证分类 series——同一 reset+inc 快照模式；七个 result
    // 标签全部显式 inc（inc(0) 保留 0 值 series），抓取方无需处理 series
    // 消失，rate() 自首次计数前即可计算。
    const cb = this.callbackMetrics.snapshot;
    this.callbackAuth.reset();
    for (const result of EXECUTION_CALLBACK_AUTH_RESULTS) {
      this.callbackAuth.inc({ result }, cb.auth[result]);
    }

    const depth = await this.schedulerService.getQueueDepth();
    // getQueueDepth 在 Redis 不可用时返回全 null：以 autoflow_queue_up=0
    // 表达"队列不可读"，深度 series 置 0 保持集合稳定（抓取方无需处理
    // series 消失）。
    const up = QUEUE_STATES.every((state) => depth[state] !== null);
    this.queueUp.set(up ? 1 : 0);
    for (const state of QUEUE_STATES) {
      this.queueDepth.set({ state }, up ? (depth[state] ?? 0) : 0);
    }

    return this.registry.metrics();
  }
}
