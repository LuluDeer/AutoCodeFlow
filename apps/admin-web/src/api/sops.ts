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
  /** 机器验收状态（切片 D1）：null=迁移前存量行，无验收语义。 */
  verificationStatus: 'unverified' | 'passed' | 'failed' | 'unclear' | null;
  /** 验收复核会话锚；spawn 失败 fail-closed 路径为 null。 */
  verificationSessionId: string | null;
  /** 验收结论落定时间（unverified 恒为 null）。 */
  verificationCheckedAt: string | null;
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
   * ## 响应形状：**合同派生**（`SopPendingClarificationsResponse`）
   *
   * 曾有一段时期 `types/generated/api-types.ts` 里还没有这个 schema，于是形状内联在
   * 方法返回注解上（当时若写顶层手写副本会同时踩 `check:web-type-drift` 与
   * `check:web-type-field-drift` 两道棘轮）。**生成物已重生成**，现在文件顶部的
   * `SopPendingClarificationsResponse = components['schemas'][…]` 就是唯一事实源。
   *
   * ⚠️ 别再退回内联：手写形状与生成物同名同义却互不约束，后端改字段名时 tsc 照样绿、
   * 前端静默读到 `undefined`——那正是这两道棘轮在挡的东西。
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
   * ## `hours`：曾是欠账，已回收（R287 收口，2026-11-20）
   *
   * - **运行期**：可选。`@Query("hours") hours?: string`，缺省/非法由 service 的
   *   `clampLagHours` 回落默认，**绝不 400**；
   * - **生成物**：`required: false` + description + `x-i18n-en`（controller 补了
   *   `@ApiQuery({ required:false })`，主会话重导出了 `openapi.json`）；
   * - **`check-query-param-required.mjs`**：原先登记本站点为 `runtime-optional`
   *   欠账，生成物对齐后该条已被**自动回收**（守卫判「陈旧登记」并勒令删除）。
   *
   * ⇒ 三方现在同向：接口可选。**若哪天有人把这里改回必填**，请先确认生成物仍是
   * `required:false`——把误标固化进消费方，比误标本身更坏（回收掉之后前端会反向不一致）。
   *
   * ⚠️ 生成物的 `hours` 类型是 `string`（HTTP query 参数一律是字符串），本方法是
   * `number`。这不矛盾也不需要转换：本模块**不走** generated client（只用
   * `components['schemas']` 取响应体），`params` 由 `client` 交给 axios 序列化。
   * 若将来改用 `operations[...]` 的 typed client，这里就得改成 `String(hours)`。
   *
   * ## 为什么不写 `hours ?? 24`
   *
   * 那会让「24」在仓库里出现两处（`SOP_BLOCKED_WINDOW_HOURS` 与这里），常量一改
   * 方法就静默用旧窗口——而窗口是**筛选条件**，它改变「哪些工单出现在本节」且
   * **不报错**。不传 = 真的不带这个 query 参数（由 service 决定默认），而不是假装传了 24。
   *
   * 「窗口由谁定」只有一个答案：**调用点**（`api/inbox.ts` 传常量）。这样即使
   * 服务端默认值将来漂移，本前端也不会静默跟随。
   */
  laggingAssignments: (hours?: number, signal?: AbortSignal) =>
    client.get('/sop/assignments/lagging', {
      // 不传就不带这个参数：让「谁决定窗口」只由**调用点**回答一次。
      params: hours === undefined ? {} : { hours },
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
  /**
   * R289：取消单条未结束的指派（assigned / in_progress / blocked / stalled）。
   *
   * 入参/响应体直接派生自 OpenAPI 生成物，避免手写副本漂移；空 reason 不发该键（发 `{}`）。
   */
  cancelAssignment: (
    assignmentId: string,
    data?: components['schemas']['CancelSopAssignmentDto'],
  ) => {
    const trimmed = data?.reason?.trim();
    const payload: components['schemas']['CancelSopAssignmentDto'] = trimmed
      ? { reason: trimmed }
      : {};
    return client.post(
      `/sop/assignments/${assignmentId}/cancel`,
      payload,
    ) as Promise<components['schemas']['SopCancelAssignmentResponseDto']>;
  },
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
