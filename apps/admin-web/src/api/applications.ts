import type { components } from '../types/generated/api-types';
import { client } from './client';

// N-12（2026-10-07）：请求 DTO 切生成类型（后端 env 的 swagger 声明缺
// additionalProperties 曾致生成 Record<string, never>，已修）。
export type CreateDeploymentDto = components['schemas']['CreateDeploymentDto'];

/**
 * GET /app-deployments/stats 的行（应用列表页部署统计）。
 *
 * 走生成类型（与 CreateDeploymentDto 同源），后端 DTO 改动时
 * `npm run gen:api-types` 会把它同步过来——统计口径漂移是「中台显示不可信」
 * 的高发区，不在这里再手抄一份。
 */
export type AppDeploymentStats = components['schemas']['AppDeploymentStatsDto'];

export interface Application {
  id: string;
  name: string;
  description?: string;
  version: string;
  runtime: string;
  status: string;
  gitRepo?: string;
  gitBranch?: string;
  gitCommit?: string;
  manifest?: Record<string, unknown>;
  env?: Record<string, string>;
  entrypoint?: string;
  /** DEP-04: 开启后新部署冻结为待审批，需第二人批准后才派发 */
  approvalRequired?: boolean;
  /** MUTEX-01: 挂入的互斥组（null = 不参与互斥，仅受设备槽位约束） */
  mutexGroupId?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** MUTEX-01: 应用互斥组。N-15 scope——device=单点互斥（同设备×同组串行，
 *  跨设备并发）；global=全局互斥（组内跨设备串行，全平台同时最多 N 条）。 */
export interface MutexGroup {
  id: string;
  name: string;
  maxConcurrentPerDevice: number;
  scope: 'device' | 'global';
  description?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** DEP-04: 审批痕迹（approvalMeta 列的读面形状）。 */
export interface DeploymentApprovalMeta {
  requestedBy?: number | null;
  requestedByName?: string | null;
  requestedAt?: string;
  actedBy?: number | null;
  actedByName?: string | null;
  actedAt?: string;
  reason?: string | null;
}

export interface AppDeployment {
  id: string;
  applicationId: string;
  application?: Application;
  executorId: string | null;
  executorAddress: string;
  status: 'pending' | 'deploying' | 'running' | 'stopped' | 'failed' | 'upgrading';
  runMode: 'once' | 'daemon' | 'scheduled';
  deployedCommit: string | null;
  deployedVersion: string | null;
  startCommand: string | null;
  env: Record<string, string> | null;
  pid: number | null;
  lastHeartbeat: string | null;
  statusMessage: string | null;
  deployedAt: string | null;
  /** DEP-04: 审批推进状态（null=非审批路径） */
  approvalStatus?: 'pending_approval' | 'approved' | 'rejected' | 'cancelled' | null;
  approvalMeta?: DeploymentApprovalMeta | null;
  /**
   * P1-9（UX-AUDIT-2026-09-21）：灰度发布状态。后端 RolloutState：
   * pending=待灰度 / probing=首批观察中 / promoted=已转正全量 /
   * failed=灰度失败 / rolled_back=已回滚。null=非灰度部署。
   */
  rolloutState?: string | null;
  createdAt: string;
  updatedAt: string;
}


export interface VersionHistoryEntry {
  id?: string;
  sourceDeploymentId?: string | null;
  createdAt?: string;
  snapshot?: unknown;
  deployCount?: number;
  deploymentId: string | null;
  version: string | null;
  commit: string | null;
  status: string;
  deployedAt: string | null;
  executorAddress: string | null;
}

/**
 * R3-A（部署模型评审 2026-10-23 §4.3）：版本行上的设备徽标——正在运行或
 * 本地保留该版本的设备（设备心跳上报的事实，非部署行推断）。
 */
export interface AppReleaseDevice {
  /** 执行器行 id */
  executorId: string;
  /** 执行器可读名（executors.appName）；行已删/未上报名时 null */
  executorName: string | null;
  /** 该设备该应用 current 指向的版本（保留场景下可能与本行版本不同） */
  currentVersion: string | null;
  /** 本行版本 ∈ 设备 retainedVersions（设备磁盘仍持有该版本） */
  retained: boolean;
  /** executors.status === ONLINE（离线设备的版本事实可能已过期） */
  online: boolean;
  /** executors.lastHeartbeat（设备最后上报时刻，ISO） */
  lastHeartbeat: string | null;
}

/**
 * DEP-01：统一发布追溯行（GET /applications/:id/releases）。
 * 一行 = 一次版本发布：版本快照（application_versions）+ 该版本最近一次部署
 * （app_deployments）两语义面合并。与后端 dto/app-release.dto.ts 逐字段对齐。
 */
export interface AppReleaseRow {
  /** application_versions.id；纯部署历史（无版本快照行）时 null */
  id: string | null;
  version: string | null;
  /** 部署当时的包地址（snapshot.packageUrl，不回退应用当前值）；无快照 null */
  packageUrl: string | null;
  gitCommit: string | null;
  /** 该版本最近一次部署完成时刻（deployedAt ?? createdAt 最大值）；无部署 null */
  deployedAt: string | null;
  latestDeploymentId: string | null;
  /** 最近一次部署状态（pending/deploying/running/stopped/failed/upgrading）；无部署 null */
  deploymentStatus: string | null;
  /** 该版本累计部署次数（同版本多实例/多次部署各计一次） */
  deploymentCount: number;
  executorAddress: string | null;
  /** 执行模式 once/daemon/scheduled；无部署 null */
  runMode: string | null;
  /** 触发方式（推导语义：upgrade/manual/unknown）；无部署 null */
  triggerType: 'upgrade' | 'manual' | 'unknown' | null;
  /** 操作人：application_versions.createdBy——当前恒 null（来源缺失如实标注） */
  operator: string | null;
  operatorSource: 'application_versions.createdBy';
  operatorMissingReason: string;
  sourceDeploymentId: string | null;
  /** application_versions.status（released/deploying/failed）；纯部署行时为部署状态字符串 */
  status: string;
  /** 版本行创建时刻（快照诞生时间）；纯部署行时为 deployedAt */
  createdAt: string | null;
  /** 部署记录合成行（从未保存版本快照的历史数据，deployedVersion=null 归一 version=null） */
  synthetic: boolean;
  /**
   * R3-A（§4.3）：正在运行或本地保留该版本的设备（设备上报事实聚合）。
   * 旧后端（R3-A 前）不带该键——可选以兼容过渡期；无设备上报时为空数组。
   */
  devices?: AppReleaseDevice[];
}

export interface AppReleasesPage {
  data: AppReleaseRow[];
  total: number;
  page: number;
  pageSize: number;
  /**
   * P8：版本行超 RELEASES_MAX_PAGE_SIZE 被静默截断时为 true（响应字段只增，
   * 旧后端不带该键——可选以兼容过渡期）。消费方应显式告警，否则「看到的
   * 不是全量」会被当成「就这么多」。
   */
  truncated?: boolean;
  /**
   * P8-R（部署模型评审遗留）：truncated=true 吞掉被截版本的 devices 徽标时，
   * 后端用全量设备事实求差集带回的「有设备保留但不在本页行中」的版本号
   * 列表（字母序；truncated=false 恒空）。旧后端不带该键——可选以兼容过渡期。
   */
  retainedButTruncated?: string[];
}

/**
 * R4（部署模型评审 2026-10-23 §4.1A）：不可变部署事件流行
 * （GET /app-deployments/applications/:appId/events，实体原样序列化——
 * 与后端 dto/app-deployment-response.dto.ts 的 AppDeploymentEventRowDto 逐字段对齐）。
 *
 * 事件行只含短事实快照（写入侧保证 detail 不带 env），无需掩码；
 * deploymentId 无外键——remove 事件比部署行活得久。
 */
export interface AppDeploymentEventRow {
  id: string;
  applicationId: string;
  /** 触发本事件的部署行 id；行可能已被 remove 删除 */
  deploymentId: string | null;
  executorId: string | null;
  executorAddress: string | null;
  /** AppDeploymentEventType（varchar 裸 token；展示层负责人类可读映射） */
  eventType: string;
  /** 动作发生时的版本事实；动作时未知为 null */
  deployedVersion: string | null;
  /** 动作语义（manual/upgrade/rollback/approval）；机器路径为 null */
  triggerType: string | null;
  /** 操作人（JWT 用户名）；机器路径（如卡死扫描）为 null */
  operator: string | null;
  /** 短事实快照（reason/runMode/previousStatus/deletedStatus 等标量） */
  detail?: Record<string, unknown> | null;
  createdAt: string;
}

/** R4 §4.1A：事件流分页信封（裸四键，同 /releases 形态）。 */
export interface AppDeploymentEventsPage {
  data: AppDeploymentEventRow[];
  total: number;
  page: number;
  pageSize: number;
}

export const applicationsApi = {
  list: (signal?: AbortSignal) =>
    signal
      ? client.get<Application[]>('/applications', { signal })
      : client.get<Application[]>('/applications'),
  get: (id: string) => client.get<Application>(`/applications/${id}`),
  create: (data: Partial<Application>) => client.post<Application>('/applications', data),
  update: (id: string, data: Partial<Application>) =>
    client.put<Application>(`/applications/${id}`, data),
  delete: (id: string) => client.delete<void>(`/applications/${id}`),
  /**
   * P0-3（UX-AUDIT-2026-09-21）：删除影响面预览。
   *
   * 删除应用的真实后果远超"少一条记录"：部署行 CASCADE 消失、本地包被物理删除、
   * 而**引用它的任务不会消失**（applicationId 被 SET NULL）——任务照旧按计划调度
   * 但代码来源已断，此后每次执行都失败，且排查入口（本页）已不存在。
   */
  removalImpact: (id: string) =>
    client.get<{
      applicationName: string;
      tasksLosingSource: number;
      deploymentCount: number;
      packageFileWillBeDeleted: boolean;
    }>(`/applications/${id}/removal-impact`),
  upload: (formData: FormData) =>
    // F-5b（UIUX 审计 P2-4 同型遗留，对齐 F-5 的 executor-packages/registry 处置）：
    // 应用包上传上限 200MB（后端 FileInterceptor），弱网下远超全局 30s——axios
    // 掐断报「网络错误」而服务端可能仍在接收，用户重传会产生重复/僵尸包。
    // 显式 timeout:0 不限时，由上传中的 loading 态 + 用户手动取消兜底。
    client.post<Application>('/applications/upload', formData, { timeout: 0 }),
  webhook: (payload: unknown) => client.post<{ ok: boolean }>('/applications/webhook', payload),
  syncTasks: (id: string) =>
    client.post<{ ok: boolean; registeredCount: number }>(`/applications/${id}/sync-tasks`),
  /**
   * P1-9：后端 upgrade-all 早已支持 body.rollout（灰度策略），前端此前 POST 时
   * 不带 body——灰度发布在 UI 上没有任何入口。现在把策略透传：
   *   strategy='canary' 时按 percentage% 灰度首批，后端自动观察/转正/回滚。
   * R2（部署模型评审 §4.4）：includeStopped 仅 all 策略生效（stopped 显式
   * opt-in）；响应新增 coverage 分组计数与 skipped 在途跳过明细——只增不改，
   * 旧调用方按需消费。
   */
  upgradeAll: (
    id: string,
    rollout?: { strategy: 'full' | 'canary'; percentage?: number },
    includeStopped?: boolean,
  ) =>
    // A-8：canary 被互斥拒绝时后端返回 200 + ok:false + rollout.blockedReason
    // （非 HTTP 错误），前端必须读这两个字段才不会把「未启动」当成「已成功」。
    client.post<{
      ok: boolean;
      total: number;
      succeeded: number;
      failed: number;
      /** R2 §4.4：按状态分组的覆盖面计数（后端恒回显）。 */
      coverage?: {
        running: number;
        scheduled: number;
        stopped: number;
        failed: number;
        inFlight: number;
      };
      /** R2 §4.4：在途行（pending/deploying/upgrading）跳过明细。 */
      skipped?: Array<{
        deploymentId: string;
        executorId: string | null;
        status: string;
        reason: string;
      }>;
      rollout?: { batchId: string; blockedReason?: string };
    }>(
      `/applications/${id}/upgrade-all`,
      rollout || includeStopped
        ? { ...(rollout ? { rollout } : {}), ...(includeStopped ? { includeStopped: true } : {}) }
        : {},
    ),
  getVersionHistory: (id: string) =>
    client.get<VersionHistoryEntry[]>(`/applications/${id}/versions`),
  // DEP-01：统一发布追溯视图（版本 × 最近一次部署），分页（pageSize 默认 50、上限 200）
  getReleases: (id: string, page = 1, pageSize = 50) =>
    client.get<AppReleasesPage>(`/applications/${id}/releases`, {
      params: { page, pageSize },
    }),
  /**
   * R4（§4.1A）：应用的不可变部署事件流（append-only 动作追溯）。分页默认
   * 50、上限 200（对齐 /releases）；按 createdAt 倒序（同秒多事件 id 兜底）。
   * 注意路由挂在 /app-deployments 控制器下（非 /applications/:id/...）。
   *
   * eventType/since/until：服务端过滤（上轮遗留——事件量极大时深翻页代价
   * 高）。eventType 单值（九枚举之一）；since/until 为 ISO 8601 半开区间
   * [since, until)（含头不含尾）。
   */
  getDeploymentEvents: (
    id: string,
    page = 1,
    pageSize = 50,
    filters?: { eventType?: string; since?: string; until?: string },
  ) =>
    client.get<AppDeploymentEventsPage>(`/app-deployments/applications/${id}/events`, {
      params: {
        page,
        pageSize,
        ...(filters?.eventType ? { eventType: filters.eventType } : {}),
        ...(filters?.since ? { since: filters.since } : {}),
        ...(filters?.until ? { until: filters.until } : {}),
      },
    }),
  /**
   * R1（部署模型评审 2026-10-23 §4.2）：旧 rollback 端点（恢复应用字段 + 全量
   * 下发捆绑）已标 deprecated，UI 拆成两个显式动作——
   *   · setCurrentVersion 只按版本快照恢复应用当前字段（dispatched 恒 false，
   *     绝不动部署行/设备）；
   *   · deployVersion 恢复字段后下发（缺省全部 RUNNING 行；可按执行器点名，
   *     无部署行/不可下发的执行器进 skipped 明细而非报错）。
   */
  setCurrentVersion: (id: string, versionId: string) =>
    client.post<SetCurrentVersionResult>(`/applications/${id}/set-current-version`, {
      versionId,
    }),
  deployVersion: (id: string, versionId: string, executorIds?: string[]) =>
    client.post<DeployVersionResult>(
      `/applications/${id}/deploy-version`,
      executorIds ? { versionId, executorIds } : { versionId },
    ),
};

/** R1 §4.2：POST /applications/:id/set-current-version 响应。 */
export interface SetCurrentVersionResult {
  ok: boolean;
  /** 恒 false——本端点不下发任何设备 */
  dispatched: boolean;
  version: string;
  versionId: string;
}

/** R1 §4.2：POST /applications/:id/deploy-version 响应。 */
export interface DeployVersionResult {
  ok: boolean;
  /** 恒 true——本端点就是下发动作 */
  dispatched: boolean;
  version: string;
  versionId: string;
  upgraded: Array<{
    deploymentId: string;
    executorId: string | null;
    executorAddress: string | null;
  }>;
  /** no_deployment / not_running / upgrade_rejected（detail 带补充信息） */
  skipped: Array<{
    executorId: string | null;
    deploymentId: string | null;
    reason: 'no_deployment' | 'not_running' | 'upgrade_rejected';
    detail?: string | null;
  }>;
}

/** MUTEX-01：互斥组配置管理（读面全登录用户，写面 ADMIN）。 */
export const mutexGroupsApi = {
  list: () => client.get<MutexGroup[]>('/mutex-groups'),
  create: (data: {
    name: string;
    maxConcurrentPerDevice?: number;
    // N-15：组作用域（单点/全局互斥）
    scope?: 'device' | 'global';
    description?: string;
  }) => client.post<MutexGroup>('/mutex-groups', data),
  update: (id: string, data: {
    name?: string;
    maxConcurrentPerDevice?: number;
    scope?: 'device' | 'global';
    description?: string;
  }) => client.put<MutexGroup>(`/mutex-groups/${id}`, data),
  remove: (id: string, force = false) =>
    client.delete<{ ok: boolean }>(`/mutex-groups/${id}${force ? '?force=true' : ''}`),
};

export const deploymentsApi = {
  list: (applicationId?: string, page = 1, pageSize = 20, approvalStatus?: string) =>
    client.get<{ data: AppDeployment[]; total: number }>('/app-deployments', {
      params: {
        ...(applicationId ? { applicationId } : {}),
        ...(approvalStatus ? { approvalStatus } : {}),
        page,
        pageSize,
      },
    }),
  /**
   * 各应用的部署统计（每应用一行，服务端 GROUP BY 聚合）。
   *
   * 应用列表页的「运行 X/Y 台」此前对**每个应用各发一个** list() 现算——
   * 26 个应用 = 26 个请求，而全局限流按「路由 handler + IP」计桶，这 26 个
   * 请求共享同一个 60/min 预算：进页面 + 返回页面 + 部署后刷新就打满，
   * 整页部署列 429（生产实证 2026-10-13）。改用本端点后**无论多少应用都只
   * 发 1 个请求**。
   *
   * 只返回至少有一条部署行的应用；无部署的应用不在结果里（按 0 处理）。
   */
  stats: () => client.get<AppDeploymentStats[]>('/app-deployments/stats'),
  get: (id: string) => client.get<AppDeployment>(`/app-deployments/${id}`),
  deploy: (appId: string, dto: CreateDeploymentDto) =>
    client.post<AppDeployment>(`/app-deployments/applications/${appId}/deploy`, dto),
  upgrade: (id: string) =>
    client.post<AppDeployment>(`/app-deployments/${id}/upgrade`),
  stop: (id: string) =>
    client.post<AppDeployment>(`/app-deployments/${id}/stop`),
  /**
   * 删除部署记录（用户报障：失败的部署行无法删除，重新部署后旧行永久残留）。
   *
   * 仅终态行（failed/stopped）可删；在途/运行中/待审批行后端返回 409 并说明
   * 正确出口（等它结束 / 先 stop / 走 reject|cancel）——错误信息直接透传给用户。
   */
  remove: (id: string) =>
    client.delete<{ ok: boolean; deletedId: string }>(`/app-deployments/${id}`),
  // DEP-04: 审批三动作（后端 @Roles(ADMIN) + 第二人规则）
  approve: (id: string, reason?: string) =>
    client.post<AppDeployment>(`/app-deployments/${id}/approval/approve`, reason ? { reason } : {}),
  reject: (id: string, reason?: string) =>
    client.post<AppDeployment>(`/app-deployments/${id}/approval/reject`, reason ? { reason } : {}),
  cancel: (id: string) =>
    client.post<AppDeployment>(`/app-deployments/${id}/approval/cancel`),
};
