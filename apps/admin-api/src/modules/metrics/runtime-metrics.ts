import { ExecutionStatus } from "../task/entities/task-execution.entity";

/**
 * 可观测性补齐（指标盲区轮）：4 个新增 Prometheus 计数器的纯声明。
 *
 * 与 scheduler / callback-auth 两条既有链路（SchedulerMetricsService /
 * ExecutionCallbackMetricsService → PrometheusMetricsService snapshot→render）
 * 语义一致：进程内单调计数、零新依赖、series 集合稳定（渲染时所有已知标签
 * 显式 inc(0) 保基线，rate() 自首次计数前即可计算）。差异仅在埋点交接：
 * 本组计数器的记录方是 TaskService / NotificationService，而
 * "无任何模块反向依赖 MetricsModule"（见 metrics.module.ts 注释）且本轮
 * 不动各模块 wiring，因此通过 PrometheusMetricsService 的静态 record 入口
 * 交接（构造即安装为当前实例），不引入模块环。
 */

/** autoflow_execution_result_total 的 status 标签全集（回调终态 UPDATE 命中后的最终状态） */
export const RUNTIME_EXECUTION_RESULT_LABELS = [
  ExecutionStatus.SUCCESS,
  ExecutionStatus.FAILED,
  ExecutionStatus.TIMEOUT,
] as const;

/** autoflow_notification_delivery_total 的 channel 标签全集（与 NotificationService.sendToChannels 的渠道名一致） */
export const RUNTIME_NOTIFICATION_CHANNELS = [
  "email",
  "slack",
  "dingtalk",
  "wecom",
  "webhook",
] as const;

/** autoflow_notification_delivery_total 的 result 标签全集 */
export const RUNTIME_NOTIFICATION_RESULTS = ["success", "failure"] as const;

/**
 * autoflow_callback_business_total 的 result 标签全集——与 handleCallback
 * 的返回分类一一对应：
 * - accepted：终态条件 UPDATE 命中（winner，含 SUCCESS/FAILED/TIMEOUT 落库）
 * - duplicate：affected=0（已是终态的重复回调 / 与 worker 收尾竞态），补写日志后按成功上报
 * - not_found：executionId 不存在
 * - address_mismatch[_missing_address]：回调地址与派发地址不符 / 回调缺地址
 * - error：其余 per-item 失败（异常兜底分支，如日志持久化抛错）
 */
export const RUNTIME_CALLBACK_BUSINESS_LABELS = [
  "accepted",
  "duplicate",
  "not_found",
  "address_mismatch",
  "address_mismatch_missing_address",
  "error",
] as const;

export type RuntimeCounterName =
  | "autoflow_execution_result_total"
  | "autoflow_sse_streams_rejected_total"
  | "autoflow_notification_delivery_total"
  | "autoflow_callback_business_total"
  | "autoflow_push_auth_retry_total";

/** 计数器标签集（无标签计数器传空对象） */
export type RuntimeCounterLabels = Readonly<Record<string, string>>;

export interface RuntimeCounterSpec {
  help: string;
  /** 无标签计数器为空数组 */
  labelNames: readonly string[];
  /** 已知标签组合——渲染时全部显式 inc 保 0 值基线（series 集合稳定） */
  labelValueSets: ReadonlyArray<Readonly<Record<string, string>>>;
}

/** 已知渠道 × {success, failure} 的全部组合 */
const notificationLabelValueSets: Array<Record<string, string>> = [];
for (const channel of RUNTIME_NOTIFICATION_CHANNELS) {
  for (const result of RUNTIME_NOTIFICATION_RESULTS) {
    notificationLabelValueSets.push({ channel, result });
  }
}

export const RUNTIME_COUNTERS: Record<RuntimeCounterName, RuntimeCounterSpec> =
  {
    autoflow_execution_result_total: {
      help: "Execution terminal outcomes recorded by callback (unique-winner update only), by final status",
      labelNames: ["status"],
      labelValueSets: RUNTIME_EXECUTION_RESULT_LABELS.map((status) => ({
        status,
      })),
    },
    autoflow_sse_streams_rejected_total: {
      help: "SSE log-stream slot acquisitions rejected by the per-execution / global concurrency limits",
      labelNames: [],
      labelValueSets: [{}],
    },
    autoflow_notification_delivery_total: {
      help: "Notification fan-out deliveries by channel and result (success / failure)",
      labelNames: ["channel", "result"],
      labelValueSets: notificationLabelValueSets,
    },
    autoflow_callback_business_total: {
      help: "Execution callback business outcomes by result (accepted / duplicate / not_found / address_mismatch / error)",
      labelNames: ["result"],
      labelValueSets: RUNTIME_CALLBACK_BUSINESS_LABELS.map((result) => ({
        result,
      })),
    },
    // BUG-01（N51 收口）：reload-config 推送遇 401 后的重签重试可观测性。
    // result 标签区分两条路径：reissued_success（重签后重试 2xx，执行器一个
    // 心跳内自愈的过渡态）与 still_unauthorized（重试后仍 401，执行器顽固
    // 失配，需人工 rotate-token）。埋点在 ExecutorController.reloadConfig，
    // 与本文件其余计数器同走 recordRuntime → render 快照模式。
    autoflow_push_auth_retry_total: {
      help: "Reload-config push 401 re-issue retries by result (reissued_success / still_unauthorized)",
      labelNames: ["result"],
      labelValueSets: [
        { result: "reissued_success" },
        { result: "still_unauthorized" },
      ],
    },
  };

/**
 * BUG-05（SSE 多实例容量可观测）：运行时 Gauge 声明。
 *
 * 与 RUNTIME_COUNTERS 的差异：gauge 是瞬时值（不是单调累计），渲染侧
 * set() 绝对值重建而非 reset+inc。交接通道与计数器相同——
 * runtime-metrics-entry.ts 的模块级注册表（TaskService 埋点、
 * PrometheusMetricsService 渲染，无模块环）。
 * 多实例部署语义：每个实例暴露自己的进程内活跃流数，容量上限 =
 * 实例数 × SSE_MAX_STREAMS_GLOBAL（线性叠加），由抓取方按 instance 聚合。
 */
export type RuntimeGaugeName =
  "autoflow_sse_streams_active" | "autoflow_sse_streams_limit";

export interface RuntimeGaugeSpec {
  help: string;
}

export const RUNTIME_GAUGES: Record<RuntimeGaugeName, RuntimeGaugeSpec> = {
  autoflow_sse_streams_active: {
    help: "Currently active SSE log-stream connections held by this process (TASK-008 slot registry) — stream water level; alert when sum(active)/sum(limit) > 0.8 sustained 10m",
  },
  autoflow_sse_streams_limit: {
    help: "Configured global SSE log-stream concurrency limit of this instance (SSE_MAX_STREAMS_GLOBAL) — denominator of the stream utilization water level",
  },
};
