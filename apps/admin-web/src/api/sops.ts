import type { components } from '../types/generated/api-types';
import { client } from './client';

/**
 * P5/P6：SOP 协议 API（对齐 admin-api sop.controller.ts，全 ADMIN-only）。
 * 协作面（agent-collab）由执行器 Agent 走机器鉴权调用，不经本模块。
 */

/**
 * R280：跨 SOP 待答复升级澄清的响应**合同派生**（不是手写形状）。
 *
 * 为什么派生：`scripts/check-web-type-drift.mjs` 是「手写 API 类型只减不增」的棘轮，
 * 手写副本与生成物同名同义却互不约束——后端改字段名时 tsc 照样绿、前端静默读到
 * `undefined`。admin-api 已用 `@ApiOkResponse` 导出该 DTO ⇒ 一律从生成物派生。
 *
 * 字段语义以生成物为准：
 * - `total` = `number | null`，`null` 是**读不到**，绝不等于 0；
 * - `truncated = returned < total`；`total === null` 时为 `false`，未知由 `degraded` 说；
 * - `sopName` 为 `null` 时**绝不退回 uuid**（uuid 不是给人看的标题）。
 */
export type SopPendingClarificationsResponse =
  components['schemas']['SopPendingClarificationsResponseDto'];

export interface Sop {
  id: string;
  slug: string;
  title: string;
  currentVersion: string | null;
  status: 'draft' | 'published' | 'deprecated';
  applicationId: string | null;
  frontMatterJson: Record<string, unknown> | null;
  bodyMarkdown: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SopVersion {
  id: string;
  sopId: string;
  version: string;
  frontMatterJson: Record<string, unknown>;
  bodyMarkdown: string;
  changelog: string | null;
  contentHash: string;
  publishedBy: string;
  publishedAt: string;
  createdAt: string;
}

export interface SopAssignment {
  id: string;
  sopId: string;
  sopVersion: string;
  targetExecutorId: string | null;
  targetAgentSessionId: string | null;
  status: 'assigned' | 'in_progress' | 'blocked' | 'completed' | 'failed' | 'cancelled' | 'stalled';
  clarificationRound: number;
  maxRounds: number;
  resultJson: Record<string, unknown> | null;
  parentSessionId: string | null;
  pulledAt: string | null;
  lastProgressAt: string | null;
  progressJson: Record<string, unknown> | null;
  attempt: number;
  /** 澄清回复投递游标（P7d 双端 ACK）：执行器确认后推进。 */
  lastReplyDeliveredAt: string | null;
  capabilitySnapshotJson: Record<string, unknown> | null;
  permissionProfileAtPull: string | null;
  assignedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SopClarification {
  id: string;
  clientClarificationId: string | null;
  assignmentId: string;
  round: number;
  question: string;
  questionContextJson: Record<string, unknown> | null;
  answer: string | null;
  resolution: 'answered' | 'sop_amended' | 'escalated_to_human' | null;
  newSopVersion: string | null;
  mediaRefsJson: Array<{ kind: string; url: string; note?: string }> | null;
  reviewSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SopMedia {
  id: string;
  assignmentId: string;
  name: string;
  mime: string | null;
  sizeBytes: number;
  storedPath: string;
  uploadedBy: string;
  createdAt: string;
}

/** 指派可选执行器（P7c 租约投影：只含当前租约内声明 agent:sop 的机器）。 */
export interface AssignableExecutor {
  id: string;
  appName: string;
  address: string;
  status: string;
  lastHeartbeat: string | null;
  agentCapabilities: string[];
}

export const sopsApi = {
  list: (params?: { status?: string; page?: number; pageSize?: number }) =>
    client.get('/sop', { params }) as Promise<{ items: Sop[]; total: number }>,
  /**
   * R280：跨 SOP、**待人工答复**的升级澄清（`resolution = escalated_to_human` 且所属
   * 指派未终态）。收件箱第九个小节与顶栏「待答复澄清」计数共用这一个读面。
   *
   * ## 为什么这里的响应形状是**内联**的（不新开顶层具名类型）
   *
   * 后端 `SopPendingClarificationsResponseDto` 已落地，但 `apps/admin-api/openapi.json`
   * 生成物由主会话统一重生成，此刻 `types/generated/api-types.ts` 里**还没有**这个
   * schema。若在这里写一个顶层具名副本，会同时踩两道棘轮：
   * `check-web-type-drift`（新增手写 API 类型即红）与
   * `check-web-type-field-drift`（未配对手写类型增长即红）。
   * ⇒ 形状内联在方法返回注解上（与 `agent.ts` 的 `listFailedSessions` 同款写法）。
   * 生成物重生成后应改为 `components['schemas']['SopPendingClarificationsResponseDto']`。
   *
   * ## 失败语义（与后端契约逐条对齐）
   *
   * - `total: null` = **读不到**（读失败）⇒ 前端显示「—」，绝不回落 0；
   * - `truncated = returned < total`；`total` 未知时为 `false`（「是否截断」也不可知，
   *   那件事由 `degraded` 表达）；
   * - `degraded` = 任一子查询失败，HTTP 仍 200；
   * - 服务未装配 ⇒ **503**（不回 200 空信封）⇒ 调用方读成「读不到」；
   * - `sopName: null` = 标题读不到或为空 ⇒ **绝不退回 uuid**（uuid 不是给人看的标题）。
   *
   * `limit` 非法值（`abc`/`-5`/`9999`）后端安全回落，仍 200；本模块只传正数。
   */
  pendingClarifications: (limit?: number, signal?: AbortSignal) =>
    client.get('/sop/clarifications/pending', {
      params: { limit: limit ?? 100 },
      ...(signal ? { signal } : {}),
    }) as Promise<SopPendingClarificationsResponse>,
  /**
   * R286：滞留 blocked 工单（`status='blocked'` 且超过 `hours` 未推进）。
   *
   * **合同派生**（不手写形状）：admin-api 已用 `@ApiOkResponse` 导出
   * `SopAssignmentLagResponseDto`；手写副本与生成物同名同义却互不约束，
   * 后端改字段名时 tsc 照样绿、前端静默读 undefined（`check-web-type-drift` 的棘轮就在防这个）。
   *
   * ⚠️ 字段语义以**生成物注释**为权威（`api-types.ts` 的
   * `SopAssignmentLag{Item,Response}Dto`），这里不复制一份会过期的版本。
   * 三条与消费方式直接相关的仍写在这里：
   *
   * - `total` 为 `null` = **读不到**，绝不等于 0（`0` 是库里真 0 条）；
   * - `blockedSince` 恒有值（谓词本身是 `updatedAt <= now - hours`，缺失时间戳的
   *   行构造上选不中），且是「进入 blocked 的时刻」**不是**查询窗口 `hours`
   *   ⇒ 行内「已阻塞 X 小时」走 `blockedHours()` 现算，不许拿窗口顶上；
   * - `round: null` ⇔ 无可用 escalated 澄清（与 `staleClarificationId` 同真同假）
   *   ⇒ 渲染「第 — 轮」，不编 1；它是**触顶那轮**（maxRounds=5 触顶 ⇒ 6），
   *   不是「当前轮次」，也不是「已完成轮数」。
   *
   * 服务端**没有** `limit` 参数（行数上限是内部常量）⇒ 只按 `returned`/`total` 消费。
   *
   * ## `hours` 为什么是**必填**参数（不是 `hours?:`）
   *
   * 生成物把 `hours` 标成 `required: true`（`SopController_listLaggingAssignments`
   * 的 `parameters.query.hours: string`）。事实是运行期可以不传（`@Query("hours")`
   * 是可选，service 回落 24h）——这是 NestJS Swagger 未写 `@ApiQuery` 时的既有
   * 推断行为，全库同形 36 处（`/agent/sessions` 的 `page`、`/sop/clarifications/pending`
   * 的 `limit` 等），切片 A 已把它登记为遗留项。
   *
   * 对本方法的要求只有一条：**调用点必须给出窗口**，不在方法内再写一个默认值。
   * 旧写法 `hours ?? 24` 会让「24」这个数字在仓库里出现两处（`SOP_BLOCKED_WINDOW_HOURS`
   * 与这里的字面量），常量一改，这个方法就静默用旧窗口 —— 而窗口是**筛选条件**，
   * 它会改变「哪些工单出现在本节」，不会报错。
   */
  laggingAssignments: (hours: number, signal?: AbortSignal) =>
    client.get('/sop/assignments/lagging', {
      params: { hours },
      ...(signal ? { signal } : {}),
    }) as Promise<components['schemas']['SopAssignmentLagResponseDto']>,
  get: (id: string) => client.get(`/sop/${id}`) as Promise<Sop>,
  draft: (data: {
    slug: string;
    title: string;
    frontMatterYaml?: string;
    bodyMarkdown?: string;
    applicationId?: string;
  }) => client.post('/sop', data) as Promise<Sop>,
  updateDraft: (id: string, data: { title?: string; frontMatterYaml?: string; bodyMarkdown?: string }) =>
    client.patch(`/sop/${id}`, data) as Promise<Sop>,
  publish: (id: string, data?: { bump?: 'patch' | 'minor' | 'major'; changelog?: string }) =>
    client.post(`/sop/${id}/publish`, data ?? {}) as Promise<{ sop: Sop; version: SopVersion }>,
  /**
   * 归档（2026-10-23）：`deprecated` 此前是死状态——SOP 只增不减，测试残留
   * 永远留在列表里。归档**不删数据**（版本/指派/澄清全保留），只停止派新单。
   * 有未结束指派时后端 409（`SOP_ARCHIVE_HAS_ACTIVE_ASSIGNMENTS`）。
   */
  deprecate: (id: string) => client.post(`/sop/${id}/deprecate`, {}) as Promise<Sop>,
  /** 恢复已归档的 SOP（发布过 → published，未发布过 → draft）。 */
  restore: (id: string) => client.post(`/sop/${id}/restore`, {}) as Promise<Sop>,
  /**
   * 取消该 SOP 下所有未结束的指派（2026-10-23）。
   *
   * 归档前置动作：`deprecate` 遇到未结束指派会 409，而此前没有任何取消入口
   * （`cancelled` 是零写入点的死状态）。只取消 assigned/in_progress/blocked/stalled，
   * 终态与全部历史数据原样保留。
   */
  cancelAssignments: (id: string) =>
    client.post(`/sop/${id}/assignments/cancel`, {}) as Promise<{ cancelled: number }>,
  assign: (
    id: string,
    data: { version?: string; executorId?: string; executorAddress?: string },
  ) => client.post(`/sop/${id}/assign`, data) as Promise<SopAssignment>,
  versions: (id: string) => client.get(`/sop/${id}/versions`) as Promise<SopVersion[]>,
  assignments: (id: string) => client.get(`/sop/${id}/assignments`) as Promise<SopAssignment[]>,
  assignment: (assignmentId: string) =>
    client.get(`/sop/assignments/${assignmentId}`) as Promise<{
      assignment: SopAssignment;
      clarifications: SopClarification[];
    }>,
  /** 人工回复澄清（P6 升级环收口：与中台 Agent 共用同一道服务层闸门）。 */
  replyClarification: (
    assignmentId: string,
    clarificationId: string,
    data: {
      resolution: 'answered' | 'sop_amended';
      answer: string;
      amendedFrontMatterYaml?: string;
      amendedBodyMarkdown?: string;
      changelog?: string;
    },
  ) =>
    client.post(
      `/sop/assignments/${assignmentId}/clarifications/${clarificationId}/reply`,
      data,
    ) as Promise<{ ok: boolean; newSopVersion?: string }>,
  /** 指派可选执行器（租约内 agent:sop 的机器；空 = 没有机器开着 Agent）。 */
  listAssignableExecutors: () =>
    client.get('/sop/assignable-executors') as Promise<AssignableExecutor[]>,
  /** 指派的媒体清单（截图/录屏）。 */
  assignmentMedia: (assignmentId: string) =>
    client.get(`/sop/assignments/${assignmentId}/media`) as Promise<SopMedia[]>,
  /**
   * 查看媒体：blob 请求 + objectURL 新开页（直链无法携带鉴权头会 401，
   * 与 artifacts 的 download() 同一写法；浏览器能内联显示 png/webm）。
   */
  viewMedia: async (mediaId: string): Promise<void> => {
    const blob = await client.get<Blob>(`/sop/media/${mediaId}`, {
      responseType: 'blob',
    } as never);
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
};
