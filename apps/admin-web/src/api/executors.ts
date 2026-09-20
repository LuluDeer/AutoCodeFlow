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
  /**

   * ARCH-32: 派发模式。'pull' = NAT 内执行器（长轮询取件，零入站依赖）；

   * 'push' = 默认（中心端入站 POST）。缺省视为 push（旧快照兼容）。

   */

  dispatchMode?: 'push' | 'pull';

  /**

   * EXE-VER-1/UI-17: EXECUTOR_MIN_VERSION 门禁的读面投影——执行器版本低于

   * 中心端下限时 false；门禁关/未上报版本恒 true（旧快照缺省 true）。

   */

  versionCompliant?: boolean;

  /**
   * python_task_multiversion（CONTRACT §2.2）：执行器上报的解释器池清单。
   *
   * 三态语义**必须**精确区分，任一态混淆都会造成调度错判
   * （admin `interpreter-match.util` 的判定完全依赖它）：
   *   - `null` = 旧版执行器**未上报**该字段 → 按"未知"处理，不参与过滤；
   *   - `[]`   = 已上报且池内**确实没有**可用解释器 → 声明了 runtimeVersion
   *              的任务不应派到这台；
   *   - 非空   = 已上报的可用版本清单。
   *
   * 此前本接口没声明该字段，于是 UI 侧拿不到"这台执行器到底有没有 3.11"，
   * 而 admin 的 `findAll()` 是直接展开实体（executor.service.ts:1143），
   * 该字段**一直在响应体里**——属于类型漏声明，不是后端不返回。
   */
  interpreters?: Array<{
    /** 完整补丁版本，如 "3.11.13"（不是任务声明的 X.Y）。 */
    version: string;
    /** 池内绝对路径；旧版/探测失败时可能缺省。 */
    path?: string;
    /** 探测时是否可用（文件存在且可执行）。 */
    available?: boolean;
    discoveredAt?: string;
  }> | null;
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

/**
 * GET /executors/runtime-config 返回的执行器面有效运行时参数
 * （executor lifecycle audit P2-5 / P3-9）。
 * 前端的心跳判死着色与列表截断提示必须以这里的值为准，不得再硬编码。
 */
export interface ExecutorRuntimeConfig {
  /** 心跳间隔（毫秒，默认 30000）。 */
  heartbeatIntervalMs: number;
  /** 判死倍数（默认 3）。 */
  heartbeatTimeoutMultiplier: number;
  /** 有效判死阈值 = interval × multiplier（默认 90000）。 */
  heartbeatTimeoutMs: number;
  /** GET /executors 列表的硬上限。 */
  listLimit: number;
  /** 执行器全量行数；executorTotal > listLimit 即列表被静默截断。 */
  executorTotal: number;
}

export const executorsApi = {
  getSharedToken: () =>
    client.get('/config/executor-shared-token') as Promise<SharedTokenResult>,
  generateSharedToken: () =>
    client.post('/config/executor-shared-token/generate') as Promise<{ token: string }>,
  list: (signal?: AbortSignal) =>
    signal
      ? client.get('/executors', { signal }) as Promise<Executor[]>
      : client.get('/executors') as Promise<Executor[]>,
  get: (id: string, signal?: AbortSignal) =>
    signal
      ? client.get(`/executors/${id}`, { signal }) as Promise<Executor>
      : client.get(`/executors/${id}`) as Promise<Executor>,
  update: (id: string, data: Partial<Executor>) =>
    client.patch(`/executors/${id}`, data) as Promise<Executor>,
  getGroups: (signal?: AbortSignal) =>
    signal
      ? client.get('/executors/groups', { signal }) as Promise<string[]>
      : client.get('/executors/groups') as Promise<string[]>,
  getTags: (signal?: AbortSignal) =>
    signal
      ? client.get('/executors/tags', { signal }) as Promise<string[]>
      : client.get('/executors/tags') as Promise<string[]>,
  /**
   * GET /executors/runtime-config：后端有效判死阈值 + 列表截断上限/全量数。
   * 固定段路由（服务端声明在 :id 参数路由之前）。
   */
  getRuntimeConfig: (signal?: AbortSignal) =>
    signal
      ? client.get('/executors/runtime-config', { signal }) as Promise<ExecutorRuntimeConfig>
      : client.get('/executors/runtime-config') as Promise<ExecutorRuntimeConfig>,
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
  getExecutions: (id: string, params?: { page?: number; pageSize?: number }, signal?: AbortSignal) =>
    signal
      ? client.get(`/executors/${id}/executions`, { params, signal }) as Promise<{ total: number; items: ExecutorExecution[] }>
      : client.get(`/executors/${id}/executions`, { params }) as Promise<{ total: number; items: ExecutorExecution[] }>,
  getMetrics: (id: string, signal?: AbortSignal) =>
    signal
      ? client.get(`/executors/${id}/metrics`, { signal }) as Promise<ExecutorMetrics>
      : client.get(`/executors/${id}/metrics`) as Promise<ExecutorMetrics>,
  /** 获取执行器一键安装命令（含共享 Token，安装向导与执行器列表共用） */
  getInstallCmd: () =>
    client.get('/executors/install-cmd') as Promise<InstallCmdResult>,
};
