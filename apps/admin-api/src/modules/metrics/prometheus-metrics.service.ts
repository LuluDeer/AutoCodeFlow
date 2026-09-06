import { forwardRef, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Counter, Gauge, Registry, collectDefaultMetrics } from "prom-client";
import {
  SchedulerMetricsService,
  TRIGGER_LATENCY_BUCKETS_MS,
} from "../scheduler/scheduler-metrics.service";
import { SchedulerService } from "../scheduler/scheduler.service";
import {
  EXECUTION_CALLBACK_AUTH_RESULTS,
  ExecutionCallbackMetricsService,
} from "../task/execution-callback-metrics.service";
import {
  RUNTIME_COUNTERS,
  RUNTIME_GAUGES,
  RuntimeCounterName,
  RuntimeGaugeName,
} from "./runtime-metrics";
import {
  getRuntimeCountersSnapshot,
  getRuntimeGaugesSnapshot,
} from "./runtime-metrics-entry";

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
  /**
   * 可观测性补齐轮：4 个运行时计数器（执行结果成败 / SSE 并发拒绝 /
   * 通知投递结果 / callback 业务结果分类）。埋点在 TaskService /
   * NotificationService（模块级入口 runtime-metrics-entry，见该文件注释），
   * 此处只做 snapshot→render 映射，与 scheduler/callback-auth 同一模式。
   */
  private readonly runtimeCounters: Record<RuntimeCounterName, Counter>;
  /** BUG-05：运行时 gauge（SSE 活跃流/上限，瞬时值 set() 语义） */
  private readonly runtimeGauges: Record<RuntimeGaugeName, Gauge>;
  /** CORE-06：调度触发延迟直方图（bucket 累计计数 + sum/count） */
  private readonly triggerLatencyBuckets: Counter;
  private readonly triggerLatencySum: Counter;
  private readonly triggerLatencyCount: Counter;
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
    // 运行时计数器声明集中在 runtime-metrics.ts（labelNames 空数组时
    // prom-client 对无标签 Counter 的 inc() 同样成立）。
    this.runtimeCounters = Object.fromEntries(
      (Object.keys(RUNTIME_COUNTERS) as RuntimeCounterName[]).map((name) => [
        name,
        new Counter({
          name,
          help: RUNTIME_COUNTERS[name].help,
          labelNames: RUNTIME_COUNTERS[name].labelNames as string[],
          registers: [this.registry],
        }),
      ]),
    ) as Record<RuntimeCounterName, Counter>;
    this.runtimeGauges = Object.fromEntries(
      (Object.keys(RUNTIME_GAUGES) as RuntimeGaugeName[]).map((name) => [
        name,
        new Gauge({
          name,
          help: RUNTIME_GAUGES[name].help,
          registers: [this.registry],
        }),
      ]),
    ) as Record<RuntimeGaugeName, Gauge>;
    this.triggerLatencyBuckets = new Counter({
      name: "autoflow_scheduler_trigger_latency_ms_bucket",
      help: "Scheduled trigger fire-to-enqueued latency cumulative buckets (le in ms; +Inf = count)",
      labelNames: ["le"] as const,
      registers: [this.registry],
    });
    this.triggerLatencySum = new Counter({
      name: "autoflow_scheduler_trigger_latency_ms_sum",
      help: "Cumulative scheduled trigger fire-to-enqueued latency in milliseconds",
      registers: [this.registry],
    });
    this.triggerLatencyCount = new Counter({
      name: "autoflow_scheduler_trigger_latency_ms_count",
      help: "Scheduled triggers recorded in the latency histogram",
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

    // 可观测性补齐轮：运行时计数器——同一 reset+inc 快照模式；已知标签
    // 组合全部显式 inc（inc(0) 保留 0 值 series，series 集合稳定），快照中
    // 观测到的额外组合（理论上不出现，标签值均为固定枚举）一并呈现，
    // 保证抓取侧取值序列单调。
    const runtime = getRuntimeCountersSnapshot();
    for (const name of Object.keys(
      this.runtimeCounters,
    ) as RuntimeCounterName[]) {
      const counter = this.runtimeCounters[name];
      const spec = RUNTIME_COUNTERS[name];
      counter.reset();
      const byLabel = runtime.get(name);
      const rendered = new Set<string>();
      for (const labels of spec.labelValueSets) {
        counter.inc(
          labels as Record<string, string>,
          byLabel?.get(JSON.stringify(labels)) ?? 0,
        );
        rendered.add(JSON.stringify(labels));
      }
      if (byLabel) {
        for (const [key, value] of byLabel) {
          if (!rendered.has(key)) {
            counter.inc(JSON.parse(key) as Record<string, string>, value);
          }
        }
      }
    }

    // BUG-05：运行时 gauge——绝对值 set()，无 reset 需要（gauge 非单调）。
    const gaugesSnapshot = getRuntimeGaugesSnapshot();
    for (const name of Object.keys(this.runtimeGauges) as RuntimeGaugeName[]) {
      this.runtimeGauges[name].set(gaugesSnapshot.get(name) ?? 0);
    }

    // CORE-06：触发延迟直方图——le 累计桶 + sum/count（reset+inc 快照模式，
    // counter 单调语义成立；+Inf 桶显式渲染保持 series 集合稳定）
    const lat = s.triggerLatencyBuckets ?? [];
    this.triggerLatencyBuckets.reset();
    let prevCum = 0;
    for (let i = 0; i < TRIGGER_LATENCY_BUCKETS_MS.length; i++) {
      const cum = lat[i] ?? 0;
      this.triggerLatencyBuckets.inc(
        { le: String(TRIGGER_LATENCY_BUCKETS_MS[i]) },
        cum - prevCum,
      );
      prevCum = cum;
    }
    this.triggerLatencyBuckets.inc({ le: "+Inf" }, s.triggerLatencyCount);
    this.triggerLatencySum.reset();
    this.triggerLatencySum.inc(s.triggerLatencySumMs);
    this.triggerLatencyCount.reset();
    this.triggerLatencyCount.inc(s.triggerLatencyCount);

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
