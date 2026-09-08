/**
 * ARCH-26: TanStack Query 渐进引入 —— 统一缓存/重试/失效策略（第一阶段）。
 *
 * 渐进路线（本文件即路线图事实源）：
 * - 全局默认在 main.tsx 的 QueryClient（staleTime 30s / retry 2 / 关闭窗口
 *   聚焦重取）——所有新页面/改造页 hooks 自动继承，无需逐 hook 重复声明；
 * - 新页面与被改造页统一从本文件取 hooks（薄层：包 queryKey 工厂 + api 层
 *   调用，不复制业务逻辑）；
 * - 其余页面保持 ahooks useRequest 原样（全站 15 文件，禁止本批推翻——
 *   范围纪律见 PLAN-CLAIMS ARCH-26 行）；
 * - 写操作失效：写后调用 invalidateDashboardQueries / invalidateExecutionsQueries
 *   等本文件导出的失效辅助（示范页内做到，全站推广留后续轮）。
 *
 * queryKey 工厂（queryKeyFactory 模式）：层级常量前缀，避免散落字符串
 * 导致 invalidate 时前后缀对不上。
 */
import { useQuery, type UseQueryResult, type QueryClient } from '@tanstack/react-query';
import { metricsApi, type MetricsSummary, type DailyTrend } from './metrics';
import { tasksApi, type TaskExecution } from './tasks';

// ── queryKey 工厂 ────────────────────────────────────────────────────────

export const queryKeys = {
  metrics: {
    all: ['metrics'] as const,
    summary: ['metrics', 'summary'] as const,
    trend: (days: number) => ['metrics', 'trend', days] as const,
    executorStats: ['metrics', 'executors'] as const,
    recentFailures: ['metrics', 'failures'] as const,
    scheduler: ['metrics', 'scheduler'] as const,
  },
  executions: {
    all: ['executions'] as const,
    list: (params: {
      page: number;
      pageSize: number;
      status?: string;
      taskName?: string;
      executorAddress?: string;
      startTime?: string;
      endTime?: string;
    }) => ['executions', 'list', params] as const,
  },
  scheduler: {
    stats: ['scheduler', 'stats'] as const,
  },
} as const;

// ── Dashboard 汇总 hooks（ARCH-26 示范页一：DashboardPage） ───────────────

/** GET /metrics/summary —— Dashboard KPI 四卡数据源。 */
export function useMetricsSummary(): UseQueryResult<MetricsSummary> {
  return useQuery({
    queryKey: queryKeys.metrics.summary,
    queryFn: () => metricsApi.getSummary(),
  });
}

/** GET /metrics/trend?days=N —— 趋势图/sparkline 共用（同 key 合并请求）。 */
export function useMetricsTrend(days: number): UseQueryResult<DailyTrend[]> {
  return useQuery({
    queryKey: queryKeys.metrics.trend(days),
    queryFn: () => metricsApi.getDailyTrend(days),
    // 趋势窗为历史统计，30s 全局 staleTime 之上再加 60s GC 防切换页签丢失
    gcTime: 60_000,
  });
}

/** GET /metrics/executors —— 执行器资源热力条数据源。 */
export function useExecutorStats() {
  return useQuery({
    queryKey: queryKeys.metrics.executorStats,
    queryFn: () => metricsApi.getExecutorStats(),
  });
}

/** GET /metrics/failures —— 失败 Top 榜 + 最近失败两卡共用。 */
export function useRecentFailures() {
  return useQuery({
    queryKey: queryKeys.metrics.recentFailures,
    queryFn: () => metricsApi.getRecentFailures(),
  });
}

/** GET /metrics/scheduler —— 调度延迟卡数据源。 */
export function useSchedulerMetrics() {
  return useQuery({
    queryKey: queryKeys.metrics.scheduler,
    queryFn: () => metricsApi.getSchedulerMetrics(),
  });
}

/** GET /tasks/scheduler/stats —— 页头调度器健康 Tag。 */
export function useSchedulerStats() {
  return useQuery({
    queryKey: queryKeys.scheduler.stats,
    queryFn: () =>
      tasksApi.schedulerStats() as Promise<{
        healthy: boolean;
        activeTimers: number;
        activeCronTasks: number;
        runningTaskCount: number;
        totalScheduledTasks: number;
        uptime: number;
      }>,
  });
}

// ── 执行记录列表 hook（ARCH-26 示范页二：ExecutionsPage） ────────────────

/** GET /tasks/executions 全局执行列表（分页 + 筛选参数进 queryKey）。 */
export function useExecutionsList(params: {
  page: number;
  pageSize: number;
  status?: string;
  taskName?: string;
  executorAddress?: string;
  startTime?: string;
  endTime?: string;
}): UseQueryResult<{ items: TaskExecution[]; total: number }> {
  return useQuery({
    queryKey: queryKeys.executions.list(params),
    queryFn: () => tasksApi.allExecutions(params),
    // 列表页用户主动翻页/筛选，参数变化即视为新数据——全局 staleTime 足够
  });
}

// ── 写操作失效辅助（写后调用，示范页内消费） ─────────────────────────────

/** 写操作（kill/trigger 等）后失效执行列表 + Dashboard 汇总面。 */
export async function invalidateExecutionData(client: QueryClient): Promise<void> {
  await client.invalidateQueries({ queryKey: queryKeys.executions.all });
  await client.invalidateQueries({ queryKey: queryKeys.metrics.all });
}
