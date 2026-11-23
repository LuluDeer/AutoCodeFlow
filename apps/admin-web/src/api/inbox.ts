/**
 * P1-4 · 待办收件箱聚合层。
 *
 * 把原本分散在四个入口的待办收成一组统一视图：
 *   1. 部署审批待办（`GET /app-deployments/approvals/pending`）；
 *   2. Agent 会话等待审批（挂起在 waiting_input、有待处置审批单）；
 *   3. Agent 会话等待人工输入/澄清（waiting_input 会话）；
 *   4. **Agent 会话失败**（R279：`failed` + `budget_exceeded`，时间窗内）；
 *   5. **待人工答复的 SOP 澄清**（R280：`escalated_to_human` 且指派未终态）；
 *   6. 卡住会话（running 且久无进展，`stalled=1`）；
 *   7. 调度积压（pending 但队列里没有对应 job，`backlogged`）；
 *   8. 队列停摆观测（`queue-stall`，结构性告警横幅，不是逐条待办）；
 *   9. 最近失败（复用 `/metrics/failures`，只读跳转，不在这里处置）。
 *
 * ## R280：为什么必须新增第 9 个面（「升级到人工」没有接收方）
 *
 * `sop_clarifications.resolution = 'escalated_to_human'` 是**真实存在**的状态，且
 * 唯一出口是通知（`notifyEscalation`）。三条通道同时不可靠：
 * ① 收件箱前八节没有一节会显示它；② 升级后 assignment 被立刻推回 `in_progress`
 * （「升级即复核完毕」），所以**按 `status=blocked` 永远筛不到**；③ 那条通知可被
 * `scope=global` 的静默规则无条件吞掉（`notifyEscalation` 没传 `taskId`）。
 * ⇒ 前端读库（`GET /sop/clarifications/pending`），不受通知静默规则影响。
 *
 * 口径（brief D1）：
 * - **计入**：`resolution='escalated_to_human'` 且所属指派未终态（非 completed/failed/cancelled）；
 * - **不计入** `resolution IS NULL`（那是等执行器/复核 Agent 的，不是等人）；
 * - **无时间窗**：升级澄清没处理就一直挂着 ⇒ 用窗口会让「上周升级还没人管」静默消失。
 *
 * ## R279：为什么必须新增第 8 个面（不是「读数错了」，是「没建模」）
 *
 * 旧七个小节里，前六项只看 `pending` / `waiting_input` / `running` 这些**非终态**；
 * 唯一的「失败」小节 `recentFailures` 查的是 `task_executions`（任务执行），
 * **不是** `agent_sessions`。⇒ `failed` / `budget_exceeded` 一个都不进任何观测面，
 * 计数确实全 0——**真实的 0 掩盖了「有 3 条失败等你处理」**。
 * 这类缺陷比谎报更隐蔽：它不是读到 0 报成 0，而是「没数过的东西永远不出现」。
 *
 * ## 诚实口径（沿用本仓 R188–R203 徽标同款纪律）
 *
 * - 每个小节独立装载：某一类读失败**不拖垮**其他小节，失败小节保留「未知」态
 *   （`status: 'error'`），绝不渲染成 0 条；
 * - 顶栏按等待会话数（含待审批）计一次；任一参与计数的数据源读不到 ⇒ 总计数 `null`，
 *   不用其余小节的局部和谎报「一共 N 件」；
 * - 时间字段缺失时行内明确显示「无时间信息」，不猜。
 *
 * ## R278（U1/U2/U4/U5）：聚合搬到服务端
 *
 * 旧实现的根因是「先拉 50 个会话，再逐个 `listApprovals`」——N+1 请求共用一个
 * 60/min 全局限流桶（第 51 个必被 429），且截断**无标记**（U2「凭空消失」）。
 * 现在：
 * - `loadAgentWaiting` 用**一次** `GET /agent/approvals/pending` 取全库待审批单
 *   （`listApprovals` 一次都不再调用），会话列表仍只发 1 次；
 * - `loadInboxCounts` 用**一次** `GET /agent/inbox/counts` 拿全（取代 5 个分散请求）；
 * - 任何「取了 N 条但不保证是全部」的小节都带 `truncated` + `total`，
 *   页面据 D2 显式渲染「显示前 N 条（共 M 条）」；
 * - 字段 `null` = **读不到（未知）**，绝不等于 0（D3）；整体不可用时后端 503。
 *
 * 写动作不在本层执行：页面直接复用 `deploymentsApi` / `agentApi` 的既有写接口
 * （后端 `@Roles(ADMIN)` + 第二人规则仍是权威门控）。
 */
import type { useTranslation } from 'react-i18next';
import { agentSessionUrl } from '../utils/agentSessionUrl';
import { client } from './client';
import {
  agentApi,
  type AgentApproval,
  type AgentPendingApprovalsResponse,
  type AgentPendingApprovalRow,
  type AgentSession,
} from './agent';
import { deploymentsApi, type AppDeployment } from './applications';
import { metricsApi, type RecentFailure } from './metrics';
import { sopsApi } from './sops';
import type { components } from '../types/generated/api-types';

/** 待办变更后通知顶栏徽标重取计数的窗口事件名。 */
export const INBOX_REFRESH_EVENT = 'autoflow:inbox-refresh';

/** 收件箱小节键（R286 起十个小节；`sopBlocked` 追加在 `sopClarifications` 之后）。 */
export const INBOX_SECTIONS = [
  'deployments',
  'agentApprovals',
  'agentWaiting',
  'agentFailures',
  'sopClarifications',
  // R286：阻塞工单——与「待答复澄清」相邻但不合并：澄清是「机器问了没人答」，
  // 本节是「工单卡在 blocked、且已超过 TTL」（后端升级到 stalled 之前的可见面）。
  'sopBlocked',
  'stalled',
  'backlogged',
  'queueStall',
  'recentFailures',
] as const;

export type InboxSectionKey = (typeof INBOX_SECTIONS)[number];

/**
 * 单次小节装载上限。
 *
 * 与后端钳制对齐（不另造数字）：agent 会话 `pageSize` 钳到 **100**
 * （`agent-pagination.ts`），部署 DTO `pageSize` 上限也是 **100**。
 * R278/U4：旧值 50 是「第 51 个凭消失」的直接原因。
 */
export const SECTION_PAGE_SIZE = 100;

/** 归一化后的一条待办。原始引用保留，供页面按小节取动作所需字段。 */
export interface InboxItem {
  id: string;
  section: InboxSectionKey;
  /** 对象标题（应用名 / 会话标题 / 任务名）。 */
  title: string;
  /** 副标题：申请者 / 发起人 / 触发来源等。 */
  subtitle?: string;
  /** 等待起始时间（ISO）；null = 无时间信息。 */
  waitingSince: string | null;
  /** 详情深链（原对象页）。 */
  detailUrl?: string;
  /** 已确认可尝试恢复；无待批单的 waiting_input 或补全了对象的积压 pending。 */
  canResume?: boolean;
  deployment?: AppDeployment;
  session?: AgentSession;
  approval?: AgentApproval;
  failure?: RecentFailure;
  /**
   * R279/agentFailures：失败原因**原文**（未截断）。
   *
   * 行内展示用 `subtitle`（已截断，见 `truncateFailureReason`），这里保留原文供
   * 悬停/后续扩展；缺省 `undefined` = 会话没有 `errorMessage`（**不编造原因**）。
   */
  errorMessage?: string;
  /**
   * R280/sopClarifications：该行对应的 SOP 澄清（原文未截断）。
   *
   * 行内展示用 `title`（已截断的 `question`）+ `subtitle`（SOP 名 · 第 N 轮）；
   * 这里保留原文，供后续「点开看全文」与答复动作定位（`clarificationId`/`assignmentId`）。
   */
  clarification?: {
    clarificationId: string;
    assignmentId: string;
    sopId: string;
    sopName: string | null;
    round: number;
    question: string;
    askedAt: string;
    assignmentStatus: string;
    reviewSessionId: string | null;
  };
  /**
   * R286/sopBlocked：该行对应的**阻塞工单**（契约原文，未截断/未改写）。
   *
   * **合同派生**（`components['schemas']['SopAssignmentLagItemDto']`），不手写形状：
   * 生成物里已有该 schema（R286 后端 DTO 落盘后重生成过），手写副本与它同名同义
   * 却互不约束——后端改字段名时 tsc 照样绿、前端静默读到 `undefined`
   * （`check:web-type-drift` / `check:web-type-field-drift` 两道棘轮就是防这个）。
   *
   * 字段语义以生成物注释为权威，这里只记两条与渲染直接相关的：
   * - `round` 是**触顶/卡住的那一轮**（maxRounds=5 触顶 ⇒ 6），不是「当前轮次」；
   *   `null` ⇔ 无可用 escalated 澄清 ⇒ 渲染「第 — 轮」，不编 1。
   * - `blockedSince` 恒有值，且**不是**查询窗口 `hours`——行内「已阻塞 X 小时」
   *   由 `blockedHours()` 与当前时间现算。
   */
  blockedAssignment?: components['schemas']['SopAssignmentLagItemDto'];
}

/** 单个小节的装载状态。 */
export interface InboxSectionState {
  key: InboxSectionKey;
  status: 'loading' | 'ready' | 'error';
  items: InboxItem[];
  error: unknown;
  /**
   * 本小节是否「取了 N 条但不保证是全部」（D2，R278 起所有有上限的小节都要带）。
   *
   * ⚠️ backlogged 的 `truncated` 说的是**对账探针**有上限（`BACKLOG_PROBE_LIMIT`
   * 条 pending 会话），**不是**「列表显示有上限」：被截的是「能确认多少」，
   * 不是「渲染多少」。所以它的 M 是**下界**，见 `describeBacklogCount`。
   */
  truncated?: boolean;
  /**
   * 本次实际对账（探测）了多少条 pending 会话（仅 backlogged）。
   * `null` / `undefined` = **读不到**（旧后端或缺字段的替身），不是 0。
   */
  probed?: number | null;
  /** 队列停摆快照（仅 queueStall 小节携带）。 */
  snapshot?: QueueStallSnapshot | null;
  /**
   * 该小节的总条数（服务端权威计数）。
   * - `number`：真实总数（可能 > 已取条数 ⇒ 配合 `truncated` 渲染「共 M 条」）；
   * - `null`：**读不到（未知）**，页面显示「—」，绝不显示 0；
   * - `undefined`：该小节没有总数字段（如 recentFailures），页面回落已取条数。
   *
   * ⚠️ **backlogged 例外（R285）**：这里装的是服务端 `count` = 「对账探针在
   * `BACKLOG_PROBE_LIMIT` 条 pending 里**已探到**的积压数」。`truncated` 时它是
   * **下界**（不是总数）⇒ 渲染必须走 `describeBacklogCount`，说成「共 M 条」就是把
   * 下界冒充总数（R279 教训）。
   */
  total?: number | null;
  /**
   * R279：**行集合**的总数（与服务端 `total` 的**口径**可能不同）。
   *
   * `agentFailures` 是唯一用到它的小节，且它存在的理由就是那句「口径不同」：
   * `total` 来自 `inbox/counts.failedSessions`（**failed + budget_exceeded**，
   * 这是「有几条等你处理」），而本小节的**行**只列 `status=failed`
   * （`budget_exceeded` 的处置路径不同）——两者相减不是「被截掉的条数」，
   * 而是**根本不在本列表里的另一类**。
   *
   * ⇒ 截断判定与「显示前 N 条（共 M 条）」里的 M 必须走 `rowTotal`，
   * 不能拿 `total` 冒充：否则「计数 5、列表 3」会被渲染成「3 条里有 2 条没显示」，
   * 把「口径不同」伪装成「显示不全」（两种缺陷形态不同，不能互相顶替）。
   */
  rowTotal?: number | null;
  /** R279：失败小节的时间窗（小时）。供标题渲染「近 {{hours}} 小时」。 */
  windowHours?: number;
  /** 服务端实际返回的条数（= 已取条数，用于「显示前 N 条」的 N）。 */
  returned?: number;
  /** 服务端聚合的部分失败标记：数字仍是**下界**，不是事实。 */
  degraded?: boolean;
}

export type InboxSections = Record<InboxSectionKey, InboxSectionState>;


/** 顶栏计数口径：`null` 表示没有独立计数或读取失败，均不等于 0。 */
export type InboxCountMap = Record<InboxSectionKey, number | null>;

/**
 * 「全部读不到」——整体不可用时的**唯一**回落值（R278/D3）。
 *
 * 刻意用 `Record` + `INBOX_SECTIONS` 逐键生成：新增小节时它自动跟上，
 * 不会因为忘了加一行而让新小节静默变成 0（那正是本轮要消灭的缺陷形态）。
 */
export function unknownCounts(): InboxCountMap {
  return Object.fromEntries(INBOX_SECTIONS.map((key) => [key, null])) as InboxCountMap;
}

const READY = (key: InboxSectionKey, items: InboxItem[], extra?: Partial<InboxSectionState>): InboxSectionState => ({
  key,
  status: 'ready',
  items,
  error: null,
  ...extra,
});

const ERROR = (key: InboxSectionKey, error: unknown): InboxSectionState => ({
  key,
  status: 'error',
  items: [],
  error,
});

/**
 * 「取了 N 条但不保证是全部」的唯一口径（D2）。
 *
 * ## 三态各自只说自己的事（R278 主会话裁决，对齐 brief §四）
 *
 * - 总数已知（number）⇒ `truncated = returned < total`；
 * - **总数未知（null）⇒ `truncated = false`**，因为「是否截断」本身不可知——
 *   那件事由 `degraded` 表达。让 truncated 在未知时取 true，会把「未知」
 *   伪装成「已截断（且共 M 条）」这种**具体**事实，两者是不同缺陷形态；
 * - 「未知」的可见性由页面承担：`total === null` ⇒ 标题「—」+ 降级提示，
 *   绝不回落成 `items.length` 或 0。
 */
export function metaOf(
  returned: number,
  rawTotal: number | null | undefined,
): { total: number | null; returned: number; truncated: boolean } {
  const total = typeof rawTotal === 'number' && Number.isFinite(rawTotal) ? rawTotal : null;
  if (total === null) return { total: null, returned, truncated: false };
  return { total, returned, truncated: returned < total };
}

// ── 各小节装载器 ──────────────────────────────────────────────────────────────

interface PendingDeploymentsResponse {
  data: AppDeployment[];
  /** 后端 `findAll` 的 `total`（R278 已确认该端点**确实返回** total，无需编造）。 */
  total: number;
}

/**
 * 1. 部署审批待办。
 *
 * R278/U5：显式 `pageSize=100`（旧实现不传 ⇒ controller 默认 20 ⇒ 第 21 条起静默消失）。
 * 后端返回 `total`，故超出部分可被**如实**标记为截断，而不是静态文案。
 */
async function loadDeployments(
  signal?: AbortSignal,
): Promise<{ items: InboxItem[]; total: number | null; returned: number; truncated: boolean }> {
  const res = await client.get<PendingDeploymentsResponse>('/app-deployments/approvals/pending', {
    ...(signal ? { signal } : {}),
    params: { page: 1, pageSize: SECTION_PAGE_SIZE },
  });
  const rows = res?.data ?? [];
  const items = rows.map((d) => ({
    id: `dep-${d.id}`,
    section: 'deployments' as const,
    title: d.application?.name || d.applicationId,
    subtitle: d.approvalMeta?.requestedByName ?? undefined,
    waitingSince: d.approvalMeta?.requestedAt ?? d.createdAt ?? null,
    detailUrl: `/applications/${d.applicationId}`,
    deployment: d,
  }));
  return { items, ...metaOf(items.length, res?.total) };
}

/**
 * 用契约行造一个**够用即可**的会话对象。
 *
 * 为什么需要：行内动作（拒绝审批单 / 深链）只用到 `session.id` 与 `session.title`，
 * 而 `InboxRowActions` 与 `handleDeny` 的判据是「有没有 session」。契约
 * `GET /agent/approvals/pending` 只回 `sessionId` / `sessionTitle`（不重复回整个
 * 会话对象）⇒ 这里按同一批字段拼出**同样诚实**的最小对象：标题缺失时保留
 * `null`（不编造），不把任何未知字段填成事实。
 */
function approvalSessionStub(row: AgentPendingApprovalRow): AgentSession {
  return {
    id: row.sessionId,
    kind: '',
    status: 'waiting_input',
    title: row.sessionTitle,
    triggerSource: '',
    createdBy: null,
    parentSessionId: null,
    contextJson: null,
    scopeJson: null,
    budgetJson: null,
    resultJson: null,
    summary: null,
    errorMessage: null,
    totalSteps: 0,
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalToolCalls: 0,
    waitingFor: null,
    startedAt: null,
    finishedAt: null,
    createdAt: row.createdAt,
    updatedAt: row.createdAt,
  };
}

/** 契约行 → 页面行内动作需要的审批单对象（只填契约里真实存在的字段）。 */
function pendingApprovalOf(row: AgentPendingApprovalRow): AgentApproval {
  return {
    id: row.approvalKey,
    approvalKey: row.approvalKey,
    sessionId: row.sessionId,
    toolName: row.toolName,
    reason: row.reason ?? '',
    status: 'pending',
    decidedBy: null,
    decidedAt: null,
    consumedAt: null,
    createdAt: row.createdAt,
  };
}

/**
 * 读全库待审批单（一次请求）。
 *
 * 用 `{ ok, value | error }` 显式二分而不是抛：调用方要**同时**保留「读失败」与
 * 「读到了但是降级」两种不同事实（前者 SECTION error 态，后者 total:null + degraded）。
 * 这个结构是**本文件内部的读结果信封**、不映射任何合同 DTO，故刻意不导出。
 */
function readPendingApprovals(signal?: AbortSignal): Promise<{ ok: true; value: AgentPendingApprovalsResponse } | { ok: false; error: unknown }> {
  return agentApi.listPendingApprovals(SECTION_PAGE_SIZE, signal).then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
}

function readWaitingSessions(signal?: AbortSignal): Promise<
  { ok: true; value: { items: AgentSession[]; total: number } } | { ok: false; error: unknown }
> {
  return agentApi.list({ status: 'waiting_input', page: 1, pageSize: SECTION_PAGE_SIZE }, signal).then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
}

/**
 * 2+3. Agent 等待人工：审批单 + 等待输入会话。
 *
 * R278/U1：**不再**逐会话 `listApprovals`（N+1 ⇒ 429）。审批单来自一次
 * `GET /agent/approvals/pending`，会话列表仍是一次 `GET /agent/sessions`。
 *
 * ⚠️ `canResume` 的前提是「**确定**没有待批单」。审批单被截断 / 降级 / 总数未知时
 * 无法断言某会话没有待批单 ⇒ 一律不给「接管/恢复」（未知不等于没有）。
 */
async function loadAgentWaiting(signal?: AbortSignal): Promise<{ approvals: InboxSectionState; sessions: InboxSectionState }> {
  // 两个源各自独立失败：一个挂不拖垮另一个（既有「小节互相隔离」纪律）。
  const [pending, sessionsRes] = await Promise.all([
    readPendingApprovals(signal),
    readWaitingSessions(signal),
  ]);

  // ── 审批单小节 ──
  let approvalSection: InboxSectionState;
  let approvalsCertain = false;
  let approvalSessionIds = new Set<string>();
  if (!pending.ok) {
    approvalSection = ERROR('agentApprovals', pending.error);
  } else {
    const res: AgentPendingApprovalsResponse | undefined = pending.value;
    const rows = res?.items ?? [];
    const meta = metaOf(rows.length, res?.total);
    // 服务端是截断判定的权威（它看得见全库）；本地 meta 只兜「服务端没给该字段」的
    // 旧后端形态，两者同口径：total 未知 ⇒ false，未知由 degraded 表达。
    const truncated = res?.truncated ?? meta.truncated;
    const degraded = !!res?.degraded;
    approvalsCertain = !truncated && !degraded && res?.total != null;
    approvalSessionIds = new Set(rows.map((r) => r.sessionId));
    approvalSection = READY('agentApprovals', rows.map((row) => {
      const session = approvalSessionStub(row);
      return {
        id: `apr-${row.approvalKey}`,
        section: 'agentApprovals' as const,
        // 标题缺失留空串，由页面层回落「未命名会话」文案；**绝不退回 sessionId**（uuid 不可读）。
        title: row.sessionTitle ?? '',
        subtitle: row.toolName,
        waitingSince: row.createdAt ?? null,
        detailUrl: agentSessionUrl(row.sessionId, { tab: 'approvals', approvalKey: row.approvalKey }),
        session,
        approval: pendingApprovalOf(row),
      };
    }), { total: meta.total, returned: meta.returned, truncated, degraded });
  }

  // ── 等待输入会话小节 ──
  let sessions: InboxSectionState;
  if (!sessionsRes.ok) {
    sessions = ERROR('agentWaiting', sessionsRes.error);
  } else {
    const list = sessionsRes.value;
    const items = (list?.items ?? []).map((s) => ({
      id: `ses-${s.id}`,
      section: 'agentWaiting' as const,
      // 标题缺失留空串，由页面层回落类型标签/未命名文案；**绝不退回 sessionId**。
      title: s.title ?? '',
      subtitle: s.waitingFor || s.createdBy || s.kind,
      waitingSince: s.createdAt ?? null,
      detailUrl: agentSessionUrl(s.id, {
        status: 'waiting_input',
        tab: approvalSessionIds.has(s.id) ? 'approvals' : undefined,
      }),
      canResume: s.status === 'waiting_input' && approvalsCertain && !approvalSessionIds.has(s.id),
      session: s,
    }));
    sessions = READY('agentWaiting', items, metaOf(items.length, list?.total));
  }

  return { approvals: approvalSection, sessions };
}

// ── 4. Agent 会话失败（R279 新增小节） ────────────────────────────────────────

/**
 * 失败小节的时间窗（小时）默认值。
 *
 * 后端 `AGENT_FAILED_SESSION_WINDOW_HOURS` 的默认值就是 24（brief D1）；这里是
 * **配置读不到时的回落**，不是事实 ⇒ 后端不给 `failedWindowHours` 时用它，
 * 而不是把窗口当成 0/无限（前者会漏数、后者会把全 history 塞进「今天要处理的」）。
 */
export const AGENT_FAILED_WINDOW_HOURS_DEFAULT = 24;

/** 失败原因行内展示的截断长度（D4：一眼可见原因，又不让一行吃掉整块屏）。 */
export const FAILED_REASON_MAX_CHARS = 120;

/**
 * 失败原因截断（纯函数）。
 *
 * `null` / 空白 ⇒ `undefined`（**不编造原因**，页面自行显示「未记录失败原因」）；
 * 超长 ⇒ 截到 `limit` 并加省略号——省略号是「后面还有」的可视证据，
 * 不是装饰：没有它，截断后的文本会被读成「原因就这么短」。
 */
export function truncateFailureReason(
  text: string | null | undefined,
  limit: number = FAILED_REASON_MAX_CHARS,
): string | undefined {
  const raw = (text ?? '').trim();
  if (!raw) return undefined;
  return raw.length <= limit ? raw : `${raw.slice(0, limit)}…`;
}

/** 时间窗起点（ISO）。纯函数：注入 `now` 让单测能钉住窗口边界。 */
export function failedWindowSince(hours: number, now: number = Date.now()): string {
  const safeHours = Number.isFinite(hours) && hours > 0 ? hours : AGENT_FAILED_WINDOW_HOURS_DEFAULT;
  return new Date(now - safeHours * 3_600_000).toISOString();
}

/**
 * 读收件箱计数 + 失败小节的时间窗（一次请求）。
 *
 * `failedSessions` / `failedWindowHours` 是 S1 契约新增字段，尚未进
 * `types/generated/api-types.ts`（生成物由主会话统一收）。这里用**局部**交叉视图读，
 * 而不是新增手写合同类型（`check-web-type-drift` 的棘轮、以及「合同派生」纪律）。
 *
 * ⚠️ 字段缺失（旧后端）⇒ `failedSessions` 得 `undefined` ⇒ 按 `null`（**读不到**）处理：
 * 若在这里回落 0，「未建模」的缺陷就会原样复现成「读不到伪装成没有」。
 */
async function readInboxCounts(
  signal?: AbortSignal,
): Promise<{ counts: InboxCountMap; windowHours: number }> {
  const fallback = { counts: unknownCounts(), windowHours: AGENT_FAILED_WINDOW_HOURS_DEFAULT };
  try {
    const raw = (await agentApi.inboxCounts(signal)) as unknown as
      | (Record<string, unknown> & { failedSessions?: number | null; failedWindowHours?: number })
      | undefined;
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const hours = num(raw?.failedWindowHours);
    return {
      counts: {
        deployments: num(raw?.deployments),
        agentApprovals: num(raw?.pendingApprovals),
        agentWaiting: num(raw?.waitingSessions),
        agentFailures: num(raw?.failedSessions),
        stalled: num(raw?.stalled),
        backlogged: num(raw?.backlogged),
        queueStall: num(raw?.queueStall),
        // R280：`inbox/counts` **没有**这个字段（后端本轮契约冻结），占位 null；
        // `loadInboxCounts` 会用 `pending` 的 `total` 覆写它。这里写 null 而不是 0，
        // 是因为「本端点不提供」不等于「事实为零」。
        sopClarifications: null,
        // R286：同理，`loadInboxCounts` 会用 `lagging` 的 `total` 覆写。
        sopBlocked: null,
        recentFailures: null,
      },
      // 窗口是**配置**不是事实 ⇒ 读不到时回默认值（与「计数读不到 = null」不同）。
      windowHours: hours !== null && hours > 0 ? hours : AGENT_FAILED_WINDOW_HOURS_DEFAULT,
    };
  } catch {
    return fallback;
  }
}

/**
 * 4. Agent 会话失败（R279）。
 *
 * ## 行数据只取 `failed`，计数含 `budget_exceeded` —— 刻意的，别「顺手对齐」
 *
 * - **计数**（`inbox/counts.failedSessions`）含 `failed` + `budget_exceeded`：
 *   运营先要知道「今天有几条等我处理」（D1）；
 * - **行**（`status=failed`）只要 `failed`：`budget_exceeded` 的处置路径不同
 *   （改预算/换模型再重跑，不是「看看错在哪」），混进同一列表会让每行的动作按钮
 *   说两种话（D2 同款理由）；
 * - 两者之差**不是**「被截掉的条数」，而是另一类会话 ⇒ 截断判定走 `rowTotal`，
 *   差值由 `budgetExcluded` 告警单独说明（`sectionNotices`）。
 *
 * 若哪天有人把行也改成 `status IN ('failed','budget_exceeded')`，或把计数收窄成只数
 * `failed`，都必须同时改这里、`readInboxCounts` 与后端，否则「计数 5、列表 3」
 * 会变成两个都不解释的数字。
 *
 * `aborted` 两侧都不计入：那是人主动停的，不是待办。
 */
async function loadAgentFailures(signal?: AbortSignal): Promise<InboxSectionState> {
  // ⚠️ 顺序是**刻意**的（一次串行换一条诚实）：计数先回来，才知道配置的窗口是几小时。
  // 若并行发两路、行固定用默认 24h，而配置是 48h，则「计数 5 / 行 2」里混进了
  // **两种**原因（预算耗尽 + 窗口差）；下方 budgetExcluded 告警会把它们一律说成
  // 「预算耗尽」——一条数字对、结论错的假事实。宁可多一次往返。
  const { counts, windowHours } = await readInboxCounts(signal);
  const rows = await agentApi.listFailedSessions({
    since: failedWindowSince(windowHours),
    page: 1,
    pageSize: SECTION_PAGE_SIZE,
  }, signal);
  const items = (rows?.items ?? []).map((s) => ({
    id: `fail-${s.id}`,
    section: 'agentFailures' as const,
    title: s.title || s.id,
    subtitle: truncateFailureReason(s.errorMessage),
    // 失败会话的「发生时刻」：优先 finishedAt（真正失败那一下），缺则 createdAt。
    waitingSince: s.finishedAt ?? s.createdAt ?? null,
    detailUrl: agentSessionUrl(s.id, { status: 'failed' }),
    errorMessage: s.errorMessage ?? undefined,
    session: s,
  }));
  const rowMeta = metaOf(items.length, rows?.total);
  return READY('agentFailures', items, {
    // 计数口径（含 budget_exceeded）：决定「—」与「隐藏」。
    total: counts.agentFailures,
    // 行集合口径：决定「显示前 N 条（共 M 条）」的 M 与 truncated。
    rowTotal: rowMeta.total,
    returned: rowMeta.returned,
    truncated: rowMeta.truncated,
    degraded: counts.agentFailures === null || rowMeta.total === null,
    windowHours,
  });
}

// ── 5. 待人工答复的 SOP 澄清（R280 新增小节） ────────────────────────────────

/** 澄清问题行内展示的截断长度（brief §四：`question` 截断 120 字符 + 省略号）。 */
export const CLARIFICATION_QUESTION_MAX_CHARS = 120;

/**
 * 澄清问题截断（纯函数，与 `truncateFailureReason` 同款口径）。
 *
 * 省略号是「后面还有」的可视证据，不是装饰：没有它，截断后的文本会被读成
 * 「执行器就问了这么一句」。原文**不丢**（保留在 `item.clarification.question`），
 * 服务端也刻意不截断（服务端截断会让「点开看全文」永远拿不到全文）。
 */
export function truncateClarificationQuestion(
  text: string | null | undefined,
  limit: number = CLARIFICATION_QUESTION_MAX_CHARS,
): string {
  const raw = (text ?? '').trim();
  if (raw.length <= limit) return raw;
  return `${raw.slice(0, limit)}…`;
}

/**
 * 待答复澄清的深链。
 *
 * 指向 `SopsPage` 的查询参数深链：`/sops?sop=<sopId>&assignment=<assignmentId>`。
 * 携带 `assignmentId` 时 `SopsPage` 自动打开该 SOP 抽屉并直达「指派与澄清」Tab、
 * 高亮目标指派及其澄清；未传 `assignmentId` 时回落为 `/sops?sop=<sopId>`。
 */
export function sopClarificationUrl(sopId: string, assignmentId?: string): string {
  const params = new URLSearchParams({ sop: sopId });
  if (assignmentId) params.set('assignment', assignmentId);
  return `/sops?${params}`;
}

/**
 * 5. 待人工答复的 SOP 澄清（R280）。
 *
 * ## 数据源唯一，计数与行出自**同一个** `pending` 响应
 *
 * 后端只有一个读面（brief D2：`GET /sop/clarifications/pending`），没有往
 * `inbox/counts` 里加字段——本轮后端契约已冻结。所以本小节与顶栏计数都从它取：
 * 这里取行 + `total`，`loadInboxCounts` 只取 `total`。**不为此多开端点**。
 *
 * ## `total` / `truncated` / `degraded` 的三态（与后端逐字对齐）
 *
 * - `total: null` ⇒ 读不到 ⇒ 保留本节、标题显示「—」+ 降级提示，**绝不 0**；
 * - `total: 0` ⇒ 事实为零 ⇒ 整节隐藏（`isSectionVisible`）；
 * - `truncated` 以**服务端**为权威（它看得见全库）；缺字段的旧后端才回落本地
 *   `metaOf`，且回落时 `total` 未知 ⇒ `false`（未知由 `degraded` 表达）。
 *
 * ## 无时间窗
 *
 * 与失败会话不同：升级澄清没处理就一直挂着，用窗口会让「上周升级还没人管」
 * **静默消失**——那正是最该被看见的东西（brief D1）。
 */
async function loadSopClarifications(signal?: AbortSignal): Promise<InboxSectionState> {
  const res = await sopsApi.pendingClarifications(SECTION_PAGE_SIZE, signal);
  const rows = res?.items ?? [];
  const items = rows.map((row) => {
    const question = truncateClarificationQuestion(row.question);
    return {
      id: `sopc-${row.clarificationId}`,
      section: 'sopClarifications' as const,
      // 标题 = 执行器的原始疑问（截断后）；它才是「要我答什么」。
      title: question,
      // 副标题只放**原文**（SOP 名 / null），前缀与「第 N 轮」由页面本地化拼装——
      // API 层不拼自然语言（与 deployments 的提交者前缀同款分工）。
      subtitle: row.sopName ?? undefined,
      // 「何时开始等我」= 提问时刻。这里恰是「越久越该在前面」的那个时间。
      waitingSince: row.askedAt ?? null,
      detailUrl: sopClarificationUrl(row.sopId, row.assignmentId),
      clarification: row,
    };
  });
  const meta = metaOf(items.length, res?.total);
  return READY('sopClarifications', items, {
    total: meta.total,
    returned: meta.returned,
    // 服务端是截断判定的权威；缺字段才回落本地口径（同 `loadAgentWaiting`）。
    truncated: res?.truncated ?? meta.truncated,
    degraded: !!res?.degraded,
  });
}

/**
 * 顶栏「待答复澄清 N」的计数（独立读一次 `pending` 的 `total`）。
 *
 * 为什么允许这次额外请求：`inbox/counts` 里**没有**这个字段（后端本轮冻结）。
 * 编一个本地 0 才是真正不可接受的——那会把「没读过」伪装成「没有」。
 * 读失败 / 503 ⇒ `null`（未知），绝不回落 0。
 */
async function readSopClarificationTotal(signal?: AbortSignal): Promise<number | null> {
  try {
    const res = await sopsApi.pendingClarifications(SECTION_PAGE_SIZE, signal);
    const total = res?.total;
    return typeof total === 'number' && Number.isFinite(total) ? total : null;
  } catch {
    return null;
  }
}

/**
 * R286：`sopBlocked` 的筛选窗口（小时）。**只用于请求，不用于行内时长**。
 *
 * 与后端默认值一致（24）；显式传而不是省略，是为了让「窗口是 24」这件事在
 * 调用点可见——若有天后端改默认值，这里是显式的 24 而非静默跟随。
 */
export const SOP_BLOCKED_WINDOW_HOURS = 24;

/**
 * 阻塞工单的深链。
 *
 * 指向 `SopsPage` 的查询参数深链：`/sops?sop=<sopId>&assignment=<assignmentId>`。
 * 携带 `assignmentId` 时 `SopsPage` 自动打开该 SOP 抽屉并切到「指派与澄清」Tab、
 * 高亮并滚动定位到该条指派；未传 `assignmentId` 时回落为 `/sops?sop=<sopId>`。
 */
export function sopAssignmentUrl(sopId: string, assignmentId?: string): string {
  const params = new URLSearchParams({ sop: sopId });
  if (assignmentId) params.set('assignment', assignmentId);
  return `/sops?${params}`;
}

/**
 * 某条阻塞工单**已经卡了多久**（整小时，向下取整）。
 *
 * 为什么必须现算而不是用查询窗口：`hours=N` 是**筛选条件**（`updatedAt <= now − N`），
 * 拿它当行内时长会把「卡了 30 小时」显示成「已阻塞 24 小时」——数字对不上事实，
 * 而且错的方向恰是「让人以为没那么严重」。
 *
 * 返回 `null` = **算不出来**（时间不可解析 / 在未来 / 时钟偏差）。调用方必须
 * 渲染「时刻未记录」而不是 0 小时，也不是窗口值：
 * - `blockedSince` 在契约上恒有值，但接口是 `string`，脏数据或跨端时钟漂移
 *   仍可能给出解析不出的值——那种行说「多长时间」就一定是编的；
 * - 未来时间（`< 0`）同样算不出：说「已阻塞 -2 小时」是坏文案，说 0 是假事实。
 *
 * 谓词保证 `updatedAt <= now − hours` ⇒ 正常行的结果必然 `>= hours`，
 * 不会出现「24 小时窗口里显示已阻塞 3 小时」。
 */
export function blockedHours(
  blockedSince: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (!blockedSince) return null;
  const ts = new Date(blockedSince).getTime();
  if (!Number.isFinite(ts)) return null;
  const diff = now - ts;
  if (diff < 0) return null;
  return Math.floor(diff / 3_600_000);
}

/**
 * 6. 阻塞工单（R286 新增小节）。
 *
 * ## 与第 5 节（`sopClarifications`）不是同一件事，别合并
 *
 * - `sopClarifications` = 「机器**问了**，没人答」（`escalated_to_human` 且未终态）；
 * - `sopBlocked` = 「工单**卡住**了，且已超过 TTL」（`status='blocked'` 且
 *   `updatedAt <= now − hours`）。后端据此把老 blocked 升级成 `stalled`；
 *   本节的用途是**在升级发生之前**让人看见它——同一批工单的「前夜」与「当天」，
 *   不是同一个视图，所以是两节而不是一节。
 *
 * ## 时间窗：固定 24h，且**只用于筛选**，绝不用于行内时长
 *
 * 后端 `hours=N` 的语义是筛选窗口（`updatedAt <= now − N`），**不是**「每行卡了多久」。
 * 行内「已阻塞 X 小时」由 `blockedSince` 与当前时间现算（`blockedHours`）——
 * 拿窗口值 24 顶上会让「卡了 30 小时」显示成「24 小时」，那就是假数字。
 *
 * ## 三态（与后端定稿契约逐条对齐）
 *
 * - `total: null` ⇒ 读不到 ⇒ 保留本节、标题「—」+ 降级提示，**绝不 0**；
 *   503（服务未装配）走这里 —— 它**不是**「0 条」；
 * - `total: 0` ⇒ 事实为零 ⇒ 整节隐藏（`isSectionVisible`）；
 * - `truncated` 以**服务端**为权威；`total` 未知时服务端恒回 `false`，
 *   缺字段的旧后端回落 `metaOf`（未知 ⇒ 也 `false`，未知由 `degraded` 说）。
 */
async function loadSopBlocked(signal?: AbortSignal): Promise<InboxSectionState> {
  const res = await sopsApi.laggingAssignments(SOP_BLOCKED_WINDOW_HOURS, signal);
  const rows = res?.items ?? [];
  const items = rows.map((row) => ({
    id: `sopb-${row.assignmentId}`,
    section: 'sopBlocked' as const,
    // 标题 = SOP 名；`null` ⇒ 由页面渲染「（未命名 SOP）」，**绝不退回 uuid**
    // （uuid 不是给人看的标题，还会被误读成「已定位」）。
    title: row.sopName ?? '',
    subtitle: undefined,
    // 「何时开始等我」= 进入 blocked 的时刻（后端保证恒有值，契约上是 `string`）。
    // 不写 `?? null` 兜底：真出现空值应当落进 `blockedHours` 的 null 分支
    // 去「说算不出」，而不是在这里悄悄换成另一个语义。
    waitingSince: row.blockedSince,
    detailUrl: sopAssignmentUrl(row.sopId, row.assignmentId),
    blockedAssignment: row,
  }));
  const meta = metaOf(items.length, res?.total);
  return READY('sopBlocked', items, {
    total: meta.total,
    returned: meta.returned,
    truncated: res?.truncated ?? meta.truncated,
    degraded: !!res?.degraded,
    windowHours: SOP_BLOCKED_WINDOW_HOURS,
  });
}

/**
 * 顶栏「阻塞工单 N」的计数（独立读一次 `lagging` 的 `total`）。
 *
 * 与 `readSopClarificationTotal` 同款：`inbox/counts` 里没有这个字段，编一个本地 0
 * 会把「没读过」伪装成「没有阻塞工单」——那正是本节要消灭的形态。
 * 读失败 / 503（服务未装配）⇒ `null`（未知），绝不回落 0。
 */
async function readSopBlockedTotal(signal?: AbortSignal): Promise<number | null> {
  try {
    const res = await sopsApi.laggingAssignments(SOP_BLOCKED_WINDOW_HOURS, signal);
    const total = res?.total;
    return typeof total === 'number' && Number.isFinite(total) ? total : null;
  } catch {
    return null;
  }
}

/** 7. 卡住会话（running 且久无进展）。 */
async function loadStalled(signal?: AbortSignal): Promise<{ items: InboxItem[]; total: number | null; returned: number; truncated: boolean }> {
  const res = await agentApi.list({ stalled: 1, page: 1, pageSize: SECTION_PAGE_SIZE }, signal);
  const items = (res?.items ?? []).map((s) => ({
    id: `stal-${s.id}`,
    section: 'stalled' as const,
    title: s.title || s.id,
    subtitle: s.createdBy || s.kind,
    // The list does not include MAX(step.createdAt); a maintenance write is not progress.
    waitingSince: null,
    detailUrl: agentSessionUrl(s.id, { stalled: true }),
    session: s,
  }));
  return { items, ...metaOf(items.length, res?.total) };
}

/**
 * 8. 调度积压：后端只回 sessionIds，再用 pending 列表补对象信息。
 *
 * ## R285：这里的 `truncated` 是**对账上限**，不是显示上限（D2 的唯一例外）
 *
 * 后端 `GET /agent/sessions/backlogged` 的语义是「在最多 `BACKLOG_PROBE_LIMIT`
 * （=200）条 pending 会话里，逐条对账队列里有没有对应 job」：
 * - `probed` = 本次**实际对账**了多少条 pending（触顶时就是 200）；
 * - `count`  = 在 `probed` 里**已探到**的积压数 ⇒ `truncated` 时它是**下界**；
 * - `sessionIds` = 这些积压会话，全都回传（**列表本身没有藏条目**）。
 *
 * ⇒ 旧实现只把 `{truncated, probed}` 塞进小节、不给 `total`，页面既画不出
 * 「显示前 N 条（共 M 条）」也画不出「—」，`truncated` 就这么**静默**掉了——同一页
 * 上别的节说 D2、这节说「已列出 N 条」，运营要学两套语义。
 * 现在三件事都如实落进 state：`total`（下界/总数）、`probed`（探了多少）、
 * `truncated`（探针是否触顶），措辞由 `describeBacklogCount` 唯一决定。
 */
async function loadBacklogged(signal?: AbortSignal): Promise<{
  items: InboxItem[];
  truncated: boolean;
  probed: number | null;
  total: number | null;
  returned: number;
}> {
  const backlog = await agentApi.backloggedCount(signal);
  const ids = backlog?.sessionIds ?? [];
  let pending: AgentSession[];
  try {
    const pendingRes = await agentApi.list({ status: 'pending', page: 1, pageSize: 200 }, signal);
    pending = pendingRes?.items ?? [];
  } catch {
    pending = [];
  }
  const byId = new Map(pending.map((s) => [s.id, s]));
  const items: InboxItem[] = ids.map((id) => {
    const s = byId.get(id);
    return {
      id: `blg-${id}`,
      section: 'backlogged' as const,
      title: s?.title || id,
      subtitle: s?.createdBy || s?.kind,
      waitingSince: s?.createdAt ?? null,
      detailUrl: agentSessionUrl(id, { status: 'pending' }),
      canResume: s?.status === 'pending',
      session: s,
    };
  });
  const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    items,
    truncated: !!backlog?.truncated,
    // 缺字段 ⇒ `null`（读不到），**不是** `ids.length`：拿已取条数冒充「探了多少条」
    // 会把「没读到探针范围」说成「只探了 N 条」。
    probed: int(backlog?.probed),
    // `count` 缺失 ⇒ `null`（未知），绝不回落 0（D3：读不到 ≠ 没有）。
    total: int(backlog?.count),
    returned: ids.length,
  };
}

/** 9. 队列停摆观测（横幅，不是逐条待办）。 */
export interface QueueStallSnapshot {
  stalled: boolean;
  reason: string | null;
  pendingJobs: number;
  /** ⚠️ R211：可能**误报**（结构性量读失败）。 */
  degraded: boolean;
  /** ⚠️ R211：可能**漏报**（计数类读失败）—— 不改变结论，只影响「数字可能更大」。 */
  degradedCounts: boolean;
  /** ⚠️ R211：`workers === 0` 是否是事实。 */
  workersKnown: boolean;
}

async function loadQueueStall(signal?: AbortSignal): Promise<QueueStallSnapshot | null> {
  return agentApi.queueStall(signal);
}

/** 10. 最近失败（只读跳转）。 */
async function loadRecentFailures(signal?: AbortSignal): Promise<InboxItem[]> {
  const failures = await metricsApi.getRecentFailures(undefined, signal);
  return (failures ?? []).map((f) => ({
    id: `fail-${f.id}`,
    section: 'recentFailures' as const,
    title: f.taskName || f.taskId,
    subtitle: f.errorMessage || undefined,
    waitingSince: f.createdAt ?? null,
    detailUrl: `/tasks/${f.taskId}/executions/${f.id}`,
    failure: f,
  }));
}

type StallResult = { snapshot: QueueStallSnapshot | null } | { error: unknown };

/** 全量装载：小节互相隔离，失败小节保留 error 态。 */
export async function loadInbox(signal?: AbortSignal): Promise<InboxSections> {
  const [deployments, agentWaiting, agentFailures, sopClarifications, sopBlocked, stalled, backlogged, queueStall, recentFailures] = await Promise.all([
    loadDeployments(signal).then(
      ({ items, ...meta }) => READY('deployments', items, meta),
      (error) => ERROR('deployments', error),
    ),
    loadAgentWaiting(signal).catch((error: unknown) => ({
      approvals: ERROR('agentApprovals', error),
      sessions: ERROR('agentWaiting', error),
    })),
    // R279：新小节独立装载——失败**只**让它自己是 error 态，不拖垮其余小节。
    loadAgentFailures(signal).catch((error: unknown) => ERROR('agentFailures', error)),
    // R280：同理。**503（服务未装配）也走这里** ⇒ error 态 + 重试，绝不渲染成空列表。
    loadSopClarifications(signal).catch((error: unknown) => ERROR('sopClarifications', error)),
    // R286：同理。**503（服务未装配）也走这里** ⇒ error 态 + 重试。
    // 关键：503 读成「读不到」，绝不读成「0 条阻塞工单」——那会把「没读到」演成好消息。
    loadSopBlocked(signal).catch((error: unknown) => ERROR('sopBlocked', error)),
    loadStalled(signal).then(
      ({ items, ...meta }) => READY('stalled', items, meta),
      (error) => ERROR('stalled', error),
    ),
    loadBacklogged(signal).then(
      ({ items, ...meta }) => READY('backlogged', items, meta),
      (error) => ERROR('backlogged', error),
    ),
    loadQueueStall(signal).then(
      (snapshot): StallResult => ({ snapshot }),
      (error): StallResult => ({ error }),
    ),
    loadRecentFailures(signal).then(
      (items) => READY('recentFailures', items),
      (error) => ERROR('recentFailures', error),
    ),
  ]);

  let queueStallSection: InboxSectionState;
  if ('error' in queueStall) {
    queueStallSection = ERROR('queueStall', queueStall.error);
  } else {
    // 横幅小节：有快照即视为 ready；快照本身作为一条携带 snapshot 的 item 透出。
    const snapshot: QueueStallSnapshot | null = queueStall.snapshot;
    queueStallSection = READY('queueStall', snapshot ? [queueStallBannerItem(snapshot)] : [], {
      snapshot,
    });
  }

  return {
    deployments,
    agentApprovals: agentWaiting.approvals,
    agentWaiting: agentWaiting.sessions,
    agentFailures,
    sopClarifications,
    sopBlocked,
    stalled,
    backlogged,
    queueStall: queueStallSection,
    recentFailures,
  };
}

/**
 * R211：计数类读失败（`degradedCounts`）⇒ 在排队数**可能更大**。
 * 用 `+` 表达「这是下界」，而不是让运营把 `pendingJobs=3` 当成「一共就 3 条」
 * （与 R395 的 backlog `3+` 同款口径）。
 */
export function queueStallPendingLabel(snapshot: QueueStallSnapshot): string {
  return snapshot.degradedCounts ? `${snapshot.pendingJobs}+` : `${snapshot.pendingJobs}`;
}

function queueStallBannerItem(snapshot: QueueStallSnapshot): InboxItem {
  return {
    id: 'queue-stall-banner',
    section: 'queueStall',
    // 横幅由页面直接读 `snapshot` 渲染；这里不把后端 reason 枚举代码写进标题
    // （那是内部 token，不是给人看的文案）。
    title: '',
    subtitle: `pendingJobs=${queueStallPendingLabel(snapshot)}`,
    waitingSince: null,
    detailUrl: '/agent-sessions',
  };
}

// ── 顶栏计数（轻量：只取计数，不拉列表体） ─────────────────────────────────────

/**
 * 各小节计数。
 *
 * R278/U1：改为**一次** `GET /agent/inbox/counts`（服务端聚合），不再发 5 个
 * 分散请求（5 个请求共享 60/min 限流桶，正是 U3 的成因之一）。
 *
 * 诚实口径（D3）：
 * - 单字段 `null` = 该计数**读不到**（未知）⇒ 传递 `null`，不伪造 0；
 * - 整体不可用（503 / 网络）⇒ 全部 `null`（未知），徽标显示「—」，**不是 0**；
 * - 队列停摆是结构性告警：停摆记 1，未停摆记 0；判定不完整 ⇒ `null`（由后端给）。
 */
export async function loadInboxCounts(signal?: AbortSignal): Promise<InboxCountMap> {
  // 失败语义全在 readInboxCounts：整体不可用 ⇒ 全部 null（未知），绝不回落 0。
  //
  // R280：`sopClarifications` 的计数**不在** `inbox/counts` 里（后端本轮契约冻结、
  // 不加字段），唯一权威来源是 `GET /sop/clarifications/pending` 的 `total`。
  // 所以这里是「主聚合 + 一路独立读」：后者失败 ⇒ 该键 `null`（未知），其余键照常。
  // 三路并行发：彼此不依赖，串行会白等两个往返。
  //
  // R286：`sopBlocked` 同理——`inbox/counts` 没有这个字段，权威来源是
  // `GET /sop/assignments/lagging` 的独立 `getCount()`。失败/503 ⇒ `null`（未知）。
  const [{ counts }, sopPendingTotal, sopBlockedTotal] = await Promise.all([
    readInboxCounts(signal),
    readSopClarificationTotal(signal),
    readSopBlockedTotal(signal),
  ]);
  return { ...counts, sopClarifications: sopPendingTotal, sopBlocked: sopBlockedTotal };
}

// ── 纯函数（可单测） ───────────────────────────────────────────────────────────

/**
 * 汇总顶栏待办总数。
 *
 * R278/D1 口径变更（语义，不是措辞）：
 * - `agentApprovals`（审批单数）**不参与求和**——审批单是 `agentWaiting` 会话的
 *   拆分视图，同一会话的两张单会被算两次；但它**不再是 null 占位**，而是
 *   「单独可显示」的独立数字（见 `splitInboxCounts`）；
 * - `recentFailures` 仍只读，不参与；
 * - 其余任一源为 `null` ⇒ 总数未知，不用局部和谎报总数。
 */
export function summarizeInboxCounts(counts: InboxCountMap): number | null {
  let total = 0;
  for (const key of INBOX_SECTIONS) {
    if (SESSION_SUM_EXCLUDED.has(key)) continue;
    const n = counts[key];
    if (n === null) return null;
    total += n;
  }
  return total;
}

/**
 * 不进入「会话去重求和」的小节键（语义各不相同，统一在这里声明一次）。
 *
 * - `agentApprovals`（R278/D1）——审批单是 `agentWaiting` 会话的拆分视图，
 *   同一会话的两张单会被算两次；
 * - `agentFailures`（R279/D3）——**同一会话可能在窗口内先 failed、修好后被重跑成
 *   其他状态**，把失败数与「还在等我处置的会话数」相加会重复计；而且失败还需要
 *   「先判断为什么」，与「等你点同意」不是同一件事（brief D2 同款理由）；
 * - `sopClarifications`（R280/D4）——SOP 澄清的**去重单位是「一问」**，与 Agent 会话的
 *   「一会话」没有共同单位：一条工单可能有多轮澄清，一个会话也可能完全没有澄清。
 *   相加等于把两种计价单位混成一个数（brief §四「不进会话求和」）；
 * - `recentFailures`——只读参考项，从设计上就不是待办。
 *
 * ⚠️ 这四个是**独立显示项**，不是「不显示项」：它们各自在徽标/小节里单独成句。
 */
const SESSION_SUM_EXCLUDED: ReadonlySet<InboxSectionKey> = new Set([
  'agentApprovals',
  'agentFailures',
  'sopClarifications',
  // R286：阻塞工单的去重单位是「一张指派单」（assignment），与「一会话」「一问」
  // 三者互不换算——同一工单可能既有澄清又正在 blocked，相加会把它数两遍。
  'sopBlocked',
  'recentFailures',
]);

/**
 * 顶栏两个口径的拆分（措辞不同，不能混成一个数）。
 *
 * - `approvals`：**待审批 N 单**（`null` = 读不到，显示「—」）；
 * - `waiting`：**等待输入 M 会话**（`null` = 读不到，显示「—」）。
 */
export function splitInboxCounts(counts: InboxCountMap): {
  approvals: number | null;
  waiting: number | null;
  failed: number | null;
  /** R280：**待人工答复的 SOP 澄清 N 问**（`null` = 读不到，显示「—」）。 */
  sopClarifications: number | null;
  /** R286：**阻塞工单 N 条**（`null` = 读不到，显示「—」）。 */
  sopBlocked: number | null;
  total: number | null;
} {
  return {
    approvals: counts.agentApprovals,
    waiting: counts.agentWaiting,
    // R279：「会话失败 N」是**独立显示项**，与两个会话口径并列，不参与 total。
    failed: counts.agentFailures,
    // R280：同上——「待答复的澄清 N 问」也是独立显示项（brief D4）。
    sopClarifications: counts.sopClarifications,
    // R286：同上——「阻塞工单 N 条」是第四个独立显示项（去重单位是「一张指派单」）。
    sopBlocked: counts.sopBlocked,
    total: summarizeInboxCounts(counts),
  };
}

/**
 * `backlogged` 计数的**渲染视图**（R285/D2 的唯一判定点，仅此一节使用）。
 *
 * ## 为什么它不能复用 `describeSectionCount`
 *
 * 别的节的 `truncated` 是「显示不全」：M 是**服务端权威总数**，N 是本次取到的条数，
 * `N < M` 天然成立 ⇒ 「显示前 N 条（共 M 条）」两句话都是事实。
 *
 * `backlogged` 的 `truncated` 是「**对账**不全」：探针只在 `BACKLOG_PROBE_LIMIT`
 * 条 pending 里查，`M = count` 是**已探到的下界**，而列表把探到的**全显示了**
 * ⇒ `N === M`。照抄「显示前 N 条（共 M 条）」会得到「显示前 3 条（共 3 条）」：
 * 两个数字相同、还把 3 说成总数（R279 教训：下界冒充总数）。
 *
 * ⇒ 三态各自只说自己那件事：
 * - `capped`  —— 探针触顶：`found` 是**下限**，必须同时给出 `probed`（本次共探 P 条），
 *                用户才能看出「P 才是这次能确认的范围」；
 * - `exact`   —— 探针跑完了**全部** pending（未截断）⇒ `found` 就是积压总数，可说「共 M 条」；
 * - `unknown` —— `count` 读不到（`null` / 缺字段）⇒ 「—」，**绝不是 0**。
 */
export function describeBacklogCount(section: InboxSectionState):
  | { kind: 'none' }
  | { kind: 'unknown' }
  | { kind: 'capped'; returned: number; found: number; probed: number | null }
  | { kind: 'exact'; found: number } {
  if (section.status !== 'ready') return { kind: 'none' };
  const returned = section.returned ?? section.items.length;
  const found = typeof section.total === 'number' && Number.isFinite(section.total) ? section.total : null;
  // 缺字段（`undefined`）与 `null` 同义：都是**读不到**。回落「已列出 N 条」会把
  // 「不知道有多少」伪装成「就这些」（D3）。
  if (found === null) return { kind: 'unknown' };
  if (!section.truncated) return { kind: 'exact', found };
  const probed = typeof section.probed === 'number' && Number.isFinite(section.probed) ? section.probed : null;
  return { kind: 'capped', returned, found, probed };
}

/**
 * 小节计数的**渲染视图**（R278/D2+D3 的唯一判定点）。
 *
 * 把「显示什么数字」与「要不要提示」从页面组件里抽出来变成纯函数：
 * ① 页面只剩一层薄渲染，函数体不再膨胀（`check:size-caps` 是结构闸，不是拆分建议书）；
 * ② 判定可被单测直接钉住，不需要渲染组件。
 *
 * 四种形态互斥：
 * - `none`      —— 非 ready 态（loading/error），不显示任何计数；
 * - `unknown`   —— `total === null` ⇒ 显示「—」，**绝不 0**（读不到 ≠ 没有）；
 * - `truncated` —— 总数已知且 `truncated` ⇒ 「显示前 N 条（共 M 条）」；
 * - `total`     —— 总数已知且未截断 ⇒ 「共 M 条」。
 *
 * `total === undefined`（该小节没有总数字段）⇒ 回落已取条数，形态仍是 `total`，
 * 但 `source` 标注为 `returned`，让调用方知道这不是服务端权威总数。
 *
 * ⚠️ **`backlogged` 不走这里**（R285）：那一节的 M 可能是**下界**，`N === M` 会让
 * 「显示前 N 条（共 M 条）」自相矛盾 ⇒ 走 `describeBacklogCount`，由
 * `sectionCountLabel` 按 key 分派。
 */
export function describeSectionCount(section: InboxSectionState):
  | { kind: 'none' }
  | { kind: 'unknown'; degraded: boolean }
  | { kind: 'truncated'; returned: number; total: number }
  | { kind: 'total'; n: number; source: 'server' | 'returned' } {
  if (section.status !== 'ready') return { kind: 'none' };
  const returned = section.returned ?? section.items.length;
  if (section.total === undefined) return { kind: 'total', n: returned, source: 'returned' };
  if (section.total === null) return { kind: 'unknown', degraded: section.degraded === true };
  // 截断判定看**行集合**（`rowTotal`），标题数字看**计数口径**（`total`）：
  // 两者只在 `agentFailures` 上不同（计数含 budget_exceeded，行只取 failed）。
  // 没有 `rowTotal` 的小节行为与此前逐字一致（回落 `total`）。
  const rowTotal = section.rowTotal ?? section.total;
  if (section.truncated && rowTotal != null) return { kind: 'truncated', returned, total: rowTotal };
  return { kind: 'total', n: section.total, source: 'server' };
}

/**
 * 小节内需要显示的告警条（按优先级排序；空数组 = 不显示任何告警）。
 *
 * 取值用本文件 `as const` 元组镜像（与 `INBOX_SECTIONS` 同款）：它是**本模块的
 * 版式枚举**，不是 OpenAPI 视图模型 ⇒ 不引入手写合同类型。
 */
export const SECTION_NOTICES = ['truncated', 'unknown', 'degraded', 'capped', 'budgetExcluded'] as const;

export function sectionNotices(
  section: InboxSectionState,
  limit: number = SECTION_PAGE_SIZE,
): (typeof SECTION_NOTICES)[number][] {
  if (section.status !== 'ready') return [];
  // R285：backlogged 的告警只来自「对账探针」这一件事，走自己的判定（其余三条
  // ——降级/显示上限/口径差——在这一节没有对应事实，凭空加只会造出假红）。
  if (section.key === 'backlogged') {
    const view = describeBacklogCount(section);
    if (view.kind === 'capped') return ['truncated'];
    if (view.kind === 'unknown') return ['unknown'];
    return [];
  }
  const notices: (typeof SECTION_NOTICES)[number][] = [];
  if (section.truncated && section.total != null) notices.push('truncated');
  if (section.total === null) notices.push('unknown');
  // 降级但总数已知 ⇒ 数字是**下界**，不是事实（与 queueStall 的 degraded 同款口径）。
  else if (section.degraded) notices.push('degraded');
  // 没有总数字段却满页返回 ⇒ 只说明「最多显示 N 条」，不编造总数（U4）。
  if (section.total === undefined && section.items.length >= limit) notices.push('capped');
  // R279：计数口径 > 行集合口径 ⇒ 有一类会话**根本不在下方列表里**（不是「没显示全」）。
  // 缺这条，运营会把「计数 5 / 列表 3」读成「列表漏了 2 条」，或反过来怀疑计数。
  if (budgetExcludedCount(section) > 0) notices.push('budgetExcluded');
  return notices;
}

/**
 * 计数里算、但本小节**行**里不算的条数（R279 的 `budget_exceeded`）。
 *
 * 这是「口径差」，不是「截断差」：`truncated` 说的是「同一集合里还有 N 条没显示」，
 * 本函数说的是「另一类会话不在这个列表里」（处置路径不同，见 `loadAgentFailures`）。
 * 两者必须各自表达，不能相加、不能互相顶替。
 */
export function budgetExcludedCount(section: InboxSectionState): number {
  if (section.status !== 'ready') return 0;
  const rowTotal = section.rowTotal ?? section.total;
  if (typeof section.total !== 'number' || typeof rowTotal !== 'number') return 0;
  return Math.max(0, section.total - rowTotal);
}

/**
 * 「事实为零就隐藏」的两个小节（`agentFailures` R279 / `sopClarifications` R280）。
 *
 * 其余小节恒为 true：既有交付面不因计数 0 而消失（那是**已经存在**的可见性，
 * 收紧它等于让运营失去熟悉的位置）。
 */
const ZERO_HIDES_SECTION: ReadonlySet<InboxSectionKey> = new Set<InboxSectionKey>([
  'agentFailures',
  'sopClarifications',
  // R286：`0` 是事实（库里确实没有超 TTL 的 blocked 工单）⇒ 隐藏；
  // `null`（读不到 / 503）⇒ 保留并显示「—」，未知必须可见。
  'sopBlocked',
]);

/**
 * `agentFailures` / `sopClarifications` 小节是否应渲染（D1 的唯一判定点）。
 *
 * - `total === 0` ⇒ 事实为零 ⇒ **隐藏**（与 `InboxBadge` 的 0 件隐藏同款）；
 * - `total === null` ⇒ 读不到 ⇒ **保留**（显示「—」+ 降级提示，未知必须可见）；
 * - 非 ready 态（装载 error）⇒ 保留（错误态带重试，绝不渲染成空列表）。
 * - 其余小节恒为 true（既有小节不因计数 0 而隐藏，那是既有交付面）。
 */
export function isSectionVisible(section: InboxSectionState): boolean {
  if (!ZERO_HIDES_SECTION.has(section.key)) return true;
  return !(section.status === 'ready' && section.total === 0);
}

/**
 * 失败小节标题上的时间窗标签（其余小节返回空串）。
 *
 * 为什么要显示窗口：「失败会话 5」在不同窗口下是完全不同的结论（24h 内 5 条 = 今天
 * 出事了；全 history 5 条 = 一直如此）。窗口是**配置**，读不到时回默认值而非「—」。
 */
export function sectionWindowLabel(
  section: InboxSectionState,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  if (section.key !== 'agentFailures' || section.status !== 'ready') return '';
  const hours = section.windowHours ?? AGENT_FAILED_WINDOW_HOURS_DEFAULT;
  return ` · ${t('inbox.failed.window', { hours })}`;
}

/**
 * 小节「空列表」时该说哪句话的**唯一**判定点（页面只做一层薄翻译）。
 *
 * 为什么外提：这是「同一张卡片里两种相反事实」的分岔口，判错的代价很高——
 * 把「读不到」说成「本类暂无待办」会让运营以为活干完了。放在纯函数里可以被
 * 单测直接钉住，页面组件的函数体也不必为此再长 8 行（`check:size-caps` 是结构闸）。
 *
 * 四种形态互斥：
 * - `unknown`        —— 总数读不到 / 降级 ⇒ **不许**说「暂无」；
 * - `budgetExcluded` —— 计数 > 行（R279 的 `budget_exceeded`）⇒ 说清「几条、为什么不在下方」；
 * - `beyondRows`     —— 计数 > 行但**不是**口径差（R280 的澄清：`total` 独立计数，
 *                       行因降级装配不出来）⇒ 同样不许说「暂无」；
 * - `section`        —— 其余 ⇒ 「本类暂无待办」。
 */
export function emptySectionReason(section: InboxSectionState):
  | { kind: 'section' }
  | { kind: 'unknown' }
  | { kind: 'budgetExcluded'; n: number }
  | { kind: 'beyondRows'; n: number } {
  if (section.total === null || section.degraded) return { kind: 'unknown' };
  const excluded = budgetExcludedCount(section);
  if (excluded > 0) return { kind: 'budgetExcluded', n: excluded };
  // 行集合为空但独立计数 > 0：`rowTotal` 不参与，所以这不是口径差，是「没装配出来」。
  if (typeof section.total === 'number' && section.total > 0) {
    return { kind: 'beyondRows', n: section.total };
  }
  return { kind: 'section' };
}

/**
 * 计数里存在、但行列表里没有的待办数（全空态的守卫，R279）。
 *
 * 只算 `agentFailures`：它的行只取 `failed`，`budget_exceeded` 只在计数里。
 * 若不算进来，「计数 5、行 0」会被全空态渲染成「当前没有待你处理的事项」——
 * 那正是本轮要消灭的假事实（数字对、结论错）。
 */
export function pendingBeyondRows(sections: InboxSections): number {
  const s = sections.agentFailures;
  if (s.status !== 'ready' || typeof s.total !== 'number') return 0;
  return Math.max(0, s.total - s.items.length);
}

/**
 * 有待人工答复的 SOP 澄清吗（R280/D4）。
 *
 * 两条都算「没清零」，因为它们是**两种不同的未处置形态**：
 * - **有行** ⇒ 有人在等你答（最直接）；
 * - **行为空但 `total > 0`** ⇒ 有 N 条待答，只是这次没被列出来（子查询降级导致
 *   行装配不出来，或后端只回计数）。这种情形如果只看 `items.length`，页面会显示
 *   「当前没有待你处理的事项」而计数却写着 5——**数字对、结论错**，正是 D4 要堵的。
 *
 * `total === null`（读不到）不算「有」，因为「未知」由 `hasUncertainCounts` 单独判，
 * 两件事不能互相顶替（未知 ≠ 有，也 ≠ 没有）。
 */
export function hasPendingSopClarifications(sections: InboxSections): boolean {
  const s = sections.sopClarifications;
  if (s.status !== 'ready') return false;
  if (s.items.length > 0) return true;
  return typeof s.total === 'number' && s.total > 0;
}

/**
 * 有阻塞工单吗（R286）。
 *
 * 与 `hasPendingSopClarifications` 逐字同款的两条判据，理由也同款：
 * - **有行** ⇒ 有工单卡着（最直接）；
 * - **行为空但 `total > 0`** ⇒ 有 N 条卡着，只是这次没被列出来（子查询降级导致行
 *   装配不出来）。这种情形只看 `items.length`，页面会显示「当前没有待你处理的事项」
 *   而计数却写着 5——**数字对、结论错**。
 *
 * `total === null`（读不到）不算「有」：「未知」由 `hasUncertainCounts` 单独判，
 * 两件事不能互相顶替（未知 ≠ 有，也 ≠ 没有）。
 */
export function hasBlockedAssignments(sections: InboxSections): boolean {
  const s = sections.sopBlocked;
  if (s.status !== 'ready') return false;
  if (s.items.length > 0) return true;
  return typeof s.total === 'number' && s.total > 0;
}

/**
 * 「当前确实没有待你处理的事项」—— 全空态的**唯一**判据（R278/D3 + R279 + R280）。
 *
 * 五条同时成立才算「清零被证实」：
 * ① 所有小节都 ready（有 error 态 ⇒ 未知，不许报空）；
 * ② 没有任何计数不可确定（`hasUncertainCounts`）；
 * ③ 队列未停摆（停摆横幅本身就是要处理的信号）；
 * ④ 没有任何「计数里算、行里没列出」的待办（`pendingBeyondRows`）；
 * ⑤ 没有待人工答复的 SOP 澄清（`hasPendingSopClarifications`，R280/D4）。
 *
 * ⑤ 在 ① 的「全 ready」之外**单独再判一次**：`sopClarifications` 的 `total` 是
 * 独立计数，可能 `> 0` 而行集合为空（降级/截断），此时 ① 仍成立、`items.length` 全 0，
 * 只有 ⑤ 能拦住「数字对、结论错」。
 */
export function isInboxAllClear(sections: InboxSections): boolean {
  if (!INBOX_SECTIONS.every((key) => sections[key].status === 'ready')) return false;
  if (hasUncertainCounts(sections)) return false;
  if (sections.queueStall.snapshot?.stalled) return false;
  if (pendingBeyondRows(sections) > 0) return false;
  if (hasPendingSopClarifications(sections)) return false;
  // R286：阻塞工单 > 0 ⇒ 不算全清。与 ⑤ 同款单独再判一次：`total` 是独立计数，
  // 可能 `> 0` 而行集合为空（降级导致行装配不出来），只看 `items.length` 会漏。
  if (hasBlockedAssignments(sections)) return false;
  return INBOX_SECTIONS.every((key) => sections[key].items.length === 0);
}

/**
 * 「本轮是否有任何计数不可确定」——全空态的**前置条件**（R278/D3）。
 *
 * 「清零」必须是被证实的事实：任一小节 `total === null`（读不到）或 `degraded`
 * （下界）时，页面不得渲染「当前没有待你处理的事项」，否则「读失败 + 0 条」
 * 会被当成「没有待办」——那正是本轮要消灭的假事实。
 */
export function hasUncertainCounts(sections: InboxSections): boolean {
  return INBOX_SECTIONS.some((key) => {
    const s = sections[key];
    return s.status === 'ready' && (s.total === null || s.degraded === true);
  });
}

/**
 * `backlogged` 的计数标签（R285/D2）：三态措辞**互不相同**，谁也不冒充谁。
 *
 * - 触顶 ⇒ 「显示前 N 条（本次**共**对账 P 条已达上限 · 已探到 M 条是下限，实际可能更多）」：
 *   N 与 P 是两个不同数字，用户一眼能看出「3 条」是**探到的**、不是总数；
 * - 未触顶 ⇒ 「共 M 条」（探针跑完了全部 pending ⇒ M 才是总数），且**不出现**「显示前 N 条」；
 * - 读不到 ⇒ 「—」，绝不出现 0。
 */
export function backlogCountLabel(
  section: InboxSectionState,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  const view = describeBacklogCount(section);
  switch (view.kind) {
    case 'none':
      return '';
    case 'unknown':
      return `· ${t('inbox.count.unknown')}`;
    case 'exact':
      return `· ${t('inbox.count.total', { n: view.found })}`;
    case 'capped':
      // `probed` 读不到（旧后端）⇒ 不能编一个探针范围出来，退到不带 P 的措辞。
      return view.probed === null
        ? `· ${t('inbox.backlog.cappedNoProbe', { returned: view.returned, found: view.found })}`
        : `· ${t('inbox.backlog.capped', {
          returned: view.returned,
          found: view.found,
          probed: view.probed,
        })}`;
  }
}

/** `describeSectionCount` 的本地化标签（`—` 与「共 M 条」等措辞的唯一来源）。 */
export function sectionCountLabel(
  section: InboxSectionState,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  // R285：backlogged 的 M 可能是下界（对账探针有上限），三态措辞单独一套。
  if (section.key === 'backlogged') return backlogCountLabel(section, t);
  const view = describeSectionCount(section);
  switch (view.kind) {
    case 'none':
      return '';
    case 'unknown':
      return `· ${t('inbox.count.unknown')}${view.degraded ? ` · ${t('inbox.count.degraded')}` : ''}`;
    case 'truncated':
      return `· ${t('inbox.truncated.summary', { returned: view.returned, total: view.total })}`;
    default:
      // 没有服务端 total 可判（total === undefined）⇒ 只能说「已列出 N 条」，
      // 用「共」会把这个数字冒充成权威总数（U4 禁止的编造）。
      return view.source === 'returned'
        ? `· ${t('inbox.count.returned', { n: view.n })}`
        : `· ${t('inbox.count.total', { n: view.n })}`;
  }
}

/** 四条告警各自的 `data-testid`（测试与运维脚本共用同一张表，避免字符串漂移）。 */
export const NOTICE_TESTID: Record<(typeof SECTION_NOTICES)[number], (key: InboxSectionKey) => string> = {
  truncated: (key) => `inbox-truncated-${key}`,
  unknown: (key) => `inbox-degraded-${key}`,
  degraded: (key) => `inbox-degraded-${key}`,
  capped: (key) => `inbox-capped-${key}`,
  budgetExcluded: (key) => `inbox-budget-excluded-${key}`,
};

/** 告警标题文案的唯一出口（每条告警只说一条事实，不互相顶替）。 */
export function noticeTitle(
  notice: (typeof SECTION_NOTICES)[number],
  section: InboxSectionState,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  // R285：backlogged 的两条告警说的是「对账探针」的事，措辞必须与别的节不同——
  // 通用 hint 里那句「其余未显示」在这一节是假话（探到的**全**显示了）。
  if (section.key === 'backlogged') {
    const view = describeBacklogCount(section);
    if (notice === 'truncated' && view.kind === 'capped') {
      return view.probed === null
        ? t('inbox.backlog.truncatedHintNoProbe', { found: view.found })
        : t('inbox.backlog.truncatedHint', { found: view.found, probed: view.probed });
    }
    if (notice === 'unknown') return t('inbox.backlog.unknownHint');
  }
  switch (notice) {
    case 'truncated':
      // 与 `describeSectionCount` 同口径：截断说的是**行集合**（`rowTotal`），
      // 拿计数口径的 `total` 会在 `agentFailures` 上多报出「另有一类会话」的条数。
      return t('inbox.truncated.hint', {
        returned: section.returned ?? section.items.length,
        total: section.rowTotal ?? section.total ?? 0,
      });
    case 'unknown':
      // R279/R280：这两节的总数读不到时，提示必须点出「数的是哪一类」——
      // 通用措辞在这里读不出「几会话失败」还是「几问待答复」。
      if (section.key === 'agentFailures') return t('inbox.failed.unknownHint');
      if (section.key === 'sopClarifications') return t('inbox.sop.unknownHint');
      if (section.key === 'sopBlocked') return t('inbox.sopBlocked.unknownHint');
      return t('inbox.count.unknownHint');
    case 'degraded':
      return t('inbox.count.degradedHint');
    case 'budgetExcluded':
      return t('inbox.failed.budgetExcludedHint', { n: budgetExcludedCount(section) });
    default:
      return t('inbox.count.cappedHint', { limit: SECTION_PAGE_SIZE });
  }
}

/** 等待起始时间排序：有时间的在前（越久越靠前），无时间信息的排末尾。 */
export function sortInboxItemsByWaitingSince(items: InboxItem[]): InboxItem[] {
  const ts = (it: InboxItem): number => {
    const t = it.waitingSince ? new Date(it.waitingSince).getTime() : NaN;
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  return [...items].sort((a, b) => ts(a) - ts(b));
}

/** 第二人规则：部署行的提交者本人不能审批自己的请求（后端同口径兜底）。 */
export function isSelfDeployment(deployment: AppDeployment | undefined, userId: number | null | undefined): boolean {
  if (!deployment || userId == null) return false;
  return deployment.approvalMeta?.requestedBy === userId;
}

// 保持既有写接口引用被打包（页面经本模块透传，避免页面直连多模块造成计数口径漂移）。
export { deploymentsApi, agentApi };