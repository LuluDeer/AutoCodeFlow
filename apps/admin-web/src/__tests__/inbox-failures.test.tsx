/**
 * R279 · 收件箱第八个小节「Agent 会话失败」。
 *
 * ## 这一节要钉死的四件事（brief §五 S2 栏）
 *
 * ① `failedSessions: null` ⇒ 显示「—」而**不是 0**（读不到 ≠ 没有）；
 * ② `failedSessions: 0` ⇒ 小节**隐藏**（事实为零，不占屏）；
 * ③ 每行渲染 `errorMessage`（截断到 120 字符）并深链到会话详情；
 * ④ 新小节**不**进 `summarizeInboxCounts` 的会话求和（`splitInboxCounts` 单独可显示）。
 *
 * ## 另两条本轮特有的口径（写在这里，防止下一个人「顺手对齐」）
 *
 * - **计数含 `budget_exceeded`，行只取 `failed`**：两者之差是「另一类会话」，
 *   不是「被截掉的条数」⇒ 截断走 `rowTotal`，差值走 `budgetExcluded` 告警；
 * - 计数 > 行 ⇒ 全空态**不许**渲染「当前没有待你处理的事项」（数字对、结论错）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '../i18n';
import InboxPage from '../pages/InboxPage';
import InboxBadge from '../components/InboxBadge';
import {
  FAILED_REASON_MAX_CHARS,
  INBOX_SECTIONS,
  agentApi,
  budgetExcludedCount,
  describeSectionCount,
  failedWindowSince,
  isInboxAllClear,
  isSectionVisible,
  loadInbox,
  loadInboxCounts,
  pendingBeyondRows,
  splitInboxCounts,
  summarizeInboxCounts,
  truncateFailureReason,
  type InboxCountMap,
  type InboxItem,
  type InboxSectionState,
  type InboxSections,
} from '../api/inbox';
import { client } from '../api/client';
import { useAuthStore } from '../store/auth';

vi.mock('../api/inbox', { spy: true });

const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// ── 夹具 ──────────────────────────────────────────────────────────────────────

const failedSession = (id: string, errorMessage: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  title: `会话 ${id}`,
  status: 'failed',
  kind: 'chat',
  triggerSource: 'user',
  createdBy: 'user:admin',
  parentSessionId: null,
  contextJson: null,
  scopeJson: null,
  budgetJson: null,
  resultJson: null,
  summary: null,
  errorMessage,
  totalSteps: 3,
  totalTokensIn: 100,
  totalTokensOut: 50,
  totalToolCalls: 2,
  waitingFor: null,
  startedAt: '2026-01-01T00:00:00Z',
  finishedAt: '2026-01-01T00:05:00Z',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:05:00Z',
  ...extra,
});

/**
 * 在 HTTP 读边界注入数据（真实 `loadInbox` / `loadInboxCounts` 照常运行）。
 *
 * `failures` = `/agent/sessions?status=failed` 的 `{items,total}`；
 * `counts.failedSessions` / `counts.failedWindowHours` 是新契约字段，
 * 省略时**故意不出现**（模拟旧后端 ⇒ 必须被读成 null，而不是 0）。
 */
function mockBackend(opts: {
  failures?: { items: unknown[]; total: number };
  counts?: Record<string, unknown>;
} = {}) {
  return vi.spyOn(client, 'get').mockImplementation(async (url, config) => {
    if (url === '/agent/inbox/counts') {
      return {
        pendingApprovals: 0,
        waitingSessions: 0,
        stalled: 0,
        backlogged: 0,
        backlogTruncated: false,
        deployments: 0,
        queueStall: 0,
        degraded: false,
        ...(opts.counts ?? {}),
      };
    }
    if (url === '/agent/sessions') {
      const params = config?.params as { status?: string } | undefined;
      if (params?.status === 'failed') return opts.failures ?? { items: [], total: 0 };
      return { items: [], total: 0 };
    }
    if (url === '/agent/approvals/pending') {
      return { items: [], total: 0, sessionTotal: 0, returned: 0, truncated: false, degraded: false };
    }
    // R286：第十个小节的数据源。本文件不是它的被测对象 ⇒ 恒为「确认清零」
    // （0 是事实 ⇒ 隐藏），既有断言因此不受影响。
    if (url === '/sop/assignments/lagging') {
      return { items: [], total: 0, returned: 0, truncated: false, degraded: false };
    }
    if (url === '/app-deployments/approvals/pending') return { data: [], total: 0 };
    if (url === '/agent/sessions/backlogged') return { sessionIds: [], probed: 0, truncated: false };
    if (url === '/agent/sessions/queue-stall') {
      return { stalled: false, reason: null, pendingJobs: 0, degraded: false, degradedCounts: false, workersKnown: true };
    }
    if (url === '/metrics/failures') return [];
    throw new Error(`Unexpected request: ${url}`);
  });
}

const ready = (key: InboxSectionState['key'], items: InboxItem[], extra: Partial<InboxSectionState> = {}): InboxSectionState => ({
  key,
  status: 'ready',
  items,
  error: null,
  ...extra,
});

/** 其余七个小节都「确认清零」，只让失败小节成为变量。 */
const sections = (failures: InboxSectionState): InboxSections =>
  ({
    deployments: ready('deployments', [], { total: 0 }),
    agentApprovals: ready('agentApprovals', [], { total: 0 }),
    agentWaiting: ready('agentWaiting', [], { total: 0 }),
    agentFailures: failures,
    // R280：第八节之外新增的第九个小节，本文件不是它的被测对象 ⇒ 恒为「确认清零」。
    sopClarifications: ready('sopClarifications', [], { total: 0 }),
    // R286：第十个小节，本文件不是它的被测对象 ⇒ 恒为「确认清零」。
    sopBlocked: ready('sopBlocked', [], { total: 0 }),
    stalled: ready('stalled', [], { total: 0 }),
    backlogged: ready('backlogged', [], { total: 0 }),
    queueStall: ready('queueStall', []),
    recentFailures: ready('recentFailures', []),
  }) as InboxSections;

const counts = (overrides: Partial<InboxCountMap> = {}): InboxCountMap => ({
  deployments: 0,
  agentApprovals: null,
  agentWaiting: 0,
  agentFailures: 0,
  sopClarifications: 0,
  sopBlocked: 0,
  stalled: 0,
  backlogged: 0,
  queueStall: 0,
  recentFailures: null,
  ...overrides,
});

const failureItem = (id: string, errorMessage?: string): InboxItem => ({
  id: `fail-${id}`,
  section: 'agentFailures',
  title: `会话 ${id}`,
  subtitle: errorMessage,
  waitingSince: '2026-01-01T00:00:00Z',
  detailUrl: `/agent-sessions?session=${id}&status=failed`,
  errorMessage,
  session: failedSession(id, errorMessage ?? null) as never,
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/inbox']}>
      <Routes>
        <Route path="/inbox" element={<InboxPage />} />
        <Route path="/agent-sessions" element={<div data-testid="session-page" />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadInbox).mockReset();
  vi.mocked(loadInboxCounts).mockReset();
  useAuthStore.setState({ user: { id: 1, username: 'admin', role: 'admin' } });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── ① null ≠ 0 ────────────────────────────────────────────────────────────────

describe('R279 ① failedSessions 读不到（null）⇒ 显示「—」，绝不 0', () => {
  it('计数层：`failedSessions` 缺失（旧后端）⇒ 读成 null，不是 0', async () => {
    mockBackend({ counts: {} }); // 契约字段**故意**不出现
    const map = await loadInboxCounts();
    expect(map.agentFailures).toBeNull();
    expect(splitInboxCounts(map).failed).toBeNull();
  });

  it('计数层：`failedSessions: null` 原样透传（不回落 0），且不影响会话求和', async () => {
    mockBackend({ counts: { failedSessions: null, failedWindowHours: 24 } });
    const map = await loadInboxCounts();
    expect(map.agentFailures).toBeNull();
    // 求和项全 0 ⇒ 总数仍可确定为 0：失败数是**独立显示项**，读不到也不拖垮总数。
    expect(summarizeInboxCounts(map)).toBe(0);
    expect(splitInboxCounts(map)).toEqual(
      // R280：`sopClarifications` 也是独立显示项；本文件的 mockBackend 没有该端点
      // ⇒ 读不到 ⇒ null（同样绝不回落 0）。
      { approvals: 0, waiting: 0, failed: null, sopClarifications: null, sopBlocked: 0, total: 0 },
    );
  });

  it('小节层：`total:null` ⇒ 标题「—」、带降级提示、**不**渲染「就这些」的空态', async () => {
    vi.mocked(loadInbox).mockResolvedValue(
      sections(ready('agentFailures', [], { total: null, rowTotal: null, returned: 0, degraded: true, windowHours: 24 })),
    );
    renderPage();

    const count = await screen.findByTestId('inbox-count-agentFailures');
    expect(count.textContent).toContain('—');
    expect(count.textContent).not.toMatch(/·\s*共\s*0\s*条/);
    // 时间窗与计数同处标题（窗口是配置，读不到时回默认 24h 而非「—」）。
    expect(count.textContent).toContain('近 24 小时');

    const section = within(screen.getByTestId('inbox-section-agentFailures'));
    // 专属措辞只出现一次：由标题上方的 unknown 告警承担（同一件事不说两遍）。
    expect(section.getAllByText('本节总数读取失败，无法确认一共多少条失败会话。')).toHaveLength(1);
    expect(section.getByTestId('inbox-degraded-agentFailures')).toBeTruthy();
    expect(section.queryByText('本类暂无待办')).toBeNull();
  });

  it('徽标层：`failed:null` ⇒ 单独成句「会话失败 —」，并把徽标标成降级', async () => {
    vi.mocked(loadInboxCounts).mockResolvedValue(counts({ agentWaiting: 1, agentFailures: null }));
    render(<MemoryRouter><InboxBadge /></MemoryRouter>);

    // ⚠️ 不能只等 `inbox-badge-failed` 出现：loading 期 `failed === null` ⇒ 那一格
    // **已经**渲染成「会话失败 —」，`findByTestId` 会立刻命中，而 `waiting` 此时
    // 还是「—」⇒ 紧跟的同步断言间歇性红（实测连跑 12 轮抓到 1 次）。
    // 等「计数已落地」的那个格子（`waiting` 变成 1）作为终态信号。
    await waitFor(() =>
      expect(screen.getByTestId('inbox-badge-waiting').textContent).toBe('等待输入 1 会话'),
    );
    expect(screen.getByTestId('inbox-badge-failed').textContent).toBe('会话失败 —');
    expect(screen.getByTestId('inbox-badge').getAttribute('data-degraded')).toBe('true');
  });
});

// ── ② 0 ⇒ 隐藏 ────────────────────────────────────────────────────────────────

describe('R279 ② failedSessions 为 0（事实为零）⇒ 小节隐藏', () => {
  it('计数层：0 是事实，不是「读不到」——两者必须可区分', async () => {
    mockBackend({ counts: { failedSessions: 0, failedWindowHours: 24 } });
    const map = await loadInboxCounts();
    expect(map.agentFailures).toBe(0);
    expect(map.agentFailures).not.toBeNull();
  });

  it('纯函数层：total:0 ⇒ isSectionVisible=false；null ⇒ 仍然可见', () => {
    expect(isSectionVisible(ready('agentFailures', [], { total: 0 }))).toBe(false);
    expect(isSectionVisible(ready('agentFailures', [], { total: null, degraded: true }))).toBe(true);
    expect(isSectionVisible(ready('agentFailures', [failureItem('s1')], { total: 1 }))).toBe(true);
    // 其余小节不因 0 而隐藏（既有交付面不动）。同类还有 R280 的 `sopClarifications`
    // 与 R286 的 `sopBlocked`——两者同样「事实为零就隐藏」，故一并排除。
    for (const key of INBOX_SECTIONS.filter(
      (k) => k !== 'agentFailures' && k !== 'sopClarifications' && k !== 'sopBlocked',
    )) {
      expect(isSectionVisible(ready(key, [], { total: 0 }))).toBe(true);
    }
  });

  it('页面层：total:0 ⇒ 小节卡片不渲染；total:null ⇒ 卡片仍在（未知必须可见）', async () => {
    vi.mocked(loadInbox).mockResolvedValue(sections(ready('agentFailures', [], { total: 0, rowTotal: 0 })));
    renderPage();
    // 其余七个小节都确认清零 + 失败数确认为 0 ⇒ 整页进入全空态（卡片一律不渲染）。
    // `inbox-page` 是 shell 容器，loading 期已存在 ⇒ 等它等于没等。等全清文案
    // 出现（它只在「全 ready + 确认清零」时渲染），才是可信的终态信号。
    expect(await screen.findByText('当前没有待你处理的事项')).toBeTruthy();
    expect(screen.queryByTestId('inbox-section-agentFailures')).toBeNull();

    cleanup();
    vi.mocked(loadInbox).mockResolvedValue(
      sections(ready('agentFailures', [], { total: null, degraded: true, windowHours: 24 })),
    );
    renderPage();
    expect(await screen.findByTestId('inbox-section-agentFailures')).toBeTruthy();
  });
});

// ── ③ 行内 errorMessage + 深链 ────────────────────────────────────────────────

describe('R279 ③ 行数据：errorMessage 可见且深链到会话详情', () => {
  it('loadInbox 请求 failed 行：`status=failed` + `since` + `pageSize=100`（**只取 failed**）', async () => {
    const get = mockBackend({
      failures: { items: [failedSession('s1', 'AI 路由不可用/未配置')], total: 1 },
      counts: { failedSessions: 1, failedWindowHours: 24 },
    });

    await loadInbox();

    const call = get.mock.calls.find(
      ([url, config]) => url === '/agent/sessions' && (config?.params as { status?: string })?.status === 'failed',
    );
    expect(call).toBeTruthy();
    const params = call![1]?.params as Record<string, unknown>;
    // 行只取 failed：`budget_exceeded` 的处置路径不同（brief D2），**不许**顺手合并。
    expect(params.status).toBe('failed');
    expect(params.pageSize).toBe(100);
    expect(params.page).toBe(1);
    // `since` 是新增可选 query，默认窗口 24h。
    const since = Date.parse(String(params.since));
    expect(Number.isFinite(since)).toBe(true);
    expect(Date.now() - since).toBeGreaterThan(23.9 * 3_600_000);
    expect(Date.now() - since).toBeLessThan(24.1 * 3_600_000);
    expect(failedWindowSince(24)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('`failedWindowHours` 是配置：行窗口跟随它（48h），不相加两种成因', async () => {
    // 顺序刻意的：计数先回来才知道配置窗口。若行固定用默认 24h 而配置是 48h，
    // 「计数 5 / 行 2」会把「窗口差」混进 budgetExcluded 告警里 ⇒ 结论说错。
    const get = mockBackend({
      failures: { items: [], total: 0 },
      counts: { failedSessions: 0, failedWindowHours: 48 },
    });

    const sections = await loadInbox();

    const params = get.mock.calls
      .filter(([url]) => url === '/agent/sessions')
      .map(([, config]) => config?.params as { status?: string; since?: string })
      .find((p) => p?.status === 'failed');
    const age = Date.now() - Date.parse(String(params?.since));
    expect(age).toBeGreaterThan(47.9 * 3_600_000);
    expect(age).toBeLessThan(48.1 * 3_600_000);
    // 窗口标签跟着配置走，不是写死 24。
    expect(sections.agentFailures.windowHours).toBe(48);
  });

  it('行内渲染 errorMessage 原文（未超长时不加省略号），并深链 `/agent-sessions?session=…`', async () => {
    vi.mocked(loadInbox).mockResolvedValue(
      sections(
        ready('agentFailures', [failureItem('s1', 'AI 路由不可用/未配置')], {
          total: 1, rowTotal: 1, returned: 1, windowHours: 24,
        }),
      ),
    );
    renderPage();

    const row = within(await screen.findByTestId('inbox-row-agentFailures'));
    expect(row.getByText('会话 s1')).toBeTruthy();
    // D4：失败原因必须一眼可见（不能只给个数字让他挨个点开）。
    expect(row.getByText('AI 路由不可用/未配置')).toBeTruthy();
    const link = row.getByRole('link');
    expect(link.getAttribute('href')).toBe('/agent-sessions?session=s1&status=failed');
  });

  it('会话没有 errorMessage ⇒ 明说「未记录失败原因」，不留白', async () => {
    vi.mocked(loadInbox).mockResolvedValue(
      sections(ready('agentFailures', [failureItem('s2')], { total: 1, rowTotal: 1, returned: 1, windowHours: 24 })),
    );
    renderPage();
    const row = within(await screen.findByTestId('inbox-row-agentFailures'));
    expect(row.getByText('会话未记录失败原因')).toBeTruthy();
  });

  it('超长 errorMessage 截断到 120 字符 + 省略号（省略号是「后面还有」的证据）', () => {
    const long = 'E'.repeat(500);
    const cut = truncateFailureReason(long);
    expect(cut).toBe(`${'E'.repeat(FAILED_REASON_MAX_CHARS)}…`);
    expect(cut!.length).toBe(FAILED_REASON_MAX_CHARS + 1);
    // 边界：恰好等于上限 ⇒ 不截（不制造假省略号）。
    expect(truncateFailureReason('E'.repeat(FAILED_REASON_MAX_CHARS))).toBe('E'.repeat(FAILED_REASON_MAX_CHARS));
    // 空/空白 ⇒ undefined（不编造原因）。
    expect(truncateFailureReason(null)).toBeUndefined();
    expect(truncateFailureReason('   ')).toBeUndefined();

    // 端到端：仓储返回的那一行，页面渲染的是截断后的文本。
    const item = { ...failureItem('s3'), subtitle: truncateFailureReason(long) };
    vi.mocked(loadInbox).mockResolvedValue(
      sections(ready('agentFailures', [item], { total: 1, rowTotal: 1, returned: 1, windowHours: 24 })),
    );
    renderPage();
    return screen.findByTestId('inbox-row-agentFailures').then(() => {
      const row = within(screen.getByTestId('inbox-row-agentFailures'));
      expect(row.getByText(cut!)).toBeTruthy();
    });
  });
});

// ── ④ 不进会话求和 ────────────────────────────────────────────────────────────

describe('R279 ④ 失败数**不**进入会话求和，但独立可显示', () => {
  it('summarizeInboxCounts 不含 agentFailures：同一会话先 failed 后重跑不重复计', () => {
    const c = counts({ deployments: 1, agentWaiting: 2, agentFailures: 5 });
    // 1 + 2 = 3，失败数 5 不进求和（相加会把「窗口内先 failed 又被修好」的会话算两次）。
    expect(summarizeInboxCounts(c)).toBe(3);
    // 但徽标要能单独显示它。
    expect(splitInboxCounts(c).failed).toBe(5);
  });

  it('失败数读不到也不影响总数（它是独立项，不是求和项）', () => {
    const c = counts({ deployments: 1, agentWaiting: 2, agentFailures: null });
    expect(summarizeInboxCounts(c)).toBe(3);
    expect(splitInboxCounts(c).failed).toBeNull();
  });

  it('端到端：`failedSessions: 5` 时徽标总数仍是会话去重和，失败另开一句', async () => {
    mockBackend({ counts: { pendingApprovals: 1, waitingSessions: 2, deployments: 1, failedSessions: 5 } });
    // 用**未被 spy 的**路径（loadInbox）确认契约字段真的被读到 5：徽标测试若建立在
    // 「上一个用例留下的 mockResolvedValue」上，文件顺序一变就会假绿/假红。
    const sections = await loadInbox();
    expect(sections.agentFailures.total).toBe(5);

    const map = counts({ deployments: 1, agentApprovals: 1, agentWaiting: 2, agentFailures: 5 });
    expect(summarizeInboxCounts(map)).toBe(3); // 1 + 2，失败 5 不进求和

    vi.mocked(loadInboxCounts).mockResolvedValue(map);
    render(<MemoryRouter><InboxBadge /></MemoryRouter>);
    await screen.findByTestId('inbox-badge-button');
    // waitFor：徽标先渲染 loading 的「—」，计数是后续异步落地的。
    await waitFor(() => expect(screen.getByTestId('inbox-badge-failed').textContent).toBe('会话失败 5'));
  });
});

// ── 口径差：计数含 budget_exceeded，行只 failed ───────────────────────────────

describe('R279 计数含 budget_exceeded、行只 failed：差值必须显式说明', () => {
  it('计数 5 / 行 3 ⇒ 差值 2 走 budgetExcluded 告警，截断按 rowTotal 判定（不是「漏了 2 条」）', async () => {
    vi.mocked(loadInbox).mockResolvedValue(
      sections(
        ready('agentFailures', [failureItem('s1', 'a'), failureItem('s2', 'b'), failureItem('s3', 'c')], {
          total: 5, rowTotal: 3, returned: 3, truncated: false, windowHours: 24,
        }),
      ),
    );
    renderPage();

    const section = within(await screen.findByTestId('inbox-section-agentFailures'));
    // 差值不是截断：不出现「显示前 3 条（共 5 条）」这种把两类会话混成一个集合的说法。
    expect(section.queryByTestId('inbox-truncated-agentFailures')).toBeNull();
    expect(screen.getByTestId('inbox-count-agentFailures').textContent).not.toContain('显示前');
    // 但它必须以「另一类会话」的说法单独出现。
    expect(section.getByTestId('inbox-budget-excluded-agentFailures').textContent)
      .toContain('另有 2 条预算耗尽');
  });

  it('行集合被上限截断时，标题的「共 M 条」用的是 rowTotal（行口径），不是计数口径', () => {
    const section = ready('agentFailures', [], {
      total: 500, rowTotal: 240, returned: 100, truncated: true,
    });
    expect(describeSectionCount(section)).toEqual({ kind: 'truncated', returned: 100, total: 240 });
    // 差值仍单独说明（500 - 240 = 260 条预算耗尽类，不在这个列表里）。
    expect(budgetExcludedCount(section)).toBe(260);
  });

  it('计数与行同口径（纯 failed，无 budget_exceeded）⇒ 不出「另有 N 条」告警', () => {
    const section = ready('agentFailures', [failureItem('s1', 'x')], { total: 1, rowTotal: 1, returned: 1 });
    expect(budgetExcludedCount(section)).toBe(0);
  });
});

// ── 全空态的守卫：数字对、结论错的那一类 ──────────────────────────────────────

describe('R279 全空态：计数 > 行 ⇒ 不许渲染「当前没有待你处理的事项」', () => {
  it('pendingBeyondRows：只算「计数里算、行里没有」的差', () => {
    expect(pendingBeyondRows(sections(ready('agentFailures', [], { total: 5, rowTotal: 0 })))).toBe(5);
    expect(pendingBeyondRows(sections(ready('agentFailures', [], { total: 0, rowTotal: 0 })))).toBe(0);
    // 读不到 ⇒ 不参与该差值（未知由 hasUncertainCounts 单独判）。
    expect(pendingBeyondRows(sections(ready('agentFailures', [], { total: null })))).toBe(0);
  });

  it('isInboxAllClear：读取错误 / 未知计数 / 停摆 / 只计入总数 四种情形都不算清零', () => {
    expect(isInboxAllClear(sections(ready('agentFailures', [], { total: 0, rowTotal: 0 })))).toBe(true);
    expect(isInboxAllClear(sections(ready('agentFailures', [], { total: null, degraded: true })))).toBe(false);
    expect(isInboxAllClear(sections(ready('agentFailures', [], { total: 5, rowTotal: 0 })))).toBe(false);
    expect(
      isInboxAllClear(sections({ key: 'agentFailures', status: 'error', items: [], error: new Error('boom') })),
    ).toBe(false);
    const stalled = sections(ready('agentFailures', [], { total: 0, rowTotal: 0 }));
    expect(isInboxAllClear({ ...stalled, queueStall: ready('queueStall', [], {
      snapshot: { stalled: true, reason: 'no worker', pendingJobs: 3, degraded: false, degradedCounts: false, workersKnown: true },
    }) })).toBe(false);
  });

  it('页面层：失败 5 条只在计数里、行 0 ⇒ **不**渲染全空态', async () => {
    vi.mocked(loadInbox).mockResolvedValue(
      sections(ready('agentFailures', [], { total: 5, rowTotal: 0, returned: 0, windowHours: 24 })),
    );
    renderPage();
    await screen.findByTestId('inbox-section-agentFailures');
    expect(screen.queryByText('当前没有待你处理的事项')).toBeNull();
  });
});

// ── 小节失败隔离（既有纪律，新小节同样遵守） ─────────────────────────────────

describe('R279 小节隔离：失败源挂掉只让它自己是 error 态', () => {
  it('`/agent/sessions?status=failed` 抛错 ⇒ agentFailures error（带重试），其余小节照常 ready', async () => {
    vi.spyOn(client, 'get').mockImplementation(async (url, config) => {
      if (url === '/agent/sessions' && (config?.params as { status?: string })?.status === 'failed') {
        throw new Error('boom');
      }
      if (url === '/agent/inbox/counts') {
        return { pendingApprovals: 0, waitingSessions: 0, stalled: 0, backlogged: 0, deployments: 0, queueStall: 0, degraded: false };
      }
      if (url === '/agent/sessions') return { items: [], total: 0 };
      if (url === '/agent/approvals/pending') return { items: [], total: 0, sessionTotal: 0, returned: 0, truncated: false, degraded: false };
      if (url === '/sop/assignments/lagging') return { items: [], total: 0, returned: 0, truncated: false, degraded: false };
      if (url === '/app-deployments/approvals/pending') return { data: [], total: 0 };
      if (url === '/agent/sessions/backlogged') return { sessionIds: [], probed: 0, truncated: false };
      if (url === '/agent/sessions/queue-stall') return { stalled: false, reason: null, pendingJobs: 0, degraded: false, degradedCounts: false, workersKnown: true };
      if (url === '/metrics/failures') return [];
      throw new Error(`Unexpected request: ${url}`);
    });

    const result = await loadInbox();
    expect(result.agentFailures.status).toBe('error');
    // 不渲染成空列表：error 态带空 items，但 status 决定页面走重试分支。
    expect(result.agentFailures.items).toEqual([]);
    expect(result.deployments.status).toBe('ready');
    expect(result.recentFailures.status).toBe('ready');
    // error 态不携带计数（`undefined` = 该小节此刻没有可用总数），但**绝不**是 0。
    expect(result.agentFailures.total).not.toBe(0);
    expect(describeSectionCount(result.agentFailures)).toEqual({ kind: 'none' });
  });

  it('页面层：失败小节 error ⇒ 呈现重试按钮，而不是「本类暂无待办」', async () => {
    vi.mocked(loadInbox).mockResolvedValue(
      sections({ key: 'agentFailures', status: 'error', items: [], error: new Error('boom') }),
    );
    renderPage();
    const section = within(await screen.findByTestId('inbox-section-agentFailures'));
    expect(section.getByRole('button', { name: /重\s*试/ })).toBeTruthy();
    expect(section.queryByText('本类暂无待办')).toBeNull();
  });
});

// ── 新增小节的位置与 agentApi 方法独立（不混进 list 的调用计数） ─────────────

describe('R279 小节位置与请求形状', () => {
  it('`agentFailures` 紧跟在 `agentWaiting` 之后（不插到别处）', () => {
    expect(INBOX_SECTIONS.indexOf('agentFailures')).toBe(INBOX_SECTIONS.indexOf('agentWaiting') + 1);
    // R280/R286 契约变更：新小节追加，`agentFailures` 与 `agentWaiting` 的相对位置
    // 不变，长度从 8 → 9（R280）→ 10（R286，`sopBlocked`）。这是**事实更新**，
    // 不是既有断言被「修」到能过。
    expect(INBOX_SECTIONS).toHaveLength(10);
  });

  it('失败行走**独立**方法（不污染 `agentApi.list` 的调用计数）', async () => {
    mockBackend({ failures: { items: [], total: 0 } });
    const list = vi.spyOn(agentApi, 'list');
    const listFailed = vi.spyOn(agentApi, 'listFailedSessions');

    await loadInbox();

    expect(listFailed).toHaveBeenCalledTimes(1);
    expect(listFailed.mock.calls[0][0]).toMatchObject({ page: 1, pageSize: 100 });
    // 既有断言「list 被调了几次」的用例不受影响：失败行另起一个方法。
    expect(list.mock.calls.some(([p]) => (p as { status?: string } | undefined)?.status === 'failed')).toBe(false);
  });
});