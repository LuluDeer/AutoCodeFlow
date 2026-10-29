import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Counter, Gauge, Registry, collectDefaultMetrics } from "prom-client";
import { Repository } from "typeorm";
import { Executor, ExecutorStatus } from "../executor/entities/executor.entity";
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
  RuntimeMetricsRenderQuery,
} from "./runtime-metrics";
import {
  getRuntimeCountersSnapshot,
  getRuntimeGaugesSnapshot,
  recordRuntime,
} from "./runtime-metrics-entry";

/**
 * OBS3-05：渲染期取数失败日志的**限流窗口**（同一 query 每分钟最多 1 条 warn）。
 *
 * 为什么必须限流：这两个 catch 的触发条件是「PG 抖了」——而 PG 抖动通常持续
 * 数十秒到数分钟，期间**每次抓取**（默认 15s 一次）都会进一次 catch。不限流
 * 就是 DB 越坏日志越响，最终把 Loki 的写配额和值班人的注意力一起打满；而
 * 「第一次失败」的信息量与「第一百次失败」完全相同。因此 warn 是**状态变化
 * 通知**，逐次事实由计数器 `autoflow_metrics_render_error_total{query}` 承担
 * ——后者不限流，一次失败就是 +1（rate/increase 用它算）。
 */
const RENDER_FAILURE_LOG_INTERVAL_MS = 60_000;

/**
 * OBS3-05：`query → 上次 warn 时间戳`（**模块级**，不是实例字段）。
 *
 * 模块级而非实例级：`PrometheusMetricsService` 在进程内是单例，但单测会构造
 * 多个实例（`new PrometheusMetricsService(...)`）；限流状态若挂在实例上，
 * 「限流生效」这条不变量就会随构造方式漂移，测试也只能测到「同一个实例内的
 * 第二次」而不是真实运行时的行为。
 *
 * 上限 64：key 来自**固定枚举**（`RUNTIME_METRICS_RENDER_QUERIES`，当前 2 个），
 * 正常永远撞不到上限；这条 cap 是对「将来有人把任意字符串（比如 SQL 文本或
 * error.message）当 key 传进来」的防御——无界 Map 在长跑进程里就是内存泄漏。
 */
const renderFailureLoggedAt = new Map<string, number>();
const RENDER_FAILURE_LOG_MAX_ENTRIES = 64;

/**
 * OBS3-05：清空渲染失败 warn 的限流表——**仅供单元测试隔离**
 * （与 runtime-metrics-entry.resetRuntimeMetrics 同「测试专用」语义）。
 *
 * 为什么必须导出：限流表是模块级的，同一测试文件里先跑的用例（例如
 * 「DB 抖动保留旧值」那几条既有用例）已经把 `executor_disk` / `executor_fleet`
 * 的时间戳写进去了；不给测试一个显式复位入口，「限流后只打一条」这条断言就会
 * 变成**依赖用例执行顺序**的假绿/假红。生产代码不得调用（它只影响日志频率，
 * 不影响计数）。
 */
export function resetRenderFailureLogThrottle(): void {
  renderFailureLoggedAt.clear();
}

/** BullMQ 队列深度状态维度（与 SchedulerService.getQueueDepth 的返回键一致） */
const QUEUE_STATES = [
  "waiting",
  "active",
  "delayed",
  "failed",
  "completed",
] as const;

/**
 * HTTP RED 指标：`route` label 的兜底值。
 *
 * 未匹配到任何 Express 路由（404 / 全局中间件短路 / 错误请求行）时一律归到
 * 这个固定值，**绝不用原始 URL**——原始 URL 带具体 id 与查询串，每个 id 一条
 * series，是标签基数爆炸的头号来源（HttpMetricsInterceptor 只送路由模板）。
 *
 * 导出给拦截器共用，避免两处各写一个字面量后悄悄漂移。
 */
export const HTTP_ROUTE_UNMATCHED = "unmatched";

/**
 * HTTP RED 指标：请求时长直方图的桶上界（毫秒）。
 *
 * 沿用 CORE-06（autoflow_scheduler_trigger_latency_ms_*）的手写 counter 口径
 * ——本仓没有任何 prom-client Histogram（见 doRender 内 CORE-06 注释），
 * 新指标同样只允许 Counter/Gauge + reset+inc 快照重建。桶覆盖管理台 API 的
 * 常见量级：5ms ~ 5s（+Inf 由样本数收口）。
 */
const HTTP_DURATION_BUCKETS_MS = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000,
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
  /**
   * OBS3-05：本类先前**没有任何 Logger**（观测审计原文），两个 DB 取数失败
   * 分支 `catch { return; }` 连一行日志都不留——这是「静默吞掉」的一半。
   */
  private readonly logger = new Logger(PrometheusMetricsService.name);
  private readonly registry = new Registry();
  private readonly ticks: Counter;
  private readonly tickDurationMsTotal: Counter;
  private readonly lastTickDurationMs: Gauge;
  private readonly triggers: Counter;
  private readonly triggersSkipped: Counter;
  private readonly dependencyTriggers: Counter;
  private readonly queueUp: Gauge;
  private readonly queueDepth: Gauge;
  /** OBS-05：PG 连接池水位四 series（max/active/idle/waiting） */
  private readonly dbPoolMaxConnections: Gauge;
  private readonly dbPoolActiveConnections: Gauge;
  private readonly dbPoolIdleConnections: Gauge;
  private readonly dbPoolWaitingRequests: Gauge;
  /** OBS-05：executor 磁盘水位（per-executor，label=address） */
  private readonly executorDiskUsagePercent: Gauge;
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
  /**
   * HTTP RED（本轮新增）：请求数 / 时长直方图三件套 + 执行器在线水位。
   *
   * 与上面所有计数器同一姿态——**声明在这里、值由 HttpMetricsInterceptor
   * 经 recordHttpRequest() 写进程内快照**，doRender 再 reset+inc 重建：
   * prom-client 的 Counter/Gauge 是渲染层，不是埋点层（埋点侧只碰快照）。
   * 这样 /api/metrics 关闭（METRICS_PROMETHEUS_ENABLED=false）或 registry
   * 尚未抓取时，埋点仍然是零成本的内存加法。
   */
  private readonly httpRequestsTotal: Counter;
  private readonly httpRequestDurationMsBuckets: Counter;
  private readonly httpRequestDurationMsSum: Counter;
  private readonly httpRequestDurationMsCount: Counter;
  /** 执行器在线水位（AllExecutorsOffline 告警的唯一数据源） */
  private readonly executorsOnline: Gauge;
  private readonly executorsTotal: Gauge;
  /**
   * HTTP RED 快照：key = (method, route, statusClass) 的稳定编码。
   *
   * 只记录被显式观测过的标签组合（不像 scheduler 那批有固定枚举全集）——
   * 路由模板集合由代码决定、基数有界；未观测过的组合不造 0 值 series，
   * 否则「所有路由 × 所有方法 × 4 个状态类」会在首次抓取就撑爆输出体积。
   */
  private readonly httpSnapshots = new Map<string, HttpRedSnapshot>();
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
    // OBS-05：容量水位取数入口——MetricsModule 既有 forFeature(Executor)
    // 注入的仓库（同 MetricsService 注入模式）。经 repo.manager.connection
    // 可达 DataSource（driver.master = pg.Pool），无需新增 DI token。
    // 单测可缺省（undefined → 池水位全 0、磁盘 series 缺席）。
    @InjectRepository(Executor)
    private readonly executorRepository?: Repository<Executor>,
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
      help: "BullMQ task queue job counts by state (0 when Redis is unavailable) — queue water level; alert when waiting > 100 sustained 10m (AUTOFLOW_QUEUE_BACKLOG)",
      labelNames: ["state"] as const,
      registers: [this.registry],
    });
    // OBS-05（容量水位四件套）：PG 连接池水位——pg.Pool 实时计数
    // （totalCount/idleCount/waitingCount 经 DataSource.driver.master 可达，
    // 见 readPgPoolSnapshot 注释）。利用率 = active/max，waiting > 0 即饱和。
    // A-9（审计 help 漂移）：help 内嵌的告警建议逐字对齐 alerts.yml——
    // 利用率本身无独立告警规则，饱和告警是 waiting 侧的
    // AUTOFLOW_DB_POOL_WAITING（> 0 sustained 5m）。
    this.dbPoolMaxConnections = new Gauge({
      name: "autoflow_db_pool_max_connections",
      help: "Configured PostgreSQL connection pool capacity (pg Pool max, PERF-04 DB_POOL_SIZE) — denominator of the pool utilization water level; 0 when the pool handle is unreachable",
      registers: [this.registry],
    });
    this.dbPoolActiveConnections = new Gauge({
      name: "autoflow_db_pool_active_connections",
      // A-9：对齐 alerts.yml——利用率（active/max）无独立告警规则，饱和告警
      // 走 AUTOFLOW_DB_POOL_WAITING（waiting > 0 sustained 5m）；旧 help 文案
      // 声称的「alert when active/max > 0.8 sustained 5m」并无此规则。
      help: "PostgreSQL pool connections currently checked out (totalCount - idleCount) — numerator of the pool utilization ratio (active/max); no standalone utilization rule (pool saturation is alerted by AUTOFLOW_DB_POOL_WAITING on waiting requests, > 0 sustained 5m)",
      registers: [this.registry],
    });
    this.dbPoolIdleConnections = new Gauge({
      name: "autoflow_db_pool_idle_connections",
      help: "PostgreSQL pool connections currently idle and reusable (pg Pool idleCount)",
      registers: [this.registry],
    });
    this.dbPoolWaitingRequests = new Gauge({
      name: "autoflow_db_pool_waiting_requests",
      help: "Requests queued waiting for a free PostgreSQL pool connection (pg Pool waitingCount) — pool saturation water level; alert when > 0 sustained 5m",
      registers: [this.registry],
    });
    // OBS-05：executor 磁盘水位——executors 表在线执行器心跳上报的
    // diskUsage（0-100 百分数）；旧版执行器未上报（null）不造 0，series 缺席。
    this.executorDiskUsagePercent = new Gauge({
      name: "autoflow_executor_disk_usage_percent",
      // A-9：对齐 alerts.yml 两档实际规则——AUTOFLOW_EXECUTOR_DISK_USAGE_HIGH
      // （warning，> 85 sustained 10m）与 AUTOFLOW_EXECUTOR_DISK_USAGE_CRITICAL
      // （critical，> 95 sustained 5m）；旧 help 文案的「> 90 sustained 10m」
      // 与任何一档都对不上。
      help: "Executor disk usage percent reported by heartbeat (Executor.diskUsage; online executors that report it only, legacy ones absent) — disk water level per executor; alert when > 85 sustained 10m (AUTOFLOW_EXECUTOR_DISK_USAGE_HIGH, warning) or > 95 sustained 5m (AUTOFLOW_EXECUTOR_DISK_USAGE_CRITICAL, critical)",
      labelNames: ["executor"] as const,
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
    // HTTP RED（本轮新增）：Rate / Error / Duration。
    //
    // **没有 prom-client Histogram**——本仓全库没有任何 Histogram（CORE-06 的
    // autoflow_scheduler_trigger_latency_ms_bucket/_sum/_count 也是三个手写
    // Counter），这里逐字沿用同一套「三个 Counter 拼出累积直方图」的形态：
    // _bucket{le} 是累计计数、_sum 是累计毫秒、_count 是样本数，
    // histogram_quantile()/rate() 的消费口径与真实 Histogram 完全一致。
    //
    // 标签三件套固定为 method / route / status_class：
    //   · route 是 **Express 路由模板**（如 /tasks/:id），由拦截器从
    //     req.route.path + req.baseUrl 合成，绝不含具体 id 与查询串；
    //     未匹配到路由时为固定值 "unmatched"。这是控制标签基数的唯一手段。
    //   · status_class 是 "2xx"/"3xx"/"4xx"/"5xx"（非标准状态码归 "other"），
    //     4xx 与 5xx 因此可分别聚合成错误率（Error 的 E）。
    this.httpRequestsTotal = new Counter({
      name: "autoflow_http_requests_total",
      help: "HTTP requests handled by this process, by method, matched route template and status class (RED rate; route is the Express template, never the raw URL)",
      labelNames: ["method", "route", "status_class"] as const,
      registers: [this.registry],
    });
    this.httpRequestDurationMsBuckets = new Counter({
      name: "autoflow_http_request_duration_ms_bucket",
      help: "HTTP request duration cumulative buckets in milliseconds by method, route template and status class (le in ms; +Inf = count) — same hand-rolled histogram idiom as autoflow_scheduler_trigger_latency_ms_bucket (no prom-client Histogram in this repo)",
      labelNames: ["method", "route", "status_class", "le"] as const,
      registers: [this.registry],
    });
    this.httpRequestDurationMsSum = new Counter({
      name: "autoflow_http_request_duration_ms_sum",
      help: "Cumulative HTTP request duration in milliseconds by method, route template and status class",
      labelNames: ["method", "route", "status_class"] as const,
      registers: [this.registry],
    });
    this.httpRequestDurationMsCount = new Counter({
      name: "autoflow_http_request_duration_ms_count",
      help: "HTTP requests recorded in the duration histogram by method, route template and status class (avg = sum/count, P99 via histogram_quantile over _bucket)",
      labelNames: ["method", "route", "status_class"] as const,
      registers: [this.registry],
    });
    // 执行器 fleet 水位（本轮新增，数据源 = Executor 仓库，同 OBS-05 磁盘水位
    // 的取数路径）。total = executors 表行数（全部状态），online = status 为
    // ONLINE 的行数；两者都是**绝对值 set()**（gauge 语义，非单调）。
    // 关键纪律（与 renderExecutorDiskWaterLevel 一致）：DB 抖动时保留上一轮
    // 值、绝不 reset 成 0——否则一次查询失败就会把 online 打成 0，
    // AllExecutorsOffline 立刻误报「整个 fleet 掉线」。
    this.executorsOnline = new Gauge({
      name: "autoflow_executors_online",
      help: "Executors whose status is online in the executors table (fleet water level) — alert when this reaches 0 while autoflow_executors_total > 0 sustained 10m (AUTOFLOW_ALL_EXECUTORS_OFFLINE, critical); on a DB query error the previous value is kept (never reset to 0)",
      registers: [this.registry],
    });
    this.executorsTotal = new Gauge({
      name: "autoflow_executors_total",
      help: "Executor rows registered in the executors table (all statuses) — denominator of the online fleet water level; on a DB query error the previous value is kept (never reset to 0)",
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
    // A-2（审计 FEAT-06）：维护窗口跳过计数透出——快照已有该字段
    // （triggersSkippedMaintenance），渲染缺失会让「已知标签组合全部显式
    // inc(0)」的 series 稳定纪律出现缺口（该 reason 的 series 只会在首次
    // 命中维护窗口时才出现，rate() 前无基线）。
    this.triggersSkipped.inc(
      { reason: "maintenance" },
      s.triggersSkippedMaintenance,
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
    // counter 单调语义成立；+Inf 桶显式渲染保持 series 集合稳定）。
    // A-1（审计 CORE-06 渲染口径）：快照桶本身已是**累计**口径——快照侧
    // recordTriggerLatency 对每个 clamped<=bound 的桶 +1（scheduler-metrics
    // .service.ts）。Prometheus 的 *_bucket 是累积直方图，histogram_quantile/
    // rate 直接消费各 le 的绝对值，故这里按绝对值直写 inc({le}, cum)，而非
    // 相邻桶差分（差分写入边际值会违反 *_bucket 累计不变量，P50/P99 全错）。
    // +Inf 桶 = 累计 count，与中间桶同口径。
    const lat = s.triggerLatencyBuckets ?? [];
    this.triggerLatencyBuckets.reset();
    for (let i = 0; i < TRIGGER_LATENCY_BUCKETS_MS.length; i++) {
      this.triggerLatencyBuckets.inc(
        { le: String(TRIGGER_LATENCY_BUCKETS_MS[i]) },
        lat[i] ?? 0,
      );
    }
    this.triggerLatencyBuckets.inc({ le: "+Inf" }, s.triggerLatencyCount);
    this.triggerLatencySum.reset();
    this.triggerLatencySum.inc(s.triggerLatencySumMs);
    this.triggerLatencyCount.reset();
    this.triggerLatencyCount.inc(s.triggerLatencyCount);

    // HTTP RED（本轮新增）：同一 reset+inc 快照模式。差异只有一处——快照是
    // 稀疏 Map（见 httpSnapshots 注释），因此这里**按观测到的标签组合重建**，
    // 不做「已知组合 inc(0)」的基线铺底：路由模板集合由代码决定、基数有界，
    // 而未观测过的组合本来就不该出现在抓取面上。
    this.renderHttpRed();

    const depth = await this.schedulerService.getQueueDepth();
    // getQueueDepth 在 Redis 不可用时返回全 null：以 autoflow_queue_up=0
    // 表达"队列不可读"，深度 series 置 0 保持集合稳定（抓取方无需处理
    // series 消失）。
    const up = QUEUE_STATES.every((state) => depth[state] !== null);
    this.queueUp.set(up ? 1 : 0);
    for (const state of QUEUE_STATES) {
      this.queueDepth.set({ state }, up ? (depth[state] ?? 0) : 0);
    }

    // OBS-05（容量水位四件套）之 PG 连接池水位 + executor 磁盘水位。
    // 均为 gauge 绝对值 set()（同 BUG-05 runtime gauges 语义，无 reset 需要）。
    this.renderPgPoolWaterLevel();
    await this.renderExecutorDiskWaterLevel();
    // 执行器 fleet 水位（online/total）——同一取数路径，DB 抖动保留旧值。
    await this.renderExecutorFleetGauges();

    return this.registry.metrics();
  }

  /**
   * HTTP RED（本轮新增）：拦截器侧的唯一写入口。
   *
   * 只做内存快照加法，不碰 Registry——render 才是 Registry 的唯一写者
   * （与 scheduler/callback/runtime 三批计数器同一纪律：埋点零成本、抓取时
   * 统一重建，抓取端点关闭时埋点也不产生 prom-client 副作用）。
   *
   * @param method      HTTP 方法（拦截器已归一为大写）
   * @param route       **路由模板**（如 /tasks/:id），未匹配时为 "unmatched"
   * @param statusCode  响应状态码（用于推导 status_class）
   * @param durationMs  请求耗时毫秒
   */
  recordHttpRequest(
    method: string,
    route: string,
    statusCode: number,
    durationMs: number,
  ): void {
    const statusClass = classifyHttpStatus(statusCode);
    const key = JSON.stringify([method, route, statusClass]);
    let snap = this.httpSnapshots.get(key);
    if (!snap) {
      snap = {
        method,
        route,
        statusClass,
        count: 0,
        durationMsSum: 0,
        // 桶数组按 HTTP_DURATION_BUCKETS_MS 的**累计**口径维护（见本方法
        // 下方的桶累加循环），初值全 0。
        buckets: HTTP_DURATION_BUCKETS_MS.map(() => 0),
      };
      this.httpSnapshots.set(key, snap);
    }
    snap.count += 1;
    const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
    snap.durationMsSum += duration;
    // 累计桶：每个 clamped <= bound 的桶 +1（与 scheduler-metrics 的
    // recordTriggerLatency 同一写法）——*_bucket 必须是累积直方图，
    // histogram_quantile 直接消费各 le 的绝对值。
    for (let i = 0; i < HTTP_DURATION_BUCKETS_MS.length; i++) {
      if (duration <= HTTP_DURATION_BUCKETS_MS[i]) snap.buckets[i] += 1;
    }
  }

  /**
   * HTTP RED：快照 → Registry（reset 后按绝对值 inc，counter 单调语义成立）。
   *
   * 全部四个 metric 都先 reset：**重置即清空所有标签组合**（prom-client 的
   * Counter.reset() 把 hashMap 置空），所以「已消失的组合」会随路由下线自然
   * 收口，不会残留旧 series。
   */
  private renderHttpRed(): void {
    this.httpRequestsTotal.reset();
    this.httpRequestDurationMsBuckets.reset();
    this.httpRequestDurationMsSum.reset();
    this.httpRequestDurationMsCount.reset();
    for (const snap of this.httpSnapshots.values()) {
      const labels = {
        method: snap.method,
        route: snap.route,
        status_class: snap.statusClass,
      };
      this.httpRequestsTotal.inc(labels, snap.count);
      this.httpRequestDurationMsSum.inc(labels, snap.durationMsSum);
      this.httpRequestDurationMsCount.inc(labels, snap.count);
      for (let i = 0; i < HTTP_DURATION_BUCKETS_MS.length; i++) {
        this.httpRequestDurationMsBuckets.inc(
          { ...labels, le: String(HTTP_DURATION_BUCKETS_MS[i]) },
          snap.buckets[i],
        );
      }
      // +Inf 桶 = 累计样本数，与中间桶同口径（CORE-06 的既有渲染约定）。
      this.httpRequestDurationMsBuckets.inc(
        { ...labels, le: "+Inf" },
        snap.count,
      );
    }
  }

  /**
   * OBS-05：读取 TypeORM 底层 pg.Pool 的实时连接池水位快照。
   *
   * 取数路径（已在 node_modules 逐层核实）：
   * - Repository.manager → EntityManager.connection（typeorm 0.3.31
   *   `readonly connection: DataSource`，即 app.module forRootAsync 建立的那
   *   条默认连接——forFeature 仓库工厂本就以同一 DataSource token 为注入键）；
   * - DataSource.driver → PostgresDriver（typeorm/driver/postgres），connect()
   *   后 `this.master = await this.createPool(...)` 即 node-pg 池实例；
   * - pg.Pool 实例上 totalCount/idleCount/waitingCount 为实时 number 字段
   *   （node_modules/pg 运行时验证），有效容量在 options.max（PERF-04
   *   extra.max = DB_POOL_SIZE，默认 20；pg 默认 max=10，不读 options 原始
   *   默认以免与真实容量漂移）。
   * 任一环节不可达（未连接 / 驱动类型不符 / 字段缺失）一律返回 null，
   * 渲染侧以 max=0 表达"池句柄不可读"（与 queue_up=0 同姿态），不造数。
   */
  private readPgPoolSnapshot(): PgPoolWaterLevelSnapshot | null {
    const connection = this.executorRepository?.manager?.connection;
    const driver = connection?.driver as PgPoolDriverLike | undefined;
    const pool = driver?.master as PgPoolLike | undefined;
    if (
      !pool ||
      typeof pool.totalCount !== "number" ||
      typeof pool.idleCount !== "number" ||
      typeof pool.waitingCount !== "number"
    ) {
      return null;
    }
    const max = typeof pool.options?.max === "number" ? pool.options.max : null;
    return {
      max,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
      active: Math.max(0, pool.totalCount - pool.idleCount),
    };
  }

  /**
   * OBS-05：PG 连接池水位渲染——gauge 绝对值 set()。池句柄不可达时
   * active/idle/waiting 置 0、max 置 0（抓取方以 max==0 判断可读性，
   * 不参与利用率告警）；可达但驱动未声明 max 时 max 退 0 并在注释
   * 说明（真实部署 PG 驱动必有 options.max）。
   */
  private renderPgPoolWaterLevel(): void {
    const snap = this.readPgPoolSnapshot();
    this.dbPoolActiveConnections.set(snap?.active ?? 0);
    this.dbPoolIdleConnections.set(snap?.idle ?? 0);
    this.dbPoolWaitingRequests.set(snap?.waiting ?? 0);
    this.dbPoolMaxConnections.set(snap?.max ?? 0);
  }

  /**
   * OBS-05：executor 磁盘水位渲染——在线执行器心跳上报的 diskUsage
   * （0-100 百分数）。成功抓取时 reset+set 重建（executor 下线/换址后其
   * series 随之消失，由 Prometheus staleness 收口，gauge 非单调无需保序）；
   * 查询失败（DB 抖动）时保留上一轮值不 reset：水位略陈旧好过整组 series
   * 集体消失误导抓取方。未上报 diskUsage 的旧版执行器（null）不产出
   * series，不强造 0。
   */
  private async renderExecutorDiskWaterLevel(): Promise<void> {
    if (!this.executorRepository) return;
    let rows: Pick<Executor, "address" | "diskUsage">[];
    try {
      rows = await this.executorRepository.find({
        where: { status: ExecutorStatus.ONLINE },
        select: { address: true, diskUsage: true },
      });
    } catch (err) {
      // OBS3-05：保留旧值（见上方注释）**并且**让「本轮取数失败」可见。
      this.logRenderFailure("executor_disk", err);
      return;
    }
    this.executorDiskUsagePercent.reset();
    for (const row of rows) {
      if (typeof row.diskUsage === "number") {
        this.executorDiskUsagePercent.set(
          { executor: row.address },
          row.diskUsage,
        );
      }
    }
  }

  /**
   * 执行器 fleet 水位渲染（本轮新增）：autoflow_executors_online / _total。
   *
   * 取数路径与 renderExecutorDiskWaterLevel 完全一致（同一个 Executor 仓库、
   * 同一次 online 过滤），但这里要的是**两个计数**：
   *   · total  = executors 表全部行（不分状态，`count()` 无 where）；
   *   · online = status === ONLINE 的行数。
   *
   * **DB 抖动必须保留上一轮值**（本方法最重要的一条纪律，也是
   * AllExecutorsOffline 告警可信的前提）：两次查询任一失败就整体 return，
   * 不 reset 也不 set 0。反例代价极高——把「查不到」渲染成 online=0 会让
   * 「全部执行器离线」这条 critical 告警在每次 PG 毛刺时误报，值班人很快就
   * 会把它静音，真正掉线时反而没人看见。宁可水位陈旧（下一轮抓取自愈）。
   *
   * 注：`count()` 两次串行查询而不是一次 GROUP BY——与磁盘水位的
   * find() 同一量级（表行数受执行器部署规模约束，非业务表），换来的是
   * 取数面最小、mock 面最简单（单测直接给 count 队列）。
   */
  private async renderExecutorFleetGauges(): Promise<void> {
    if (!this.executorRepository) return;
    let total: number;
    let online: number;
    try {
      total = await this.executorRepository.count();
      online = await this.executorRepository.count({
        where: { status: ExecutorStatus.ONLINE },
      });
    } catch (err) {
      // 刻意 return（保留旧值）：见上方注释。OBS3-05：同时记计数器 + 限流 warn
      // ——「保留旧值」这个正确权衡此前缺的正是可见性。
      this.logRenderFailure("executor_fleet", err);
      return;
    }
    this.executorsTotal.set(total);
    this.executorsOnline.set(online);
  }

  /**
   * OBS3-05（P2 观测审计）：一次渲染期取数失败 = **计数器 +1 + 限流 warn**。
   *
   * 为什么这两件事必须写在同一个函数里：告警（counter）与排障（日志）若各写
   * 一处，就会出现「计数器涨了但日志说没失败」或反过来的漂移；值班人拿到的
   * 两条证据必须同源。
   *
   * 计数器**不限流**：`autoflow_metrics_render_error_total{query}` 是一次失败
   * 一次 +1 的单调计数（`increase(...[10m]) > 0` 告警的判据），丢掉中间几次
   * 就等于把「失败有多密集」这个最有用的信息抹平。
   *
   * warn **限流**（同一 query 每 `RENDER_FAILURE_LOG_INTERVAL_MS` 最多 1 条）：
   * 长时间 DB 故障期间每次抓取都会进 catch，逐次 warn 会把日志打爆（见
   * RENDER_FAILURE_LOG_INTERVAL_MS 注释）。被限流丢弃的次数由上面的计数器
   * 兜底，所以「安静」不等于「没发生」。
   *
   * 不做 throw / 不改变返回值：本函数的调用方此刻正处于「保留上一轮 gauge 值」
   * 的正确路径上，绝不能让可观测性补丁把 `/api/metrics` 打成 500——那会把
   * 「局部取数失败」升级成「整个抓取目标 down」，恰好是 OBS3-05 要避免的
   * 误判方向。
   */
  private logRenderFailure(
    query: RuntimeMetricsRenderQuery,
    err: unknown,
  ): void {
    // 1) 一等指标：先计数（哪怕 warn 被限流，这一笔也必须落到快照里）。
    recordRuntime("autoflow_metrics_render_error_total", { query });

    // 2) 限流 warn：同一 query 一个窗口内只留第一条。
    const now = Date.now();
    const last = renderFailureLoggedAt.get(query);
    if (last !== undefined && now - last < RENDER_FAILURE_LOG_INTERVAL_MS) {
      return;
    }
    // 防御性上限：key 是固定枚举，正常撞不到；撞到说明有非枚举值混进来，
    // 此时淘汰**最早插入**的一条（Map 保序）而不是让 Map 无界增长。
    if (
      !renderFailureLoggedAt.has(query) &&
      renderFailureLoggedAt.size >= RENDER_FAILURE_LOG_MAX_ENTRIES
    ) {
      const oldest = renderFailureLoggedAt.keys().next().value;
      if (oldest !== undefined) renderFailureLoggedAt.delete(oldest);
    }
    renderFailureLoggedAt.set(query, now);

    this.logger.warn(
      `Metrics render-time query failed: query=${query} ` +
        `(gauge keeps the previous value; see autoflow_metrics_render_error_total): ` +
        `${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err.stack : undefined,
    );
  }
}

/**
 * HTTP RED（本轮新增）：请求耗时直方图的进程内快照行。
 *
 * `buckets` 是**累计**口径（下标与 HTTP_DURATION_BUCKETS_MS 对齐），
 * 与 scheduler-metrics.service.ts 的 triggerLatencyBuckets 同语义。
 */
interface HttpRedSnapshot {
  method: string;
  /** Express 路由模板（/tasks/:id）或 "unmatched" */
  route: string;
  /** "2xx" | "3xx" | "4xx" | "5xx" | "other" */
  statusClass: string;
  count: number;
  durationMsSum: number;
  /** 累计桶计数，长度 = HTTP_DURATION_BUCKETS_MS.length */
  buckets: number[];
}

/**
 * HTTP 状态码 → status_class 标签值。
 *
 * 4xx 与 5xx 必须可区分（错误率告警的判据是 5xx 占比；4xx 是调用方问题，
 * 混在一起会让「有人在扫接口」触发服务端故障告警）。非标准状态码
 * （如响应未写 statusCode 时的 undefined/0）归 "other"，不造 2xx/5xx 假象。
 */
function classifyHttpStatus(statusCode: number): string {
  if (!Number.isFinite(statusCode)) return "other";
  if (statusCode >= 200 && statusCode < 300) return "2xx";
  if (statusCode >= 300 && statusCode < 400) return "3xx";
  if (statusCode >= 400 && statusCode < 500) return "4xx";
  if (statusCode >= 500 && statusCode < 600) return "5xx";
  return "other";
}

/** OBS-05：PG 连接池水位快照（readPgPoolSnapshot 的取数契约） */
interface PgPoolWaterLevelSnapshot {
  /** 有效容量（pg Pool options.max）；驱动未声明时为 null */
  max: number | null;
  active: number;
  idle: number;
  waiting: number;
}

/**
 * OBS-05：取数路径的结构化最小面（不 import pg / typeorm 内部类型，
 * 只依赖运行时字段——mock 驱动对象按此面构造即可驱动测试）。
 * - PgPoolLike：node-pg Pool 的实时计数面（totalCount/idleCount/
 *   waitingCount 为实时数值，options.max 为有效容量）；
 * - PgPoolDriverLike：TypeORM PostgresDriver 的 master 池持有面
 *   （connect() 后挂载 pg.Pool）。
 */
interface PgPoolLike {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  options?: { max?: number };
}

interface PgPoolDriverLike {
  master?: PgPoolLike;
}
