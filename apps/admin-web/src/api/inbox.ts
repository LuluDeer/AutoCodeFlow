/**
 * P1-4 · 待办收件箱聚合层。
 *
 * 把原本分散在四个入口的待办收成一组统一视图：
 *   1. 部署审批待办（`GET /app-deployments/approvals/pending`）；
 *   2. Agent 会话等待审批（挂起在 waiting_input、有待处置审批单）；
 *   3. Agent 会话等待人工输入/澄清（waiting_input 会话）；
 *   4. 卡住会话（running 且久无进展，`stalled=1`）；
 *   5. 调度积压（pending 但队列里没有对应 job，`backlogged`）；
 *   6. 队列停摆观测（`queue-stall`，结构性告警横幅，不是逐条待办）；
 *   7. 最近失败（复用 `/metrics/failures`，只读跳转，不在这里处置）。
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

/** 待办变更后通知顶栏徽标重取计数的窗口事件名。 */
export const INBOX_REFRESH_EVENT = 'autoflow:inbox-refresh';

/** 收件箱小节键。 */
export const INBOX_SECTIONS = [
  'deployments',
  'agentApprovals',
  'agentWaiting',
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
}

/** 单个小节的装载状态。 */
export interface InboxSectionState {
  key: InboxSectionKey;
  status: 'loading' | 'ready' | 'error';
  items: InboxItem[];
  error: unknown;
  /** 对账是否被上限截断（backlogged 口径，R395；R278 起所有有上限的小节都要带）。 */
  truncated?: boolean;
  /** 实际对账条数（backlogged）。 */
  probed?: number;
  /** 队列停摆快照（仅 queueStall 小节携带）。 */
  snapshot?: QueueStallSnapshot | null;
  /**
   * 该小节的总条数（服务端权威计数）。
   * - `number`：真实总数（可能 > 已取条数 ⇒ 配合 `truncated` 渲染「共 M 条」）；
   * - `null`：**读不到（未知）**，页面显示「—」，绝不显示 0；
   * - `undefined`：该小节没有总数字段（如 recentFailures），页面回落已取条数。
   */
  total?: number | null;
  /** 服务端实际返回的条数（= 已取条数，用于「显示前 N 条」的 N）。 */
  returned?: number;
  /** 服务端聚合的部分失败标记：数字仍是**下界**，不是事实。 */
  degraded?: boolean;
}

export type InboxSections = Record<InboxSectionKey, InboxSectionState>;


/** 顶栏计数口径：`null` 表示没有独立计数或读取失败，均不等于 0。 */
export type InboxCountMap = Record<InboxSectionKey, number | null>;

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
function readPendingApprovals(): Promise<{ ok: true; value: AgentPendingApprovalsResponse } | { ok: false; error: unknown }> {
  return agentApi.listPendingApprovals(SECTION_PAGE_SIZE).then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
}

function readWaitingSessions(): Promise<
  { ok: true; value: { items: AgentSession[]; total: number } } | { ok: false; error: unknown }
> {
  return agentApi.list({ status: 'waiting_input', page: 1, pageSize: SECTION_PAGE_SIZE }).then(
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
async function loadAgentWaiting(): Promise<{ approvals: InboxSectionState; sessions: InboxSectionState }> {
  // 两个源各自独立失败：一个挂不拖垮另一个（既有「小节互相隔离」纪律）。
  const [pending, sessionsRes] = await Promise.all([
    readPendingApprovals(),
    readWaitingSessions(),
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
        title: row.sessionTitle || row.sessionId,
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
      title: s.title || s.id,
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

/** 4. 卡住会话（running 且久无进展）。 */
async function loadStalled(): Promise<{ items: InboxItem[]; total: number | null; returned: number; truncated: boolean }> {
  const res = await agentApi.list({ stalled: 1, page: 1, pageSize: SECTION_PAGE_SIZE });
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

/** 5. 调度积压：后端只回 sessionIds，再用 pending 列表补对象信息。 */
async function loadBacklogged(): Promise<{ items: InboxItem[]; truncated: boolean; probed: number }> {
  const backlog = await agentApi.backloggedCount();
  const ids = backlog?.sessionIds ?? [];
  let pending: AgentSession[];
  try {
    const pendingRes = await agentApi.list({ status: 'pending', page: 1, pageSize: 200 });
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
  return { items, truncated: !!backlog?.truncated, probed: backlog?.probed ?? ids.length };
}

/** 6. 队列停摆观测（横幅，不是逐条待办）。 */
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

async function loadQueueStall(): Promise<QueueStallSnapshot | null> {
  return agentApi.queueStall();
}

/** 7. 最近失败（只读跳转）。 */
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
  const [deployments, agentWaiting, stalled, backlogged, queueStall, recentFailures] = await Promise.all([
    loadDeployments(signal).then(
      ({ items, ...meta }) => READY('deployments', items, meta),
      (error) => ERROR('deployments', error),
    ),
    loadAgentWaiting().catch((error: unknown) => ({
      approvals: ERROR('agentApprovals', error),
      sessions: ERROR('agentWaiting', error),
    })),
    loadStalled().then(
      ({ items, ...meta }) => READY('stalled', items, meta),
      (error) => ERROR('stalled', error),
    ),
    loadBacklogged().then(
      ({ items, truncated, probed }) => READY('backlogged', items, { truncated, probed }),
      (error) => ERROR('backlogged', error),
    ),
    loadQueueStall().then(
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
    stalled,
    backlogged,
    queueStall: queueStallSection,
    recentFailures,
  };
}

function queueStallBannerItem(snapshot: QueueStallSnapshot): InboxItem {
  // R211：计数类读失败 ⇒ 在排队数**可能更大**。用 `+` 表达「这是下界」，而不是
  // 让运营把 `pendingJobs=3` 当成「一共就 3 条」（与 R395 的 backlog `3+` 同款口径）。
  const pending = snapshot.degradedCounts ? `${snapshot.pendingJobs}+` : `${snapshot.pendingJobs}`;
  return {
    id: 'queue-stall-banner',
    section: 'queueStall',
    title: snapshot.reason ?? 'queue-stall',
    subtitle: `pendingJobs=${pending}`,
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
  const unknown: InboxCountMap = {
    deployments: null,
    agentApprovals: null,
    agentWaiting: null,
    stalled: null,
    backlogged: null,
    queueStall: null,
    recentFailures: null,
  };
  try {
    const counts = await agentApi.inboxCounts(signal);
    return {
      deployments: counts?.deployments ?? null,
      // R278/D1：审批单数是**独立计数源**（不再恒为 null），但它不参与会话求和。
      agentApprovals: counts?.pendingApprovals ?? null,
      agentWaiting: counts?.waitingSessions ?? null,
      stalled: counts?.stalled ?? null,
      backlogged: counts?.backlogged ?? null,
      queueStall: counts?.queueStall ?? null,
      recentFailures: null, // 最近失败是只读参考项，不计入顶栏待办总数。
    };
  } catch {
    return unknown;
  }
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
    if (key === 'agentApprovals' || key === 'recentFailures') continue;
    const n = counts[key];
    if (n === null) return null;
    total += n;
  }
  return total;
}

/**
 * 顶栏两个口径的拆分（措辞不同，不能混成一个数）。
 *
 * - `approvals`：**待审批 N 单**（`null` = 读不到，显示「—」）；
 * - `waiting`：**等待输入 M 会话**（`null` = 读不到，显示「—」）。
 */
export function splitInboxCounts(counts: InboxCountMap): {
  approvals: number | null;
  waiting: number | null;
  total: number | null;
} {
  return {
    approvals: counts.agentApprovals,
    waiting: counts.agentWaiting,
    total: summarizeInboxCounts(counts),
  };
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
  if (section.truncated) return { kind: 'truncated', returned, total: section.total };
  return { kind: 'total', n: section.total, source: 'server' };
}

/**
 * 小节内需要显示的告警条（按优先级排序；空数组 = 不显示任何告警）。
 *
 * 取值用本文件 `as const` 元组镜像（与 `INBOX_SECTIONS` 同款）：它是**本模块的
 * 版式枚举**，不是 OpenAPI 视图模型 ⇒ 不引入手写合同类型。
 */
export const SECTION_NOTICES = ['truncated', 'unknown', 'degraded', 'capped'] as const;

export function sectionNotices(
  section: InboxSectionState,
  limit: number = SECTION_PAGE_SIZE,
): (typeof SECTION_NOTICES)[number][] {
  if (section.status !== 'ready') return [];
  const notices: (typeof SECTION_NOTICES)[number][] = [];
  if (section.truncated && section.total != null) notices.push('truncated');
  if (section.total === null) notices.push('unknown');
  // 降级但总数已知 ⇒ 数字是**下界**，不是事实（与 queueStall 的 degraded 同款口径）。
  else if (section.degraded) notices.push('degraded');
  // 没有总数字段却满页返回 ⇒ 只说明「最多显示 N 条」，不编造总数（U4）。
  if (section.total === undefined && section.items.length >= limit) notices.push('capped');
  return notices;
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

/** `describeSectionCount` 的本地化标签（`—` 与「共 M 条」等措辞的唯一来源）。 */
export function sectionCountLabel(
  section: InboxSectionState,
  t: ReturnType<typeof useTranslation>['t'],
): string {
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
};

/** 告警标题文案的唯一出口（每条告警只说一条事实，不互相顶替）。 */
export function noticeTitle(
  notice: (typeof SECTION_NOTICES)[number],
  section: InboxSectionState,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  switch (notice) {
    case 'truncated':
      return t('inbox.truncated.hint', {
        returned: section.returned ?? section.items.length,
        total: section.total ?? 0,
      });
    case 'unknown':
      return t('inbox.count.unknownHint');
    case 'degraded':
      return t('inbox.count.degradedHint');
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