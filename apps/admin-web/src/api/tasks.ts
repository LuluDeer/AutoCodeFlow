import { client } from './client';

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

export const TIMEOUT_ACTION_OPTIONS: { value: TimeoutAction; label: string }[] = [
  { value: 'kill', label: '终止（默认）' },
  { value: 'kill_retry', label: '终止并重试' },
  { value: 'notify_only', label: '仅通知' },
];

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
  logs?: string;
  errorMessage?: string;
  failureReason?: string | null;
  /** 非零/非空退出码（后端终态回调入库；null=旧数据未采集） */
  exitCode?: number | null;
  aiAnalysis?: string;
  retryCount?: number;
  taskVersion?: string | null;
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
}

/**
 * U2: GET /tasks/:id/executions/:execId/logs 响应形状
 * （task.service.ts getExecutionLogs：按行分页，limit 后端上限 2000）。
 */
export interface ExecutionLogsPage {
  lines: string[];
  totalLines: number;
  hasMore: boolean;
}

export const tasksApi = {
  list: (params?: { page?: number; pageSize?: number; name?: string; status?: string; triggerType?: string; runtime?: string; applicationId?: string }) =>
    client.get('/tasks', { params }) as Promise<PageResult<Task>>,
  get: (id: string) =>
    client.get(`/tasks/${id}`) as Promise<Task>,
  create: (data: Partial<Task>) =>
    client.post('/tasks', data) as Promise<Task>,
  update: (id: string, data: Partial<Task>) =>
    client.patch(`/tasks/${id}`, data) as Promise<Task>,
  delete: (id: string) => client.delete(`/tasks/${id}`),
  trigger: (id: string, params?: Record<string, unknown>) =>
    client.post(`/tasks/${id}/trigger`, { params }),
  executions: (id: string, p?: { page?: number; pageSize?: number }) =>
    client.get(`/tasks/${id}/executions`, { params: p }) as Promise<PageResult<TaskExecution>>,
  /**
   * CORE-02: 按状态过滤拉取任务执行列表（复用 GET /tasks/:id/executions 的
   * 既有 status 查询参数，零新端点）。ExecutionDetailPage 重试链路段用它取
   * 同任务的兄弟执行行（retryCount 递增）拼装 attempt 链。
   */
  executionsWithStatus: (id: string, p: { page: number; pageSize: number; status?: string }) =>
    client.get(`/tasks/${id}/executions`, { params: p }) as Promise<PageResult<TaskExecution>>,
  execution: (taskId: string, execId: string) =>
    client.get(`/tasks/${taskId}/executions/${execId}`) as Promise<TaskExecution>,
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
  batchTrigger: (taskIds: string[]) => client.post('/tasks/batch/trigger', { taskIds }),
  batchPause: (taskIds: string[]) => client.post('/tasks/batch/pause', { taskIds }),
  batchResume: (taskIds: string[]) => client.post('/tasks/batch/resume', { taskIds }),
  batchDelete: (taskIds: string[]) => client.post('/tasks/batch/delete', { taskIds }),
  stats: (id: string) =>
    client.get(`/tasks/${id}/stats`) as Promise<{ recentExecutions: TaskExecution[]; successRate: number; avgDuration: number; totalRuns: number }>,
  updateGlue: (id: string, source: string, language?: string) =>
    client.put(`/tasks/${id}/glue`, { source, language }),
  allExecutions: (params?: { page?: number; pageSize?: number; status?: string; taskId?: string; taskName?: string; startTime?: string; endTime?: string; executorAddress?: string }) =>
    client.get('/tasks/executions/all', { params }) as Promise<PageResult<TaskExecution>>,
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
  schedulerStats: () =>
    client.get('/tasks/scheduler/stats') as Promise<{ healthy: boolean; activeTimers: number; activeCronTasks: number; runningTaskCount: number; totalScheduledTasks: number; uptime: number }>,
};
