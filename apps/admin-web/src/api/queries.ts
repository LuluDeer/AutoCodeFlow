/**
 * ARCH-26: TanStack Query 渐进引入 —— 统一缓存/重试/失效策略（第一阶段）。
 *
 * 渐进路线（本文件即路线图事实源）：
 * - 全局默认在 main.tsx 的 QueryClient（staleTime 30s / retry 2 / 关闭窗口
 *   聚焦重取）——所有新页面/改造页 hooks 自动继承，无需逐 hook 重复声明；
 * - 新页面与被改造页统一从本文件取 hooks（薄层：包 queryKey 工厂 + api 层
 *   调用，不复制业务逻辑）；
 * - FEAT-17（第二阶段全站推广）：TaskList/TaskDetail/ExecutorList/
 *   ExecutorDetail/ExecutionDetail 等高频页已迁入；低频设置类页面保留
 *   ahooks useRequest（缩水声明见 FEAT-16+17 交付报告）；
 * - 写操作失效：写后调用 invalidateDashboardQueries / invalidateExecutionsQueries
 *   等本文件导出的失效辅助。
 *
 * queryKey 工厂（queryKeyFactory 模式）：层级常量前缀，避免散落字符串
 * 导致 invalidate 时前后缀对不上。
 */
import { useQuery, type UseQueryResult, type QueryClient } from '@tanstack/react-query';
import { metricsApi, type MetricsSummary, type DailyTrend } from './metrics';
import { tasksApi, type Task, type TaskExecution, type PageResult } from './tasks';
import { executorsApi, type Executor, type ExecutorExecution, type ExecutorMetrics } from './executors';
import { artifactsApi, type ExecutionArtifact } from './artifacts';
import { type ExecutionReportPayload, executionReportsApi } from './execution-reports';
import { taskTemplatesApi, type TaskTemplate } from './task-templates';

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
    /** GET /tasks/:taskId/executions/:execId 单执行详情 */
    detail: (taskId: string, execId: string) =>
      ['executions', 'detail', taskId, execId] as const,
    /** GET /tasks/:taskId/executions 任务维度执行列表（分页） */
    byTask: (taskId: string, params: { page: number; pageSize: number }) =>
      ['executions', 'byTask', taskId, params] as const,
    /** GET /executors/:id/executions 执行器维度执行列表（分页） */
    byExecutor: (executorId: string, params: { page: number; pageSize: number }) =>
      ['executions', 'byExecutor', executorId, params] as const,
    /** GET /tasks/executions/:execId/artifacts 执行产物清单 */
    artifacts: (execId: string) => ['executions', 'artifacts', execId] as const,
    /** GET /tasks/:taskId/executions/:execId/report 执行报告 */
    report: (taskId: string, execId: string) =>
      ['executions', 'report', taskId, execId] as const,
    /** GET /tasks/:taskId/executions 重试链兄弟执行列表 */
    retryChain: (taskId: string) => ['executions', 'retry-chain', taskId] as const,
  },
  scheduler: {
    stats: ['scheduler', 'stats'] as const,
  },
  tasks: {
    all: ['tasks'] as const,
    list: (params: {
      page: number;
      pageSize: number;
      name?: string;
      status?: string;
      triggerType?: string;
    }) => ['tasks', 'list', params] as const,
    detail: (id: string) => ['tasks', 'detail', id] as const,
    stats: (id: string) => ['tasks', 'stats', id] as const,
    /** 分页聚合后的全量任务表（DAG 布局解析用） */
    allForDag: ['tasks', 'list', 'dag-all'] as const,
  },
  executors: {
    all: ['executors'] as const,
    list: ['executors', 'list'] as const,
    detail: (id: string) => ['executors', 'detail', id] as const,
    metrics: (id: string) => ['executors', 'metrics', id] as const,
    groups: ['executors', 'groups'] as const,
  },
  taskTemplates: {
    all: ['task-templates'] as const,
    list: ['task-templates', 'list'] as const,
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

/** GET /tasks/scheduler/stats —— 页头调度器健康 Tag（TaskDetailPage 状态行
 * 同源；30s 轮询语义由 refetchInterval 承担）。 */
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
    refetchInterval: 30_000,
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
    queryFn: ({ signal }) => tasksApi.allExecutions(params, signal),
    // 列表页用户主动翻页/筛选，参数变化即视为新数据——全局 staleTime 足够
  });
}

// ── 写操作失效辅助（写后调用，示范页内消费） ─────────────────────────────

/** 写操作（kill/trigger 等）后失效执行列表 + Dashboard 汇总面。 */
export async function invalidateExecutionData(client: QueryClient): Promise<void> {
  await client.invalidateQueries({ queryKey: queryKeys.executions.all });
  await client.invalidateQueries({ queryKey: queryKeys.metrics.all });
}

// ── FEAT-17：全站推广 hooks（第二阶段：高频页逐页迁入） ─────────────────

// 任务列表/详情面 ─────────────────────────────────────────────────────────

/** GET /tasks 任务列表（分页 + 筛选参数进 queryKey）。 */
export function useTasksList(params: {
  page: number;
  pageSize: number;
  name?: string;
  status?: string;
  triggerType?: string;
}): UseQueryResult<PageResult<Task>> {
  return useQuery({
    queryKey: queryKeys.tasks.list(params),
    queryFn: ({ signal }) => tasksApi.list(params, signal),
  });
}

/** GET /tasks/:id 任务详情（详情页主数据源）。 */
export function useTaskDetail(id: string | undefined): UseQueryResult<Task> {
  return useQuery({
    queryKey: queryKeys.tasks.detail(id ?? ''),
    queryFn: ({ signal }) => tasksApi.get(id!, signal),
    enabled: !!id,
  });
}

/** GET /tasks/:id/stats 任务统计卡（TaskDetailPage 60s 轮询语义由
 * refetchInterval 承担，SSE/写后 invalidate 优先）。 */
export function useTaskStats(id: string | undefined): UseQueryResult<{
  recentExecutions: TaskExecution[];
  successRate: number;
  avgDuration: number;
  totalRuns: number;
}> {
  return useQuery({
    queryKey: queryKeys.tasks.stats(id ?? ''),
    queryFn: ({ signal }) => tasksApi.stats(id!, signal),
    enabled: !!id,
    refetchInterval: 60_000,
  });
}

/** GET /tasks/:id/executions 任务维度执行列表（分页进 queryKey）。 */
export function useTaskExecutions(
  taskId: string | undefined,
  params: { page: number; pageSize: number },
): UseQueryResult<PageResult<TaskExecution>> {
  return useQuery({
    queryKey: queryKeys.executions.byTask(taskId ?? '', params),
    queryFn: ({ signal }) => tasksApi.executions(taskId!, params, signal),
    enabled: !!taskId,
  });
}

/** 分页拉取全量任务表（TaskDependencyGraph 布局解析）。
 * 与分页列表共用 ['tasks','list'] 前缀——任务写操作 invalidate tasks.all
 * 时 DAG 缓存一并失效；每页不超过后端 PaginationDto 的 100 上限。 */
export function useAllTasksForDag(): UseQueryResult<PageResult<Task>> {
  return useQuery({
    queryKey: queryKeys.tasks.allForDag,
    queryFn: ({ signal }) => tasksApi.listAll({}, signal),
    staleTime: 60_000,
  });
}

/** 写操作（create/update/delete/pause/resume/batch/trigger）后失效任务面 +
 * 执行面（trigger 产生新执行，列表/统计联动）。 */
export async function invalidateTaskData(client: QueryClient): Promise<void> {
  await client.invalidateQueries({ queryKey: queryKeys.tasks.all });
  await client.invalidateQueries({ queryKey: queryKeys.executions.all });
}

// 执行器面 ────────────────────────────────────────────────────────────────

/** GET /executors 执行器列表（ExecutorListPage 轮询数据源；SSE 覆盖层在
 * useExecutorLive，写后 invalidate 由批量操作条消费）。 */
export function useExecutorsList(): UseQueryResult<Executor[]> {
  return useQuery({
    queryKey: queryKeys.executors.list,
    queryFn: () => executorsApi.list(),
    refetchInterval: 30_000,
  });
}

/** GET /executors/groups 分组下拉（跨页共享缓存，cacheKey 语义由同 key 合并承担）。 */
export function useExecutorGroups(): UseQueryResult<string[]> {
  return useQuery({
    queryKey: queryKeys.executors.groups,
    queryFn: () => executorsApi.getGroups(),
    staleTime: 5 * 60_000, // 分组变化低频，5 分钟内切页零重复拉取
  });
}

/** GET /executors/:id 执行器详情。 */
export function useExecutorDetail(id: string | undefined): UseQueryResult<Executor> {
  return useQuery({
    queryKey: queryKeys.executors.detail(id ?? ''),
    queryFn: () => executorsApi.get(id!),
    enabled: !!id,
  });
}

/** GET /executors/:id/metrics 30s 资源/统计轮询（refetchInterval 承担原
 * pollingInterval 语义）。 */
export function useExecutorMetrics(
  id: string | undefined,
): UseQueryResult<ExecutorMetrics> {
  return useQuery({
    queryKey: queryKeys.executors.metrics(id ?? ''),
    queryFn: () => executorsApi.getMetrics(id!),
    enabled: !!id,
    refetchInterval: 30_000,
    // 轮询不受 staleTime 节流——refetchInterval 独立于 staleTime 生效
  });
}

/** GET /executors/:id/executions 执行器维度执行列表（分页）。 */
export function useExecutorExecutions(
  executorId: string | undefined,
  params: { page: number; pageSize: number },
): UseQueryResult<{ total: number; items: ExecutorExecution[] }> {
  return useQuery({
    queryKey: queryKeys.executions.byExecutor(executorId ?? '', params),
    queryFn: () => executorsApi.getExecutions(executorId!, params),
    enabled: !!executorId,
  });
}

/** 写操作（update/setOffline/rotate/remove/reloadConfig）后失效执行器面 +
 * 任务面（executor pinning 影响任务派发）。 */
export async function invalidateExecutorData(client: QueryClient): Promise<void> {
  await client.invalidateQueries({ queryKey: queryKeys.executors.all });
  await client.invalidateQueries({ queryKey: queryKeys.tasks.all });
}

// 单执行详情面 ────────────────────────────────────────────────────────────

/** GET /tasks/:taskId/executions/:execId 单执行详情（ExecutionDetailPage 主
 * 数据源；SSE 断流轮询兜底经 refetch 消费）。 */
export function useExecutionDetail(
  taskId: string | undefined,
  execId: string | undefined,
): UseQueryResult<TaskExecution> {
  return useQuery({
    queryKey: queryKeys.executions.detail(taskId ?? '', execId ?? ''),
    queryFn: ({ signal }) => tasksApi.execution(taskId!, execId!, signal),
    enabled: !!taskId && !!execId,
  });
}

/** GET /tasks/executions/:execId/artifacts 执行产物清单（ArtifactsList 自取数
 * 分支；上层传 artifacts prop 时不挂此 hook——enabled 门控在调用侧）。 */
export function useExecutionArtifacts(
  execId: string | undefined,
  enabled: boolean,
): UseQueryResult<ExecutionArtifact[]> {
  return useQuery({
    queryKey: queryKeys.executions.artifacts(execId ?? ''),
    queryFn: ({ signal }) => artifactsApi.listArtifacts(execId!, signal),
    enabled: enabled && !!execId,
  });
}

/** GET /tasks/:taskId/executions 重试链兄弟执行列表。 */
export function useExecutionRetryChain(
  taskId: string | undefined,
): UseQueryResult<PageResult<TaskExecution>> {
  return useQuery({
    queryKey: queryKeys.executions.retryChain(taskId ?? ''),
    queryFn: ({ signal }) =>
      tasksApi.executionsWithStatus(taskId!, { page: 1, pageSize: 100 }, signal),
    enabled: !!taskId,
  });
}

/** GET /tasks/:taskId/executions/:execId/report 执行报告与时间线。 */
export function useExecutionReport(
  taskId: string | undefined,
  execId: string | undefined,
): UseQueryResult<ExecutionReportPayload> {
  return useQuery({
    queryKey: queryKeys.executions.report(taskId ?? '', execId ?? ''),
    queryFn: ({ signal }) => executionReportsApi.report(taskId!, execId!, signal),
    enabled: !!taskId && !!execId,
  });
}

// 任务模板面 ──────────────────────────────────────────────────────────────

/** GET /task-templates 模板列表（TaskTemplatesPage；写后 invalidate）。 */
export function useTaskTemplates(): UseQueryResult<TaskTemplate[]> {
  return useQuery({
    queryKey: queryKeys.taskTemplates.list,
    queryFn: () => taskTemplatesApi.list(),
  });
}
