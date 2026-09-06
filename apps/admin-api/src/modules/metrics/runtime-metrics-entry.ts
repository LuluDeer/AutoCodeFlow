import {
  RUNTIME_COUNTERS,
  RuntimeCounterLabels,
  RuntimeCounterName,
} from "./runtime-metrics";

/**
 * 运行时计数器（模块级进程内单调计数，可观测性补齐轮）。
 *
 * 埋点方 TaskService / NotificationService 与渲染侧 PrometheusMetricsService
 * 之间刻意不做实例级连接（TaskModule 位于 MetricsModule 依赖链上游，接入
 * DI 会引入模块环——见 metrics.module.ts 的既有约束），但两侧都是 Nest
 * 作用域单例，因此共享的只有本文件的模块级计数表：埋点纯内存自增、渲染侧
 * 每次 render 读快照 reset+inc 重建 series（与 SchedulerMetricsService /
 * ExecutionCallbackMetricsService 的 snapshot→render 语义一致，counter
 * 单调性成立）。
 */
const counters = new Map<RuntimeCounterName, Map<string, number>>();

/** 记录一次运行时计数（纯内存自增，不抛错）。 */
export function recordRuntime(
  name: RuntimeCounterName,
  labels: RuntimeCounterLabels = {},
): void {
  // 未知计数器名（埋点契约外）静默忽略，不影响调用方主流程
  if (!(name in RUNTIME_COUNTERS)) return;
  const byLabel = counters.get(name) ?? new Map<string, number>();
  const key = JSON.stringify(labels);
  byLabel.set(key, (byLabel.get(key) ?? 0) + 1);
  counters.set(name, byLabel);
}

/** 当前快照：计数器名 → (JSON 序列化的标签组合 → 累计值)。渲染侧唯一事实来源。 */
export function getRuntimeCountersSnapshot(): Map<
  RuntimeCounterName,
  Map<string, number>
> {
  return counters;
}

/**
 * 清空全部计数——仅供单元测试隔离（多测试文件共享同一进程时防止跨文件
 * 串扰；生产代码不得调用，单调计数器语义永不重置）。
 */
export function resetRuntimeMetrics(): void {
  counters.clear();
}
