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
 * - 每个小节独立 `Promise.allSettled`：某一类读失败**不拖垮**其他小节，
 *   失败小节保留「未知」态（`status: 'error'`），绝不渲染成 0 条；
 * - 顶栏按等待会话数（含待审批）计一次；任一参与计数的数据源读不到 ⇒ 总计数 `null`，
 *   不用其余小节的局部和谎报「一共 N 件」；
 * - 时间字段缺失时行内明确显示「无时间信息」，不猜。
 *
 * 写动作不在本层执行：页面直接复用 `deploymentsApi` / `agentApi` 的既有写接口
 * （后端 `@Roles(ADMIN)` + 第二人规则仍是权威门控）。
 */
import { agentSessionUrl } from '../utils/agentSessionUrl';
import { client } from './client';
import { agentApi, type AgentApproval, type AgentSession } from './agent';
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
  /** 对账是否被上限截断（backlogged 口径，R395）。 */
  truncated?: boolean;
  /** 实际对账条数（backlogged）。 */
  probed?: number;
  /** 队列停摆快照（仅 queueStall 小节携带）。 */
  snapshot?: QueueStallSnapshot | null;
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

// ── 各小节装载器 ──────────────────────────────────────────────────────────────

interface PendingDeploymentsResponse {
  data: AppDeployment[];
  total: number;
}

/** 1. 部署审批待办。 */
async function loadDeployments(signal?: AbortSignal): Promise<InboxItem[]> {
  const res = await client.get<PendingDeploymentsResponse>(
    '/app-deployments/approvals/pending',
    signal ? { signal } : undefined,
  );
  const rows = res?.data ?? [];
  return rows.map((d) => ({
    id: `dep-${d.id}`,
    section: 'deployments' as const,
    title: d.application?.name || d.applicationId,
    subtitle: d.approvalMeta?.requestedByName ?? undefined,
    waitingSince: d.approvalMeta?.requestedAt ?? d.createdAt ?? null,
    detailUrl: `/applications/${d.applicationId}`,
    deployment: d,
  }));
}

/** 2+3. Agent 等待人工：审批单 + 等待输入会话（没有待批单时才可恢复）。 */
async function loadAgentWaiting(): Promise<{ approvals: InboxSectionState; sessions: InboxSectionState }> {
  const res = await agentApi.list({ status: 'waiting_input', page: 1, pageSize: 50 });
  const sessions = res?.items ?? [];

  const approvalSection = READY('agentApprovals', []);
  const waitingSection = READY('agentWaiting', []);

  await Promise.all(
    sessions.map(async (s) => {
      // 单会话读取失败时保留其他会话的单，但不能把未知当成「无待批单」。
      const approvals = await agentApi.listApprovals(s.id).catch((error: unknown) => {
        approvalSection.status = 'error';
        approvalSection.error = error;
        return undefined;
      });
      const pending = approvals?.filter((a) => a.status === 'pending');
      for (const a of pending ?? []) {
        approvalSection.items.push({
          id: `apr-${a.approvalKey}`,
          section: 'agentApprovals' as const,
          title: s.title || s.id,
          subtitle: a.toolName,
          waitingSince: a.createdAt ?? s.createdAt ?? null,
          detailUrl: agentSessionUrl(s.id, { tab: 'approvals', approvalKey: a.approvalKey }),
          session: s,
          approval: a,
        });
      }
      waitingSection.items.push({
        id: `ses-${s.id}`,
        section: 'agentWaiting' as const,
        title: s.title || s.id,
        subtitle: s.waitingFor || s.createdBy || s.kind,
        waitingSince: s.createdAt ?? null,
        detailUrl: agentSessionUrl(s.id, {
          status: 'waiting_input',
          tab: pending?.length ? 'approvals' : undefined,
        }),
        canResume: s.status === 'waiting_input' && pending?.length === 0,
        session: s,
      });
    }),
  );

  return { approvals: approvalSection, sessions: waitingSection };
}

/** 4. 卡住会话（running 且久无进展）。 */
async function loadStalled(): Promise<InboxItem[]> {
  const res = await agentApi.list({ stalled: 1, page: 1, pageSize: 50 });
  return (res?.items ?? []).map((s) => ({
    id: `stal-${s.id}`,
    section: 'stalled' as const,
    title: s.title || s.id,
    subtitle: s.createdBy || s.kind,
    // The list does not include MAX(step.createdAt); a maintenance write is not progress.
    waitingSince: null,
    detailUrl: agentSessionUrl(s.id, { stalled: true }),
    session: s,
  }));
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
      (items) => READY('deployments', items),
      (error) => ERROR('deployments', error),
    ),
    loadAgentWaiting().catch((error: unknown) => ({
      approvals: ERROR('agentApprovals', error),
      sessions: ERROR('agentWaiting', error),
    })),
    loadStalled().then(
      (items) => READY('stalled', items),
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
 * 各小节计数。读不到的小节返回 `null`（未知），不伪造 0。
 * 队列停摆是结构性告警：停摆记 1，未停摆记 0；`degraded`（判定不完整）记 `null`。
 */
export async function loadInboxCounts(signal?: AbortSignal): Promise<InboxCountMap> {
  const [deployments, waiting, stalled, backlogged, stall] = await Promise.all([
    client
      .get<PendingDeploymentsResponse>('/app-deployments/approvals/pending', signal ? { signal } : undefined)
      .then((r) => r?.total ?? 0)
      .catch(() => null),
    agentApi
      .pendingTakeoverCount()
      .catch(() => null),
    agentApi
      .stalledCount()
      .catch(() => null),
    agentApi
      .backloggedCount()
      .then((r) => r?.count ?? 0)
      .catch(() => null),
    agentApi
      .queueStall()
      .then((r) => (r.degraded ? null : r.stalled ? 1 : 0))
      .catch(() => null),
  ]);

  return {
    deployments,
    agentApprovals: null, // 审批单数没有独立计数源；待审批的会话已包含在 agentWaiting。
    agentWaiting: waiting,
    stalled,
    backlogged,
    queueStall: stall,
    recentFailures: null, // 最近失败是只读参考项，不计入顶栏待办总数。
  };
}

// ── 纯函数（可单测） ───────────────────────────────────────────────────────────

/**
 * 汇总顶栏待办总数。
 * 等待人工按会话计一次，审批单是这些会话的拆分视图；最近失败只读。
 * 排除这两项后，任一计数源为 null ⇒ 总数未知，不用局部和谎报总数。
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
