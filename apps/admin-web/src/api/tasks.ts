import { client } from './client';
// PK-02（DEEP_REVIEW 0ef3bbe）: 改用生成的 DTO 类型，删除 Partial<Task> hack。
import type { components } from '../types/generated/api-types';

/**
 * FEAT-06: 任务级维护窗口条目（tasks.maintenanceWindows jsonb）。
 * start/end 均为 5 字段 cron：start 最近触达开窗、end 最近触达关窗
 * （半开区间 [start, end)，跨午夜按最近触达自然成立）。
 * 命中窗口时调度计划触发被跳过（计入 scheduler metrics 的
 * triggersSkippedMaintenance）；手动/API 触发不受窗口约束。
 */
export interface MaintenanceWindow {
  start: string;
  end: string;
  description?: string;
}

/**
 * CORE-04: 超时后动作（tasks.timeoutAction 可空 varchar，与后端
 * admin-api task/timeout-policy.util.ts 的 TimeoutAction 值域对齐）。
 *  - kill（缺省/null）：执行器到时树杀进程树（既有行为）；
 *  - kill_retry：同样树杀，admin 侧按任务重试预算 re-enqueue 一次；
 *  - notify_only：admin 不额外下发终止指令、只保证超时告警——执行器
 *    自身硬超时仍在，进程仍会被执行器杀掉（notify_only ≠ 不超时）。
 */
export type TimeoutAction = 'kill' | 'kill_retry' | 'notify_only';

/**
 * 批量任务操作的单项结果。后端把每项失败吸收进 payload
 * （`{ id, error }`），整体仍回 200——所以调用方**必须**检查 error，
 * 不能只看 HTTP 状态。成功项只有 id。
 */
export interface BatchItemResult {
  id: string;
  error?: string;
}

/** 批量结果汇总，供 UI 如实呈现「N 成功 / M 失败」。 */
export interface BatchOutcome {
  succeeded: number;
  failed: number;
  /** 失败项的 id → 原因（最多保留前 3 条用于提示，避免 toast 过长）。 */
  failures: Array<{ id: string; error: string }>;
}

export function summarizeBatch(results: BatchItemResult[] | undefined | null): BatchOutcome {
  const list = Array.isArray(results) ? results : [];
  const failures = list
    .filter((r) => r && r.error)
    .map((r) => ({ id: r.id, error: String(r.error) }));
  return {
    succeeded: list.length - failures.length,
    failed: failures.length,
    failures: failures.slice(0, 3),
  };
}

// F-29（DEEP_REVIEW 0ef3bbe）：原此处的 TIMEOUT_ACTION_OPTIONS（中文 label 硬编码）已删除——
// UI 实际消费的是 pages/timeout-policy.ts 的同名导出（TaskFormPage.tsx:46 引自该模块），
// api 层这份 label 无任何消费方，属重复死代码。

export interface Task {
  id: string;
  name: string;
  description?: string;
  runtime: string;
  entrypoint: string;
  /**
   * W-21: 依赖声明（后端 tasks.requirements jsonb）。python runtime 任务由
   * executor-python 装进 per-task uv venv；node runtime 由 executor-node 安装。
   * 仅 entrypoint 任务有意义，glue 脚本任务在执行器侧被清零。
   */
  requirements?: string[] | null;
  /**
   * TASK-PROJ-01: 归属项目。后端 tasks.projectId 列一直存在（迁移
   * 1790000000008）且详情读面原样回传，只是此前 DTO 未接、前端类型也未声明，
   * 于是"项目隔离"对所有新任务都塌缩到默认项目视图。
   * null = 显式未分配（读面归入默认项目视图）。
   */
  projectId?: string | null;
  status: string;
  triggerType: string;
  fixedRate?: number;
  cronExpression?: string;
  timezone?: string | null;
  params?: Record<string, string | number | boolean>;
  /** CORE-01：DTO 收数字 1-4，PG enum 读回 label 字符串——双形态，见 utils/priority */
  priority?: string | number;
  maxRetry: number;
  retryDelay?: number;
  retryableErrors?: string[];
  timeout: number;
  timeoutSeconds?: number;
  /**
   * 任务级失败告警配置。两列是任务失败通知的**唯一**来源——
   * `notification.service.notifyFailureWithConfig(..., task.alarmEmail,
   * task.alarmChannels, ...)` 直接读 task 实体的这两列（后端
   * execution-events.listener.ts 回查 task 后透传）。
   *
   * 此前本读模型**没有声明这两个字段**，于是 TaskFormPage 编辑态无法回填
   * （`task.alarmEmail` 在类型层面就是 undefined），打开已有任务的编辑页时
   * 告警区恒为空态；用户改个无关字段再保存就会把已配好的告警清掉。声明它们
   * 是回填修复的前提（类型层不声明 = 该字段在读面不存在）。
   */
  alarmEmail?: string | null;
  alarmChannels?: string[] | null;
  /** CORE-04: 超时动作（null/缺省 = kill）；表单提交 undefined = 保留旧值 */
  timeoutAction?: TimeoutAction | null;
  /** CORE-04: 超时预警阈值（timeout 的百分数 0-90；null = 未启用） */
  timeoutWarnRatio?: number | null;
  applicationId?: string | null;
  executeMode?: string | null;
  executorAppName?: string | null;
  // R6/R7: 任务级 executor pinning——非空时 dispatch 只派给该执行器（uuid），
  // 与 executeMode=broadcast 互斥。admin-web 表单需感知并回写该字段（N19）。
  executorId?: string | null;
  executorGroup?: string | null;
  executorTags?: string[] | null;
  /** NF-04: soft routing affinity; any matching executor tag is eligible. */
  executorAffinityTags?: string[] | null;
  /** NF-04: exclude executors carrying any of these tags. */
  executorAntiAffinityTags?: string[] | null;
  dependencies?: Record<string, string> | null;
  /** FEAT-06: 维护窗口（null/[] = 未配置；表单未填写时提交 null 以清空） */
  maintenanceWindows?: MaintenanceWindow[] | null;
  /** FEAT-11: markdown 运行手册——失败排障知识，详情页展示并随失败通知附链接 */
  runbook?: string | null;
  gitRepo?: string | null;
  gitBranch?: string | null;
  gitCommit?: string | null;
  glueSource?: string | null;
  glueLanguage?: string | null;
  /**
   * python_task_multiversion（FR-06）：任务声明的 Python **主.次**版本
   * （如 "3.7" / "3.12"；null = 不声明，走执行器宿主默认解释器）。
   *
   * 为什么手写而非取自 generated：admin-api 的 **响应** 里没有 `Task` schema
   * （实测 openapi.json 602 个 schema 中只有 CreateTaskDto/UpdateTaskDto/
   * TriggerTaskDto 等请求体，没有读模型 Task），因此本接口是**读模型的唯一
   * 事实源**，必须自己声明。请勿因"api-types 里已经有了"而删除——那指的是
   * **请求 DTO**（components["schemas"]["CreateTaskDto"]），与本读模型无关。
   */
  runtimeVersion?: string | null;
  /**
   * python_task_multiversion（FR-18）：代码来源渠道三选一。
   * null = 未声明（存量语义：按 gitRepo/glueSource/applicationId 谁非空隐式推断）。
   * 同上：读模型手写字段，不可删。
   */
  codeSource?: 'git' | 'glue' | 'application_zip' | null;
  createdAt: string;
  updatedAt: string;
}

// 与后端 ExecutionStatus 枚举对齐（apps/admin-api/src/modules/task/entities/task-execution.entity.ts），
// 含 'killed' 手动终止终态。
export type TaskExecutionStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'timeout'
  | 'killed'
  | 'cancelled';

export interface TaskExecution {
  id: string;
  taskId: string;
  taskName: string;
  status: TaskExecutionStatus;
  triggerType: string;
  executorAddress?: string | null;
  startTime?: string;
  endTime?: string;
  duration?: number;
  params?: Record<string, unknown> | null;
  logs?: string;
  errorMessage?: string;
  failureReason?: string | null;
  /** 非零/非空退出码（后端终态回调入库；null=旧数据未采集） */
  exitCode?: number | null;
  aiAnalysis?: string;
  retryCount?: number;
  taskVersion?: string | null;
  /** OBS-01: W3C trace-id（admin OTEL_ENABLED=true 时落库；null=未追踪） */
  traceId?: string | null;
  /**
   * 执行结果 jsonb 自由列（后端 task_executions.result）。python_task_multiversion
   * 起，失败执行会写入结构化解释器留痕 `{ interpreter: {requested, resolved,
   * reason, detail, pool} }`（CONTRACT §3.3）。
   *
   * 类型刻意保持 `unknown` 而非结构化接口：该列**无 schema 约束**，且历史执行
   * 记录里可能是 null/{}/旧结构/被人工订正过的脏值。结构化读取与逐层判类型由
   * pages/interpreter-context.ts 的 extractInterpreterContext 独占负责（防御式），
   * 页面只消费它的归一结果——这样"多一层形状认知"不会散落到调用点。
   * 后端 DTO 可能尚未回传该列：整个字段可缺省，消费方必须容忍 undefined。
   */
  result?: unknown;
  createdAt: string;
}

export interface TaskVersion {
  id: string;
  taskId: string;
  version: string;
  gitCommit?: string | null;
  snapshot: Record<string, unknown>;
  createdBy?: string | null;
  description?: string | null;
  createdAt: string;
}

export interface VersionDiff {
  [key: string]: { old: unknown; new: unknown };
}

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages?: number;
}

export type TaskListParams = {
  page?: number;
  pageSize?: number;
  name?: string;
  status?: string;
  triggerType?: string;
  runtime?: string;
  applicationId?: string;
  /** F-10: 逗号分隔的投影字段白名单（如 'id,name'）。 */
  fields?: string;
};

/** GET /tasks 的后端 pageSize 上限（PaginationDto.@Max(100)）。 */
export const TASK_LIST_PAGE_SIZE = 100;

/**
 * R-10/F-10（DEEP_REVIEW 0ef3bbe）: listAll 分页并发度。从 6 降到 3——
 * 千级任务时 6 并发 = 请求风暴；3 并发在 DAG/依赖下拉场景下仍可接受，
 * 且配合 React Query staleTime=60s 会话内只拉一次。后续如后端增加
 * 轻量端点 ?fields=id,name 可进一步降本。
 */
export const TASK_LIST_PAGE_CONCURRENCY = 3;

/**
 * A task list of ten million records is already beyond what this page is able
 * to render/use. This cap is only a malformed-total guard; it does not reduce
 * the API's page size or affect normal large lists.
 */
export const TASK_LIST_MAX_PAGES = 100_000;

/**
 * U2: GET /tasks/:id/executions/:execId/logs 响应形状
 * （task.service.ts getExecutionLogs：按行分页，limit 后端上限 2000）。
 */
export interface ExecutionLogsPage {
  lines: string[];
  totalLines: number;
  hasMore: boolean;
}

function taskListRequestConfig(params: TaskListParams | undefined, signal?: AbortSignal) {
  return signal ? { params, signal } : { params };
}

function invalidTaskListResponse(reason: string): Error {
  return new Error(`任务列表分页响应无效：${reason}`);
}

function throwIfTaskListAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new Error('任务列表请求已取消');
}

function validateTaskListPage(
  result: PageResult<Task>,
  expectedPage: number,
  expectedTotal: number,
  expectedTotalPages: number,
): void {
  if (!result || !Array.isArray(result.items)) {
    throw invalidTaskListResponse(`第 ${expectedPage} 页缺少 items`);
  }
  if (result.page !== expectedPage) {
    throw invalidTaskListResponse(
      `请求第 ${expectedPage} 页却返回第 ${String(result.page)} 页`,
    );
  }
  if (result.pageSize !== TASK_LIST_PAGE_SIZE) {
    throw invalidTaskListResponse(
      `第 ${expectedPage} 页 pageSize=${String(result.pageSize)}，应为 ${TASK_LIST_PAGE_SIZE}`,
    );
  }
  if (result.total !== expectedTotal) {
    throw invalidTaskListResponse(
      `第 ${expectedPage} 页 total=${String(result.total)}，首请求 total=${expectedTotal}`,
    );
  }
  if (result.totalPages !== undefined && result.totalPages !== expectedTotalPages) {
    throw invalidTaskListResponse(
      `第 ${expectedPage} 页 totalPages=${String(result.totalPages)}，应为 ${expectedTotalPages}`,
    );
  }
  if (result.items.length > TASK_LIST_PAGE_SIZE) {
    throw invalidTaskListResponse(
      `第 ${expectedPage} 页返回 ${result.items.length} 条，超过 pageSize 上限`,
    );
  }
}

/**
 * Fetch the complete task list without exceeding the backend page-size cap.
 * Every response is checked before aggregation so a changing or malformed
 * paginated response cannot silently produce a partial task list.
 */
async function listAllTasks(
  params: Omit<TaskListParams, 'page' | 'pageSize'> = {},
  signal?: AbortSignal,
): Promise<PageResult<Task>> {
  throwIfTaskListAborted(signal);
  // F-10（DEEP_REVIEW 0ef3bbe）: 依赖下拉/DAG 等轻量消费方只需 id+name——
  // 默认注入 ?fields=id,name 走后端投影白名单，跳过 params/secrets/glueSource
  // 等重量列。调用方可显式传 params.fields 覆盖（如需更多列）。
  //
  // PERF-02（本轮体验审查）: 这里的 `{ fields: 'id,name', ...params }` 本意是
  // 「调用方可覆盖」，但 TaskDependencyGraph 的消费方**没有**传 fields，于是
  // 投影把 `dependencies` 一并裁掉——而 dag-layout.ts:58 的边集完全依赖该
  // 字段，undefined 直接 `continue`，导致图边恒为空、永远渲染「该任务没有
  // 依赖其他任务」。这是 F-10 性能修复引入的**静默功能损坏**：单元测试 mock
  // 掉了 tasksApi.listAll 并自行造 dependencies 字段，绕过了 API 层，所以全绿。
  //
  // 修法：默认投影保持 'id,name'（F-10 的收益不变），DAG 消费方显式传
  // `fields: 'id,name,dependencies'`——见 useAllTasksForDag。
  const paramsWithProjection = { fields: 'id,name', ...params };
  const first = await tasksApi.list(
    { ...paramsWithProjection, page: 1, pageSize: TASK_LIST_PAGE_SIZE },
    signal,
  );
  throwIfTaskListAborted(signal);
  if (!Number.isInteger(first.total) || first.total < 0) {
    throw invalidTaskListResponse(`首请求 total=${String(first.total)} 无效`);
  }
  const expectedTotalPages = Math.ceil(first.total / TASK_LIST_PAGE_SIZE);
  if (expectedTotalPages > TASK_LIST_MAX_PAGES) {
    throw invalidTaskListResponse(
      `total=${first.total} 需要 ${expectedTotalPages} 页，超过安全上限 ${TASK_LIST_MAX_PAGES}`,
    );
  }
  if (
    first.totalPages !== undefined &&
    (!Number.isInteger(first.totalPages) || first.totalPages !== expectedTotalPages)
  ) {
    throw invalidTaskListResponse(
      `total=${first.total} 应有 ${expectedTotalPages} 页，但返回 totalPages=${String(first.totalPages)}`,
    );
  }
  validateTaskListPage(first, 1, first.total, expectedTotalPages);

  if (expectedTotalPages === 0) {
    if (first.items.length !== 0) {
      throw invalidTaskListResponse('total=0 但首请求仍返回任务');
    }
    return { ...first, items: [], page: 1, pageSize: TASK_LIST_PAGE_SIZE, totalPages: 0 };
  }

  const pages: PageResult<Task>[] = [];
  let nextPage = 2;
  while (nextPage <= expectedTotalPages) {
    throwIfTaskListAborted(signal);
    const batchPages = Array.from(
      { length: Math.min(TASK_LIST_PAGE_CONCURRENCY, expectedTotalPages - nextPage + 1) },
      (_, index) => nextPage + index,
    );
    const batch = await Promise.all(
      batchPages.map((page) => {
        throwIfTaskListAborted(signal);
        return tasksApi.list(
          {
            ...paramsWithProjection,
            page,
            pageSize: TASK_LIST_PAGE_SIZE,
          },
          signal,
        );
      }),
    );
    throwIfTaskListAborted(signal);
    pages.push(...batch);
    nextPage += batchPages.length;
  }
  const allPages = [first, ...pages];
  allPages.slice(1).forEach((page, index) => {
    const expectedPage = index + 2;
    validateTaskListPage(page, expectedPage, first.total, expectedTotalPages);
  });

  const expectedItemsOnPage = (page: number) =>
    page < expectedTotalPages
      ? TASK_LIST_PAGE_SIZE
      : first.total - TASK_LIST_PAGE_SIZE * (expectedTotalPages - 1);
  allPages.forEach((page, index) => {
    const expectedPage = index + 1;
    if (page.items.length !== expectedItemsOnPage(expectedPage)) {
      throw invalidTaskListResponse(
        `第 ${expectedPage} 页应有 ${expectedItemsOnPage(expectedPage)} 条，实际 ${page.items.length} 条，拒绝返回部分结果`,
      );
    }
  });

  const items = allPages.flatMap((page) => page.items);
  const ids = new Set<string>();
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || item.id.length === 0) {
      throw invalidTaskListResponse('任务缺少有效 id，无法校验重复或缺页');
    }
    if (ids.has(item.id)) {
      throw invalidTaskListResponse(`任务 ${item.id} 在多个分页中重复出现`);
    }
    ids.add(item.id);
  }
  if (items.length !== first.total) {
    throw invalidTaskListResponse(
      `应返回 ${first.total} 条任务，实际聚合 ${items.length} 条，拒绝返回部分结果`,
    );
  }

  return {
    ...first,
    items,
    page: 1,
    pageSize: TASK_LIST_PAGE_SIZE,
    totalPages: expectedTotalPages,
  };
}

export const tasksApi = {
  list: (params?: TaskListParams, signal?: AbortSignal) =>
    client.get('/tasks', taskListRequestConfig(params, signal)) as Promise<PageResult<Task>>,
  listAll: listAllTasks,
  get: (id: string, signal?: AbortSignal) =>
    signal
      ? client.get(`/tasks/${id}`, { signal }) as Promise<Task>
      : client.get(`/tasks/${id}`) as Promise<Task>,
  create: (data: components["schemas"]["CreateTaskDto"]) =>
    client.post('/tasks', data) as Promise<Task>,
  update: (id: string, data: components["schemas"]["UpdateTaskDto"]) =>
    client.patch(`/tasks/${id}`, data) as Promise<Task>,
  delete: (id: string) => client.delete(`/tasks/${id}`),
  trigger: (id: string, params?: Record<string, unknown>) =>
    client.post(`/tasks/${id}/trigger`, { params }),
  executions: (
    id: string,
    p?: { page?: number; pageSize?: number; status?: string },
    signal?: AbortSignal,
  ) =>
    signal
      ? client.get(`/tasks/${id}/executions`, { params: p, signal }) as Promise<PageResult<TaskExecution>>
      : client.get(`/tasks/${id}/executions`, { params: p }) as Promise<PageResult<TaskExecution>>,
  // F-29（DEEP_REVIEW 0ef3bbe）：原 executionsWithStatus 与上方 executions 逐字节相同
  // （同 GET /tasks/:id/executions），已删除；唯一调用方 queries.ts useExecutionRetryChain
  // 改用 executions 传 status/page/pageSize。
  execution: (taskId: string, execId: string, signal?: AbortSignal) =>
    signal
      ? client.get(`/tasks/${taskId}/executions/${execId}`, { signal }) as Promise<TaskExecution>
      : client.get(`/tasks/${taskId}/executions/${execId}`) as Promise<TaskExecution>,
  rollback: (id: string, gitCommit: string, params?: Record<string, unknown>) =>
    client.post(`/tasks/${id}/rollback`, { gitCommit, params }),
  rollbackToVersion: (taskId: string, versionId: string) =>
    client.post(`/tasks/${taskId}/versions/${versionId}/rollback`) as Promise<Task>,
  compareVersions: (taskId: string, versionId1: string, versionId2: string) =>
    client.get(`/tasks/${taskId}/versions/${versionId1}/compare/${versionId2}`) as Promise<VersionDiff>,
  versions: (id: string) =>
    client.get(`/tasks/${id}/versions`) as Promise<TaskVersion[]>,
  // 后端 pause/resume 返回保存后的 Task 实体（task.service.ts），并非 {success,message} 包装
  pause: (id: string) =>
    client.post(`/tasks/${id}/pause`) as Promise<Task>,
  resume: (id: string) =>
    client.post(`/tasks/${id}/resume`) as Promise<Task>,
  // 批量端点**不是**全成功/全失败语义：后端 task.controller.ts 用
  // Promise.all(...catch(err => ({ id, error: err.message }))) 把每项失败
  // 吸收进 payload，整体仍返回 HTTP 200（见 batch/trigger、pause、resume、
  // delete 四处）。因此返回类型必须暴露 per-item error，调用方才能区分
  // 「20 项全成」与「20 项里 7 项被拒」。此前声明为隐式 void，UI 无条件弹
  // 成功提示，属静默的部分失败。
  batchTrigger: (taskIds: string[]) =>
    client.post('/tasks/batch/trigger', { taskIds }) as Promise<BatchItemResult[]>,
  batchPause: (taskIds: string[]) =>
    client.post('/tasks/batch/pause', { taskIds }) as Promise<BatchItemResult[]>,
  batchResume: (taskIds: string[]) =>
    client.post('/tasks/batch/resume', { taskIds }) as Promise<BatchItemResult[]>,
  batchDelete: (taskIds: string[]) =>
    client.post('/tasks/batch/delete', { taskIds }) as Promise<BatchItemResult[]>,
  stats: (id: string, signal?: AbortSignal) =>
    signal
      ? client.get(`/tasks/${id}/stats`, { signal }) as Promise<{ recentExecutions: TaskExecution[]; successRate: number; avgDuration: number; totalRuns: number }>
      : client.get(`/tasks/${id}/stats`) as Promise<{ recentExecutions: TaskExecution[]; successRate: number; avgDuration: number; totalRuns: number }>,
  updateGlue: (id: string, source: string, language?: string) =>
    client.put(`/tasks/${id}/glue`, { source, language }),
  allExecutions: (
    params?: { page?: number; pageSize?: number; status?: string; taskId?: string; taskName?: string; startTime?: string; endTime?: string; executorAddress?: string },
    signal?: AbortSignal,
  ) =>
    signal
      ? client.get('/tasks/executions/all', { params, signal }) as Promise<PageResult<TaskExecution>>
      : client.get('/tasks/executions/all', { params }) as Promise<PageResult<TaskExecution>>,
  killExecution: (taskId: string, execId: string) =>
    client.post(`/tasks/${taskId}/executions/${execId}/kill`) as Promise<{ success: boolean; message: string }>,
  analyzeExecution: (taskId: string, execId: string) =>
    client.post(`/tasks/${taskId}/executions/${execId}/analyze`) as Promise<{ aiAnalysis: string }>,
  /** U2: 分页拉取持久化日志行（截断兜底"加载完整日志"用），limit 后端上限 2000。
   * OBS-03: level（ERROR/WARN/INFO/DEBUG）为服务端过滤——过滤模式下 fromLine
   * 语义是"过滤后序列的偏移量"（后端 skip/OFFSET，行号游标失效），totalLines
   * 为过滤后计数，客户端翻页循环契约不变（offset += lines.length）。 */
  executionLogs: (
    taskId: string,
    execId: string,
    params?: { fromLine?: number; limit?: number; level?: string },
  ) =>
    client.get(`/tasks/${taskId}/executions/${execId}/logs`, { params }) as Promise<ExecutionLogsPage>,
  schedulerStats: (signal?: AbortSignal) =>
    signal
      ? client.get('/tasks/scheduler/stats', { signal }) as Promise<{ healthy: boolean; activeTimers: number; activeCronTasks: number; runningTaskCount: number; totalScheduledTasks: number; uptime: number }>
      : client.get('/tasks/scheduler/stats') as Promise<{ healthy: boolean; activeTimers: number; activeCronTasks: number; runningTaskCount: number; totalScheduledTasks: number; uptime: number }>,
};
