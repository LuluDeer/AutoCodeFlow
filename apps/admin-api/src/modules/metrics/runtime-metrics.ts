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
  | "autoflow_callback_business_total";

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
  };
