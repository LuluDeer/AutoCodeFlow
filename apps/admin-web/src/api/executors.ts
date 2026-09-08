import { client } from './client';

export interface Executor {
  id: string;
  appName: string;
  address: string;
  status: string;
  type?: string;
  executorVersion?: string;
  cpuUsage: number;
  memUsage: number;
  diskUsage?: number;
  networkLatency?: number;
  runningTaskCount: number;
  totalTaskCount?: number;
  failedTaskCount?: number;
  lastHeartbeat: string;
  groupName?: string | null;
  tags?: string[] | null;
  description?: string | null;
  maxConcurrentTasks?: number | null;
  /**
   * CONSISTENCY-02: executor-node 心跳上报的运行中 executionId 列表（≤200）。
   * null = 旧版执行器未上报该字段（区别于 []：已上报且当前空闲）。
   * stale 扫描据此跳过"回调只是迟到"的正常执行，详情页据此做活性交叉核对。
   */
  runningExecutionIds?: string[] | null;
  /**
   * U16: executor-node/python 心跳上报的回调死信（dead-letter）积压数。
   * null = 旧版执行器未上报该字段（区别于 0：已上报且无积压）。
   * >0 表示回调持续失败、载荷已落盘执行器本地 dead-letter，需人工排查。
   */
  deadLetterCount?: number | null;
}

export interface ExecutorMetrics {
  executor: { id: string; address: string; status: string };
  sevenDayStats: {
    totalExecutions: number;
    successful: number;
    failed: number;
    // U13: 后端 executor.service.ts getExecutorMetrics 返回 number（非字符串），
    // 声明对齐，调用点无需 `+` 强转。
    successRate: number;
    averageDurationMs: number;
  };
  current: {
    runningTaskCount: number;
    cpuUsage?: number;
    memUsage?: number;
  };
  /** FEAT-04: 最近 24h 资源趋势采样（15 分钟 AVG 桶，升序）；无数据为空数组 */
  history: ExecutorMetricsHistoryPoint[];
}

/**
 * FEAT-04: GET /executors/:id/metrics `history` 采样点。
 * 后端把最近 24h 的 executor_metrics_history 心跳按固定 15 分钟时间桶 AVG
 * 聚合（24h/900s = ≤96 桶，时间升序）；整桶无 CPU/内存上报时为 null，
 * 前端折线以断点呈现（connectNulls）。
 */
export interface ExecutorMetricsHistoryPoint {
  /** 桶起点时间（ISO 8601 字符串，服务端 toISOString 序列化） */
  timestamp: string;
  /** 桶内 CPU 均值（%）；整桶无上报为 null */
  cpuUsage: number | null;
  /** 桶内内存均值（%）；整桶无上报为 null */
  memUsage: number | null;
  /** 桶内运行任务数均值（四舍五入取整） */
  runningTaskCount: number;
}

export interface ExecutorExecution {
  id: string;
  taskId: string;
  taskName?: string;
  status: string;
  startTime?: string;
  endTime?: string;
  duration?: number;
  errorMessage?: string;
  /** 后端返回完整 TaskExecution 实体：终态退出码（null=旧数据未采集） */
  exitCode?: number | null;
  createdAt: string;
}

export interface SharedTokenResult {
  token: string | null;
  hasToken: boolean;
}

/** GET /executors/install-cmd 返回的执行器一键安装命令信息 */
export interface InstallCmdResult {
  cmd: string;
  token: string;
  adminApiUrl: string;
}

export const executorsApi = {
  getSharedToken: () =>
    client.get('/config/executor-shared-token') as Promise<SharedTokenResult>,
  generateSharedToken: () =>
    client.post('/config/executor-shared-token/generate') as Promise<{ token: string }>,
  list: () => client.get('/executors') as Promise<Executor[]>,
  get: (id: string) => client.get(`/executors/${id}`) as Promise<Executor>,
  update: (id: string, data: Partial<Executor>) =>
    client.patch(`/executors/${id}`, data) as Promise<Executor>,
  getGroups: () => client.get('/executors/groups') as Promise<string[]>,
  getTags: () => client.get('/executors/tags') as Promise<string[]>,
  rotateToken: (id: string, reason?: string) =>
    client.post(`/executors/${id}/rotate-token`, reason ? { reason } : undefined) as Promise<{ token: string; expiresAt: string }>,
  /**
   * AUTH-05 交接：删除执行器（ADMIN-only）。可选 reason（≤200 字符）随
   * body 发送，写审计 executor.delete（detail={address,appName,reason?}）。
   */
  remove: (id: string, reason?: string) =>
    client.delete(`/executors/${id}`, reason ? { data: { reason } } : undefined) as Promise<void>,
  reloadConfig: (id: string, data: {
    maxConcurrentTasks?: number;
    taskTimeoutSeconds?: number;
    heartbeatIntervalSeconds?: number;
    adminApiUrl?: string;
    adminApiUrlInternal?: string;
    adminApiUrlExternal?: string;
  }) =>
    client.post(`/executors/${id}/reload-config`, data) as Promise<void>,
  setOffline: (id: string) =>
    client.post(`/executors/${id}/set-offline`) as Promise<Executor>,
  getExecutions: (id: string, params?: { page?: number; pageSize?: number }) =>
    client.get(`/executors/${id}/executions`, { params }) as Promise<{ total: number; items: ExecutorExecution[] }>,
  getMetrics: (id: string) =>
    client.get(`/executors/${id}/metrics`) as Promise<ExecutorMetrics>,
  /** 获取执行器一键安装命令（含共享 Token，安装向导与执行器列表共用） */
  getInstallCmd: () =>
    client.get('/executors/install-cmd') as Promise<InstallCmdResult>,
};
