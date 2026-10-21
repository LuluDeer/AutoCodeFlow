/**
 * ARCH-26: TanStack Query 渐进引入 —— 统一缓存/重试/失效策略（第一阶段）。
 *
 * 渐进路线（本文件即路线图事实源）：
 * - 全局默认在 main.tsx 的 QueryClient（staleTime 30s / retry 2 / 关闭窗口
 *   聚焦重取）——所有新页面/改造页 hooks 自动继承，无需逐 hook 重复声明；
 * - 新页面与被改造页统一从本文件取 hooks（薄层：包 queryKey 工厂 + api 层
 *   调用，不复制业务逻辑）；
 * - FEAT-17（第二阶段全站推广）：TaskList/TaskDetail/ExecutorList/
 *   ExecutorDetail/ExecutionDetail 等高频页已迁入；低频设置类页面也已迁入
 *   useQuery（NETOPT-E P2-2：设置页 queryFn 全部接 AbortSignal，TanStack v5
 *   默认 cancelOnUnmount 生效——低频页面同样不能有"切页后 in-flight GET
 *   跑到完、失败仍弹 toast"的残留请求）。
 * - 写操作失效：写后调用 invalidateDashboardQueries / invalidateExecutionsQueries
 *   等本文件导出的失效辅助。
 *
 * queryKey 工厂（queryKeyFactory 模式）：层级常量前缀，避免散落字符串
 * 导致 invalidate 时前后缀对不上。
 */
import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult, type QueryClient } from '@tanstack/react-query';
import { getSSEStatus, SSE_STATUS_KEYS } from './sse-client';
import { metricsApi, type MetricsSummary, type DailyTrend } from './metrics';
import { tasksApi, type Task, type TaskExecution, type TaskStats, type PageResult } from './tasks';
import { executorsApi, type Executor, type ExecutorExecution, type ExecutorMetrics, type ExecutorRuntimeConfig } from './executors';
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
      /**
       * keyset 分页游标（可选）。**必须进 queryKey**：游标不同 = 不同的结果页，
       * 若把它排除在外，第 1/2/3 页会共用同一个缓存条目（翻回上一页拿到的是
       * 别的页的数据，且不会有任何报错）。
       *
       * `undefined`（OFFSET 路径）与 `''`（keyset 起点）在 queryKey 序列化里也
       * 是不同的——前者键值为 undefined，后者为空串，不会互相命中。
       */
      cursor?: string;
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
      /**
       * keyset（游标）分页令牌——**必须进 queryKey**。游标不同 = 不同的结果页，
       * 若把它排除在外，第 1/2/3 页会共用同一个缓存条目（翻回上一页拿到的是
       * 别的页的数据，且不会有任何报错）。这是 ExecutionsPage / AuditLogPage
       * 两轮已经踩过一次的同型缺陷，口径逐字对齐它们。
       *
       * `undefined`（OFFSET 路径）与 `''`（keyset 起点）在 queryKey 序列化里
       * 也是不同的值（前者键值为 undefined，后者为空串），不会互相命中，故
       * 这里不需要（也**不许**）做任何归一。
       */
      cursor?: string;
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
    runtimeConfig: ['executors', 'runtime-config'] as const,
  },
  taskTemplates: {
    all: ['task-templates'] as const,
    list: ['task-templates', 'list'] as const,
  },
  // NETOPT-E P3-4: projects 面 queryKey 工厂收口——此前五处内联裸字符串
  // ['projects', ...]（前缀精确无 bug，属漂移风险：写方/读方各自手拼前缀）。
  // NETOPT-F P3: projects.all 已移除——它是死工厂键且是潜伏脚枪：调它会按 v5
  // 前缀语义静默级联刷新 members/candidate-users（读方/写方只用 list/members/
  // candidateUsers 三键，all 无人消费）。日后需级联刷新时显式列出三键。
  projects: {
    list: ['projects', 'list'] as const,
    members: (id: string) => ['projects', 'members', id] as const,
    candidateUsers: ['projects', 'candidate-users'] as const,
  },
} as const;

// ── Dashboard 汇总 hooks（ARCH-26 示范页一：DashboardPage） ───────────────

/**
 * NETOPT-E P3-3 落地（SSE 条件轮询）：「SSE live → 不轮询；断流 → 30s 兜底」
 * 的函数式 refetchInterval 工厂。
 *
 * 判定依据是 api/sse-client.ts 的连接状态注册表（流挂载时由
 * useMetricsStream / useExecutionsStream 按 statusKey 登记，'live' ≙ 连接正常）：
 *  - 流 live：推送本身就是新鲜度来源，30s 轮询是纯空转 → false 停掉；
 *  - 流断线（connecting/reconnecting）：退避重连最长 30s 一跳，期间轮询
 *    自动成为唯一新鲜度来源 → 30_000；
 *  - key 未登记（流未挂载/旧调用方/EventSource 不可用降级）：视为无流可用，
 *    返回 30_000 保持轮询——向后兼容，行为与改动前一致。
 * TanStack 在每次 hook 渲染时重估 refetchInterval，而 SSE 状态变化会经
 * useMetricsStream 等返回值触发页面重渲染，因此断线/恢复能在下一个渲染
 * 周期内生效（无需额外接线）。
 */
export function sseFallbackRefetchInterval(sseKey: string): () => number | false {
  return () => (getSSEStatus(sseKey) === 'live' ? false : 30_000);
}

/** GET /metrics/summary —— Dashboard KPI 四卡数据源。 */
export function useMetricsSummary(): UseQueryResult<MetricsSummary> {
  return useQuery({
    queryKey: queryKeys.metrics.summary,
    queryFn: ({ signal }) => metricsApi.getSummary(signal),
    // NETOPT-E P3-3: SSE 断流且无写操作时 KPI 停在最后一帧——metrics/stream
    // 的 summary 快照与 useMetricsStream 共享缓存，live 时推送即新鲜度来源，
    // 断流时 30s 轮询兜底（与"断线退化为自身请求节奏"的注释对齐）。
    refetchInterval: sseFallbackRefetchInterval(SSE_STATUS_KEYS.metricsStream),
  });
}

/** GET /metrics/trend?days=N —— 趋势图/sparkline 共用（同 key 合并请求）。 */
export function useMetricsTrend(days: number): UseQueryResult<DailyTrend[]> {
  return useQuery({
    queryKey: queryKeys.metrics.trend(days),
    queryFn: ({ signal }) => metricsApi.getDailyTrend(days, signal),
    // 趋势窗为历史统计，30s 全局 staleTime 之上再加 60s GC 防切换页签丢失
    gcTime: 60_000,
    // 恒定 30s 轮询：metrics/stream 快照只含 summary/executors/scheduler，
    // **不含** trend——流 live 与否都与本查询无关，轮询是唯一新鲜度来源，
    // 不能按 SSE 状态停（此前"SSE 断流兜底"的注释是错的，此处如实更正）。
    refetchInterval: 30_000,
  });
}

/** GET /metrics/executors —— 执行器资源热力条数据源。 */
export function useExecutorStats() {
  return useQuery({
    queryKey: queryKeys.metrics.executorStats,
    queryFn: ({ signal }) => metricsApi.getExecutorStats(signal),
    // NETOPT-DEBT: metrics/stream 的 executors 快照实时覆盖（useMetricsStream
    // setQueryData 同 key）——live 停轮询，断流 30s 兜底。
    refetchInterval: sseFallbackRefetchInterval(SSE_STATUS_KEYS.metricsStream),
  });
}

/** GET /metrics/failures —— 失败 Top 榜 + 最近失败两卡共用。 */
export function useRecentFailures() {
  return useQuery({
    queryKey: queryKeys.metrics.recentFailures,
    queryFn: ({ signal }) => metricsApi.getRecentFailures(signal),
    // 恒定 30s 轮询：metrics/stream 快照不含 failures（同 useMetricsTrend），
    // 轮询是唯一新鲜度来源，不能按 SSE 状态停（原"SSE 断流兜底"注释更正）。
    refetchInterval: 30_000,
  });
}

/** GET /metrics/scheduler —— 调度延迟卡数据源。 */
export function useSchedulerMetrics() {
  return useQuery({
    queryKey: queryKeys.metrics.scheduler,
    queryFn: ({ signal }) => metricsApi.getSchedulerMetrics(signal),
    // NETOPT-DEBT: metrics/stream 的 scheduler 快照实时覆盖——live 停轮询，
    // 断流 30s 兜底。
    refetchInterval: sseFallbackRefetchInterval(SSE_STATUS_KEYS.metricsStream),
  });
}

/** GET /tasks/scheduler/stats —— 页头调度器健康 Tag（TaskDetailPage 状态行
 * 同源；30s 轮询语义由 refetchInterval 承担）。 */
export function useSchedulerStats() {
  return useQuery({
    queryKey: queryKeys.scheduler.stats,
    queryFn: ({ signal }) =>
      tasksApi.schedulerStats(signal) as Promise<{
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

/**
 * GET /tasks/executions/all 全局执行列表（分页 + 筛选参数进 queryKey）。
 *
 * `cursor` 三态（见 `tasksApi.allExecutions` 的注释）：`undefined` = 不带该参数
 * （后端走原 OFFSET 路径，响应不含 nextCursor）；`''` = keyset 起点；非空串 =
 * 上一页返回的不透明游标原样回传。这里**原样透传，不做任何归一化**——
 * `cursor ?? ''` 之类会把「不带游标」变成「带空游标」，正好破坏零风险的默认路径。
 */
export function useExecutionsList(params: {
  page: number;
  pageSize: number;
  status?: string;
  taskName?: string;
  executorAddress?: string;
  startTime?: string;
  endTime?: string;
  /** keyset 分页游标（不透明）。缺省 = 走 OFFSET 路径（现有行为，响应无 nextCursor）。 */
  cursor?: string;
}): UseQueryResult<{ items: TaskExecution[]; total: number; nextCursor?: string | null }> {
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
  /**
   * 通用关键字检索（name OR description）——任务列表页搜索框用这个。
   *
   * 与 `name` 的分工：`name` 是**只搜任务名**的向后兼容通道（CLI/MCP 在用），
   * `q` 才是搜索框占位符「搜索任务名、描述」承诺的语义。此前搜索框错发了
   * `name`，于是按描述搜索恒为空且不报错。
   */
  q?: string;
  /** 只按任务名模糊匹配（向后兼容通道，勿用于搜索框）。 */
  name?: string;
  status?: string;
  triggerType?: string;
  /** P2-18：最近一次执行结果筛选（lastStatus），透传 GET /tasks 查询参数。 */
  lastStatus?: string;
  /**
   * keyset（游标）分页令牌——**三态原样透传，不在这里归一**。
   *
   *   · `undefined` → 参数对象里没有这个键，`tasksApi.list` 的
   *     `taskListRequestConfig` 再把键构造掉 → 请求里没有 cursor（OFFSET
   *     路径，现有行为不变）；
   *   · `''` → keyset 起点；
   *   · 非空串 → keyset 中途页。
   *
   * 调用方（TaskListPage）用"三元里展开 `{}` 或 `{ cursor }`"的写法把它传进
   * 来，语义与箭头函数里 `if (cursor)` 归一完全不同——见 ExecutionsPage 的
   * `...(activeCursor === undefined ? {} : { cursor: activeCursor })`。
   */
  cursor?: string;
}): UseQueryResult<PageResult<Task>> {
  return useQuery({
    // cursor 已在 queryKeys.tasks.list 的 params 形状里 → 自动进缓存键。
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
 * refetchInterval 承担，SSE/写后 invalidate 优先）。形状 = TaskStats
 * （FIX-5.1 统计口径收口：successRate/succeeded/failed 全量口径）。 */
export function useTaskStats(id: string | undefined): UseQueryResult<TaskStats> {
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
 * 时 DAG 缓存一并失效；每页不超过后端 PaginationDto 的 100 上限。
 *
 * PERF-02（本轮体验审查）：必须显式带上 `dependencies`。listAll 的默认投影
 * 是 `?fields=id,name`，而 DAG 的边集**只**来自 `t.dependencies`
 * （dag-layout.ts:58，undefined 即 continue）——用默认投影会让边集恒空，
 * 页面永远显示「该任务没有依赖其他任务」，「触发整条链」退化为单任务。
 * 这是 F-10 性能修复引入的静默功能损坏，故在此显式声明所需列。
 */
export function useAllTasksForDag(): UseQueryResult<PageResult<Task>> {
  return useQuery({
    queryKey: queryKeys.tasks.allForDag,
    queryFn: ({ signal }) =>
      tasksApi.listAll({ fields: 'id,name,dependencies' }, signal),
    staleTime: 60_000,
  });
}

/** 写操作（create/update/delete/pause/resume/batch/trigger）后失效任务面 +
 * 执行面（trigger 产生新执行，列表/统计联动）。 */
export async function invalidateTaskData(client: QueryClient): Promise<void> {
  await client.invalidateQueries({ queryKey: queryKeys.tasks.all });
  await client.invalidateQueries({ queryKey: queryKeys.executions.all });
  // NETOPT-10-8: trigger 产生新执行会改变 metrics summary/recentFailures/
  // executors 统计；不失效的话 30s staleTime 窗口内回 Dashboard 直接跳过重取
  // （metrics SSE 只在 Dashboard 挂载时活跃），KPI 最长滞后一个轮询周期。
  await client.invalidateQueries({ queryKey: queryKeys.metrics.all });
}

// ── OPTIMISTIC-01：任务暂停/恢复的乐观更新（**唯一**转换点）──────────────
//
// ## 为什么只有这两个 mutation
//
// 全仓 ~35 个 useMutation，此前 0 个带 onMutate。整批转换是高风险低收益：
// 每个写面的回滚语义不同（创建要撤销临时行、删除要恢复整行、批量要逐项
// 回滚），一次性铺开等于在 35 处同时引入"失败后 UI 与库不一致"的新故障面。
// 本项只挑**语义最干净**的一对：pause/resume 是幂等的状态翻转、只改一个
// 布尔语义字段（status: active ↔ paused）、服务端返回完整 Task 实体可用来
// 校正，且用户对它的延迟最敏感（行内 Switch，点下去必须立刻动）。
//
// ## 与既有 SSE / invalidate 的互操作（关键）
//
// 任务面有两套新鲜度机制，必须确认乐观更新不会和它们打架：
//  ① `useExecutionsStream`（SSE 终态事件）→ 200ms 合并窗后调
//     `invalidateExecutionData`，**只失效 executions + metrics，不碰 tasks**
//     （见该 hook 头注释：终态载荷是 id 级信息，无法精准改写任意筛选下的行集）。
//     因此 SSE 不会覆盖我们乐观写入的 tasks 缓存；
//  ② `invalidateTaskData`（写后失效）→ 失效 tasks.all 前缀（含所有筛选组合
//     的 list 与 detail）。这是 onSettled 的收尾动作：乐观值只是**过渡态**，
//     服务端真相到达后由它统一校正。
//
// 所以顺序必须是：onMutate 先 `cancelQueries(tasks.all)` 掐掉在途 GET
// （否则一个更早发出、更晚返回的 GET 会把乐观值盖回旧 status，用户看到开关
// 弹回去）→ 写乐观值 → onError **按快照精确回滚**（R138-A1：只还原本次写入的
// 那一个任务的 status，不整条缓存倒带——否则会踩掉同页其它任务的在飞乐观值，
// 见 optimisticallySetTaskStatus 的注释）→ onSettled 无条件 invalidate 让服务端
// 校正（**成功也失效**：服务端可能顺带改了 updatedAt/调度器状态）。
//
// ## 只改 status，不动其它字段
//
// 乐观补丁是 `{ ...task, status }`——不用服务端返回值猜测其余字段。列表行
// 里还有 lastTriggerTime / 下次执行时刻等派生展示，它们由 invalidate 后的
// 真实数据刷新；乐观阶段只保证"用户点的那一下立刻有反馈"。

/** 暂停/恢复的乐观目标状态（与后端 TaskStatus 枚举的两个可翻转值对齐） */
export type TaskToggleStatus = 'active' | 'paused';

/** 单条任务行/详情的乐观补丁：只覆盖 status（见上方「只改 status」） */
export function applyTaskStatusPatch<T extends { status: string }>(
  task: T,
  status: TaskToggleStatus,
): T {
  return task.status === status ? task : { ...task, status };
}

/**
 * 对 `PageResult<Task>` 分页缓存应用状态补丁（纯函数，导出可测）。
 *
 * 匹配规则：id 相同才改；未命中返回**原对象**（引用不变，React Query 不会
 * 误判为变更而触发额外渲染）。
 */
export function patchTaskInPage<T extends { id: string; status: string }>(
  page: PageResult<T> | undefined,
  taskId: string,
  status: TaskToggleStatus,
): PageResult<T> | undefined {
  if (!page || !Array.isArray(page.items)) return page;
  let changed = false;
  const items = page.items.map((task) => {
    if (task.id !== taskId) return task;
    const next = applyTaskStatusPatch(task, status);
    if (next !== task) changed = true;
    return next;
  });
  // 未命中 → 原引用（避免无谓的缓存写与重渲染）
  return changed ? { ...page, items } : page;
}

/**
 * 从任意任务缓存形态里读出某个任务的 status（分页信封 `{items}` / 单实体 Task）。
 * 读不到（该行不在这个条目里、形状不认识）→ `undefined`。
 */
function readTaskStatusInEntry(entry: unknown, taskId: string): string | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const items = (entry as { items?: unknown }).items;
  if (Array.isArray(items)) {
    for (const row of items as { id?: string; status?: string }[]) {
      if (row && row.id === taskId) return row.status;
    }
    return undefined;
  }
  const single = entry as { id?: string; status?: string };
  return single.id === taskId ? single.status : undefined;
}

/**
 * 把某个任务的 status 改成 `status`（分页信封 / 单实体两种形态都认）。
 * 未命中或已是目标值 → 返回**原引用**（不制造无谓的缓存写）。
 */
function patchTaskStatusInEntry<T>(entry: T, taskId: string, status: string): T {
  if (!entry || typeof entry !== 'object') return entry;
  if (Array.isArray((entry as { items?: unknown }).items)) {
    return patchTaskInPage(
      entry as unknown as PageResult<{ id: string; status: string }>,
      taskId,
      status as TaskToggleStatus,
    ) as unknown as T;
  }
  if ((entry as { id?: string }).id !== taskId) return entry;
  return applyTaskStatusPatch(
    entry as unknown as { status: string },
    status as TaskToggleStatus,
  ) as unknown as T;
}

/**
 * 乐观写入：把 taskId 的 status 改成 `status`，覆盖 tasks 面的**全部**缓存形态。
 *
 * 覆盖面（缺一个就会出现"列表变了但详情没变"这类割裂）：
 *  · `tasks.list(params)` 的各种筛选组合 —— 遍历 `['tasks','list']` 前缀下
 *    所有已缓存条目逐个打补丁（不做 key 结构假设，page/pageSize/q 任意组合都能命中）；
 *  · `tasks.detail(id)` —— 任务详情页/编辑页读的是它；
 *  · `tasks.allForDag` —— DAG 图节点状态。
 *
 * 返回撤销函数（onError 回滚用）：**只还原本次写入的那一个任务的 status**，
 * 且仅当它当前仍等于我写入的目标值时才还原（见函数内 R138-A1 注释）。
 * 快照只存**被改过的 key 及其原 status**，未命中的缓存不占内存。
 */
export function optimisticallySetTaskStatus(
  client: QueryClient,
  taskId: string,
  status: TaskToggleStatus,
): () => void {
  /**
   * 快照 = `key → 本次写入前该任务的 status`（**不是**整条缓存的原值）。
   *
   * R138-A1（数据层审计）：此前快照存的是整条缓存条目，回滚即
   * `setQueryData(key, prev)` 整条倒回去——在任务列表页这是可复现的互相踩：
   *   · 用户在 1 秒内先后暂停 A、B（同一条分页缓存）：
   *     A 的快照 = {A:active, B:active}，B 的快照 = {A:paused, B:paused}；
   *     A 的请求先失败 → A 回滚整条写回 → **B 还在飞的乐观值被抹掉**，
   *     B 的开关在用户眼前弹回 active（而 B 的请求大概率会成功）；
   *   · 同一窗口内由 refetch/SSE 写进同一条缓存的**无关数据**（别的任务、
   *     同一任务的 updatedAt 等）也会被一起倒回旧值——回滚语义越界。
   *
   * 现在回滚只做两件事：还原**这一个任务**的 status；且只在该任务当前仍等于
   * 我写入的目标值时才还原（有人已经改过 → 新写入优先，交给 onSettled 的
   * 失效去取服务端真相，不做陈旧覆盖）。
   */
  const snapshots = new Map<string, { key: readonly unknown[]; prevStatus: string }>();

  /**
   * 快照去重的键。
   *
   * **不能**用 `key.join()`：list 的 queryKey 第三段是 params **对象**，
   * `join` 会把它变成 `[object Object]`——于是 `{page:1}` 与
   * `{page:2,status:'active'}` 判成同一个键，第二个组合的快照被漏记，
   * 回滚时它停在乐观值上（列表页出现"一半恢复、一半没恢复"）。
   * `JSON.stringify` 对同一 params 对象稳定、对不同 params 可区分。
   */
  const snapshotId = (key: readonly unknown[]) => JSON.stringify(key);

  /** 给某个 key 打乐观补丁；只有**真正改到东西**的条目才记快照 */
  const patchKey = (key: readonly unknown[]): void => {
    const prev = client.getQueryData(key);
    // 没有缓存 / 该任务不在此条目里 / 已经是目标态 → 不写、也不记快照
    const prevStatus = readTaskStatusInEntry(prev, taskId);
    if (prevStatus === undefined || prevStatus === status) return;
    const id = snapshotId(key);
    if (!snapshots.has(id)) snapshots.set(id, { key, prevStatus });
    client.setQueryData(key, patchTaskStatusInEntry(prev, taskId, status));
  };

  // 1) 任务列表：遍历已缓存的 list 条目（不做 key 结构假设）
  const listEntries = client.getQueryCache().findAll({
    queryKey: ['tasks', 'list'],
    exact: false,
  });
  for (const query of listEntries) patchKey(query.queryKey);

  // 2) 任务详情（单实体）
  patchKey(queryKeys.tasks.detail(taskId));

  // 3) DAG 全量表（分页聚合形态，与列表同构；与 1) 的扫描重叠时天然幂等）
  patchKey(queryKeys.tasks.allForDag);

  // 撤销：只还原本次写入的任务 status；期间被别人改过的不覆盖
  return () => {
    for (const { key, prevStatus } of [...snapshots.values()].reverse()) {
      const current = client.getQueryData(key);
      if (current === undefined) continue;
      // 当前值已不是我的乐观值 → 期间有更新的写入（并发 mutation / 重取），
      // 以新写入为准，不由陈旧快照覆盖（服务端真相由 onSettled 失效兜底）。
      if (readTaskStatusInEntry(current, taskId) !== status) continue;
      client.setQueryData(key, patchTaskStatusInEntry(current, taskId, prevStatus));
    }
    snapshots.clear();
  };
}

/** pause/resume 共用的乐观 mutation 配置（两者只有 mutationFn 与目标状态不同） */
function taskToggleMutation(
  client: QueryClient,
  targetStatus: TaskToggleStatus,
  mutationFn: (id: string) => Promise<Task>,
): {
  mutationFn: (id: string) => Promise<Task>;
  onMutate: (id: string) => Promise<() => void>;
  onError: (err: unknown, _id: string, rollback: (() => void) | undefined) => void;
  onSettled: () => Promise<void>;
} {
  return {
    mutationFn,
    /**
     * ① 掐掉在途 GET（关键）：乐观值写入后，一个更早发出、更晚返回的列表
     *    请求会把 status 盖回旧值——用户看到开关自己弹回去，比不做乐观更新
     *    更糟。`cancelQueries` 会中止这些请求，它们不会再写缓存。
     */
    onMutate: async (id: string) => {
      await client.cancelQueries({ queryKey: queryKeys.tasks.all });
      // ② 快照 + 写乐观值（返回的撤销函数即快照）
      const rollback = optimisticallySetTaskStatus(client, id, targetStatus);
      return rollback;
    },
    /** ③ 失败回滚：恢复快照（不 invalidate——回滚本身就是精确还原） */
    onError: (_err: unknown, _id: string, rollback: (() => void) | undefined) => {
      rollback?.();
    },
    /**
     * ④ 无论成败都失效任务面：成功时用服务端真相校正乐观值（服务端可能顺带
     *    改了 updatedAt / 调度器状态），失败时回滚后再拉一次确保一致
     *    （回滚是本地快照，若期间别处也改过，服务端仍是权威）。
     */
    onSettled: () => invalidateTaskData(client),
  };
}

/**
 * OPTIMISTIC-01：暂停任务（行内 Switch / 详情页按钮共用）。
 *
 * 行为：`onMutate` 取消在途 GET → 快照 → 乐观把 status 改成 `paused`；
 * `onError` 回滚；`onSettled` 失效任务面由服务端校正。完整论证见上方
 * OPTIMISTIC-01 段注释（含与 SSE `invalidateExecutionData` 的互操作分析）。
 *
 * 注意 `onSettled` 走 `invalidateTaskData`（tasks + executions + metrics）而
 * 不是只失效 tasks：pause 会停掉调度器计时器，Dashboard 的
 * `scheduler.activeCronTasks` / 任务统计随之变化。
 */
export function usePauseTask(): UseMutationResult<Task, unknown, string, (() => void) | undefined> {
  const client = useQueryClient();
  return useMutation({
    ...taskToggleMutation(client, 'paused', (id: string) => tasksApi.pause(id)),
  });
}

/** OPTIMISTIC-01：恢复任务（与 usePauseTask 完全对称，目标状态 `active`）。 */
export function useResumeTask(): UseMutationResult<Task, unknown, string, (() => void) | undefined> {
  const client = useQueryClient();
  return useMutation({
    ...taskToggleMutation(client, 'active', (id: string) => tasksApi.resume(id)),
  });
}

// 执行器面 ────────────────────────────────────────────────────────────────

/** GET /executors 执行器列表（ExecutorListPage 轮询数据源；SSE 覆盖层在
 * useExecutorLive，写后 invalidate 由批量操作条消费）。 */
export function useExecutorsList(): UseQueryResult<Executor[]> {
  return useQuery({
    queryKey: queryKeys.executors.list,
    queryFn: ({ signal }) => executorsApi.list(signal),
    refetchInterval: 30_000,
  });
}

/** GET /executors/groups 分组下拉（跨页共享缓存，cacheKey 语义由同 key 合并承担）。 */
export function useExecutorGroups(): UseQueryResult<string[]> {
  return useQuery({
    queryKey: queryKeys.executors.groups,
    queryFn: ({ signal }) => executorsApi.getGroups(signal),
    staleTime: 5 * 60_000, // 分组变化低频，5 分钟内切页零重复拉取
  });
}

/**
 * GET /executors/runtime-config —— 后端**有效**判活阈值（P2-5）。
 *
 * 为什么需要：后端 markStaleOffline() 用 heartbeatInterval × multiplier
 * （默认 30s × 3 = 90s）把 ONLINE 判成 OFFLINE，而前端此前各自硬编码 2/5 分钟，
 * 于是后端判死后最长约 3.5 分钟里 UI 仍把心跳画成绿色「刚刚」。取后端值后两侧
 * 同源；配置被调大时也自动跟随，不再需要改前端。
 *
 * 失败**不抛**、不阻塞页面：回退 `HEARTBEAT_TIMEOUT_FALLBACK_MS`（= 后端默认
 * 90s）。该回退是**保守**方向——若实际阈值被调大，UI 只是提前标黄，绝不会把
 * 真正离线的节点涂成绿色。`staleTime` 取 5 分钟：这是运维配置项，不是实时指标。
 */
export function useExecutorRuntimeConfig(): UseQueryResult<ExecutorRuntimeConfig> {
  return useQuery({
    queryKey: queryKeys.executors.runtimeConfig,
    queryFn: ({ signal }) => executorsApi.getRuntimeConfig(signal),
    staleTime: 5 * 60_000,
  });
}

/**
 * GET /executors/:id 执行器详情。
 *
 * P1-23（UX-AUDIT-2026-09-21）：**必须轮询**，否则页面状态是冻结快照。
 *
 * 此前本查询没有 refetchInterval（紧挨着的 useExecutorMetrics 有），于是
 * `status`/`lastHeartbeat` 只来自进入页面那一次拉取：
 *   · 节点刚死 → 页面可以永远显示"在线"；
 *   · 节点已恢复 → 页面永远显示"离线"，心跳 tooltip 也冻在旧时刻。
 * 而用户打开详情页**恰恰是为了诊断这台执行器**，读到的可能是几小时前的状态；
 * 页面右下角还同时渲染着「每 30s 轮询」的文案，与实际行为相反。
 *
 * 30s 与 metrics 同频（也是后端心跳间隔），保证同一屏内两个数据源不互相矛盾。
 */
export function useExecutorDetail(id: string | undefined): UseQueryResult<Executor> {
  return useQuery({
    queryKey: queryKeys.executors.detail(id ?? ''),
    queryFn: ({ signal }) => executorsApi.get(id!, signal),
    enabled: !!id,
    // P1-23：必须轮询（理由见上方注释）——30s 与 metrics 同频
    refetchInterval: 30_000,
  });
}

/** GET /executors/:id/metrics 30s 资源/统计轮询（refetchInterval 承担原
 * pollingInterval 语义）。 */
export function useExecutorMetrics(
  id: string | undefined,
): UseQueryResult<ExecutorMetrics> {
  return useQuery({
    queryKey: queryKeys.executors.metrics(id ?? ''),
    queryFn: ({ signal }) => executorsApi.getMetrics(id!, signal),
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
    queryFn: ({ signal }) => executorsApi.getExecutions(executorId!, params, signal),
    enabled: !!executorId,
  });
}

/** 写操作（update/setOffline/rotate/remove/reloadConfig）后失效执行器面 +
 * 汇总面（NETOPT-C P3：executor 状态/容量变化同时影响 metrics 汇总与
 * Dashboard KPI）。
 * NETOPT-D P3-4: 移除 tasks.all——删除/下线执行器不改任务定义，失效任务列表
 * 只会白白触发任务页重取；任务写操作由 invalidateTaskData 单独覆盖。 */
export async function invalidateExecutorData(client: QueryClient): Promise<void> {
  await client.invalidateQueries({ queryKey: queryKeys.executors.all });
  await client.invalidateQueries({ queryKey: queryKeys.metrics.all });
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
    // F-29（DEEP_REVIEW 0ef3bbe）：原调用 tasksApi.executionsWithStatus（与 executions
    // 逐字节重复），统一改用 executions 传 status/page/pageSize。
    queryFn: ({ signal }) =>
      tasksApi.executions(taskId!, { page: 1, pageSize: 100 }, signal),
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

/** GET /task-templates 模板列表（TaskTemplatesPage；写后 invalidate）。
 *  NETOPT-C P3: 补 AbortSignal——翻页/卸载时 in-flight 请求可被取消。 */
export function useTaskTemplates(): UseQueryResult<TaskTemplate[]> {
  return useQuery({
    queryKey: queryKeys.taskTemplates.list,
    queryFn: ({ signal }) => taskTemplatesApi.list(signal),
  });
}
