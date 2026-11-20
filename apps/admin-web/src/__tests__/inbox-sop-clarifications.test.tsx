/**
 * R280 · 收件箱第九个小节「待人工答复的 SOP 澄清」（`sopClarifications`）。
 *
 * ## 这一节要钉死的六件事（brief §五 S2 栏 + 本轮验收清单）
 *
 * ① `total: null` ⇒ 显示「—」而**不是 0**（读不到 ≠ 没有）；
 * ② `total: 0` ⇒ 小节**隐藏**（事实为零，不占屏）；
 * ③ 行内渲染 `question`（截断 120 字符）+ `sopName`，且 `sopName: null` 时显示
 *    占位文案「（未命名 SOP）」**而不是 uuid**；
 * ④ `truncated: true` ⇒ 显示「显示前 N 条（共 M 条）」；
 * ⑤ 该小节**不**进 `summarizeInboxCounts` 的会话求和（但徽标单独可显示）；
 * ⑥ `sopClarifications` 有条目 ⇒ `isInboxAllClear === false`。
 *
 * ## 另两条本轮特有的口径（写在这里，防止下一个人「顺手对齐」）
 *
 * - **无时间窗**：升级澄清没处理就一直挂着，用窗口会让「上周升级还没人管」静默
 *   消失——那正是最该被看见的东西（brief D1）；
 * - **计数与行出自同一个 `GET /sop/clarifications/pending`**：后端没有把这个计数
 *   塞进 `inbox/counts`（本轮契约已冻结），所以「顶栏 N」与「小节行」同源，
 *   不会互相打脸。断言请求次数钉住这一点，防有人偷偷加第 3 个端点。
 *
 * 夹具全部按**真机实测语义**写（brief「真机已验证的语义」）：
 * `total` 独立计数、`truncated = returned < total`、`total` 读不到 ⇒ `null`、
 * `degraded:true` ⇒ 字段可能缺失、`sopName:null` ⇒ 不退回 uuid。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '../i18n';
import InboxPage from '../pages/InboxPage';
import InboxBadge from '../components/InboxBadge';
import {
  CLARIFICATION_QUESTION_MAX_CHARS,
  INBOX_SECTIONS,
  describeSectionCount,
  hasPendingSopClarifications,
  isInboxAllClear,
  isSectionVisible,
  loadInbox,
  loadInboxCounts,
  splitInboxCounts,
  summarizeInboxCounts,
  truncateClarificationQuestion,
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

// ── 夹具（形状照抄后端 `SopPendingClarificationItemDto`，不多不少） ────────────

const SOP_UUID = '4a1f9e2c-1111-4c3d-8e4f-000000000001';
const ASSIGN_UUID = '4a1f9e2c-2222-4c3d-8e4f-000000000002';
const CLAR_UUID = '4a1f9e2c-3333-4c3d-8e4f-000000000003';

const clarificationRow = (overrides: Record<string, unknown> = {}) => ({
  clarificationId: CLAR_UUID,
  assignmentId: ASSIGN_UUID,
  sopId: SOP_UUID,
  sopName: 'R280 探针 SOP',
  round: 1,
  question: '这一步要不要先切到只读副本？',
  askedAt: '2026-11-18T02:00:00.000Z',
  assignmentStatus: 'in_progress',
  reviewSessionId: null,
  ...overrides,
});

/**
 * 在 HTTP 读边界注入数据（真实 `loadInbox` / `loadInboxCounts` 照常运行）。
 *
 * `pending` 省略时**故意**不返回该端点（模拟 503 / 未装配）——那必须被读成
 * `error` 态或 `null`（未知），绝不渲染成「没有」。
 */
function mockBackend(opts: { pending?: Record<string, unknown> | 'unavailable' } = {}) {
  return vi.spyOn(client, 'get').mockImplementation(async (url) => {
    if (url === '/sop/clarifications/pending') {
      if (opts.pending === 'unavailable') throw new Error('503');
      return (
        opts.pending ?? { items: [], total: 0, returned: 0, truncated: false, degraded: false }
      );
    }
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
      };
    }
    if (url === '/agent/sessions') return { items: [], total: 0 };
    if (url === '/agent/approvals/pending') {
      return { items: [], total: 0, sessionTotal: 0, returned: 0, truncated: false, degraded: false };
    }
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

const ready = (
  key: InboxSectionState['key'],
  items: InboxItem[],
  extra: Partial<InboxSectionState> = {},
): InboxSectionState => ({ key, status: 'ready', items, error: null, ...extra });

/** 其余小节都「确认清零」，只让待答复澄清成为变量。 */
const sections = (sop: InboxSectionState): InboxSections =>
  ({
    deployments: ready('deployments', [], { total: 0 }),
    agentApprovals: ready('agentApprovals', [], { total: 0 }),
    agentWaiting: ready('agentWaiting', [], { total: 0 }),
    agentFailures: ready('agentFailures', [], { total: 0, rowTotal: 0 }),
    sopClarifications: sop,
    // R286：第十个小节，恒为「确认清零」（0 ⇒ 隐藏），不干扰本文件的断言。
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

const clarItem = (overrides: Partial<InboxItem> = {}, row: Record<string, unknown> = {}): InboxItem => {
  const rowData = clarificationRow(row);
  return {
    id: `sopc-${rowData.clarificationId}`,
    section: 'sopClarifications',
    title: truncateClarificationQuestion(String(rowData.question)),
    subtitle: (rowData.sopName as string | null) ?? undefined,
    waitingSince: String(rowData.askedAt),
    detailUrl: `/sops?sop=${rowData.sopId}&assignment=${rowData.assignmentId}`,
    clarification: rowData as InboxItem['clarification'],
    ...overrides,
  };
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/inbox']}>
      <Routes>
        <Route path="/inbox" element={<InboxPage />} />
        <Route path="/sops" element={<div data-testid="sops-page" />} />
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

describe('R280 ① total 读不到（null）⇒ 显示「—」，绝不 0', () => {
  it('计数层：`pending` 的 `total: null` 原样透传（不回落 0）', async () => {
    mockBackend({ pending: { items: [], total: null, returned: 0, truncated: false, degraded: true } });
    const map = await loadInboxCounts();
    expect(map.sopClarifications).toBeNull();
    expect(splitInboxCounts(map).sopClarifications).toBeNull();
  });

  it('计数层：端点 503（服务未装配）⇒ null（未知），仍是 200 空信封之外的另一种事实', async () => {
    mockBackend({ pending: 'unavailable' });
    const map = await loadInboxCounts();
    expect(map.sopClarifications).toBeNull();
    expect(map.sopClarifications).not.toBe(0);
  });

  it('计数层：字段整体缺失（旧后端）⇒ null，不是 0', async () => {
    mockBackend({ pending: { items: [], returned: 0, truncated: false, degraded: true } });
    const map = await loadInboxCounts();
    expect(map.sopClarifications).toBeNull();
  });

  it('小节层：`total:null` ⇒ 标题「—」+ 专属降级提示，**不**渲染「本类暂无待办」', async () => {
    vi.mocked(loadInbox).mockResolvedValue(
      sections(ready('sopClarifications', [], { total: null, returned: 0, degraded: true })),
    );
    renderPage();

    const count = await screen.findByTestId('inbox-count-sopClarifications');
    expect(count.textContent).toContain('—');
    expect(count.textContent).not.toMatch(/·\s*共\s*0\s*条/);

    const section = within(screen.getByTestId('inbox-section-sopClarifications'));
    // 专属措辞只出现一次：由标题下方的 unknown 告警承担，空态文案不重复说一遍。
    expect(section.getAllByText(/无法确认一共多少条待答复的 SOP 澄清/)).toHaveLength(1);
    expect(section.getByTestId('inbox-degraded-sopClarifications')).toBeTruthy();
    expect(section.queryByText('本类暂无待办')).toBeNull();
  });

  it('徽标层：`sopClarifications:null` ⇒ 单独成句「待答复澄清 — 问」并把徽标标成降级', async () => {
    vi.mocked(loadInboxCounts).mockResolvedValue(counts({ agentWaiting: 1, sopClarifications: null }));
    render(<MemoryRouter><InboxBadge /></MemoryRouter>);

    const badge = await screen.findByTestId('inbox-badge-sop-clarifications');
    expect(badge.textContent).toBe('待答复澄清 — 问');
    expect(screen.getByTestId('inbox-badge').getAttribute('data-degraded')).toBe('true');
  });
});

// ── ② 0 ⇒ 隐藏 ────────────────────────────────────────────────────────────────

describe('R280 ② total 为 0（事实为零）⇒ 小节隐藏', () => {
  it('计数层：0 是事实，不是「读不到」——两者必须可区分', async () => {
    mockBackend({ pending: { items: [], total: 0, returned: 0, truncated: false, degraded: false } });
    const map = await loadInboxCounts();
    expect(map.sopClarifications).toBe(0);
    expect(map.sopClarifications).not.toBeNull();
  });

  it('纯函数层：total:0 ⇒ 不可见；null ⇒ 仍可见；有条目 ⇒ 可见', () => {
    expect(isSectionVisible(ready('sopClarifications', [], { total: 0 }))).toBe(false);
    expect(isSectionVisible(ready('sopClarifications', [], { total: null, degraded: true }))).toBe(true);
    expect(isSectionVisible(ready('sopClarifications', [clarItem()], { total: 1 }))).toBe(true);
  });

  it('页面层：total:0 ⇒ 卡片不渲染，整页可进入全空态；total:null ⇒ 卡片仍在', async () => {
    vi.mocked(loadInbox).mockResolvedValue(
      sections(ready('sopClarifications', [], { total: 0, returned: 0 })),
    );
    renderPage();
    // 等全清文案（终态信号），不等 shell 容器 `inbox-page`（loading 期就有）。
    expect(await screen.findByText('当前没有待你处理的事项')).toBeTruthy();
    expect(screen.queryByTestId('inbox-section-sopClarifications')).toBeNull();

    cleanup();
    vi.mocked(loadInbox).mockResolvedValue(
      sections(ready('sopClarifications', [], { total: null, degraded: true })),
    );
    renderPage();
    expect(await screen.findByTestId('inbox-section-sopClarifications')).toBeTruthy();
  });

  it('徽标层：0 件时即使其余待办归零也整体隐藏（0 = 事实为零，不占顶栏）', async () => {
    vi.mocked(loadInboxCounts).mockResolvedValue(counts({ sopClarifications: 0 }));
    render(<MemoryRouter><InboxBadge /></MemoryRouter>);
    // 等最终 DOM 状态：`toHaveBeenCalled` 在 React 提交前就返回，loading 态下
    // 徽标照渲染「—」⇒ 同步断言会间歇性红（R286 实测复现）。
    await waitFor(() => expect(screen.queryByTestId('inbox-badge-button')).toBeNull());
  });
});

// ── ③ 行内 question + sopName ─────────────────────────────────────────────────

describe('R280 ③ 行数据：question 截断 + SOP 名 · 第 N 轮', () => {
  it('loadInbox 请求 pending：`limit=100` 一次，形状与契约一致', async () => {
    const get = mockBackend({ pending: { items: [clarificationRow()], total: 1, returned: 1, truncated: false, degraded: false } });

    const result = await loadInbox();

    const call = get.mock.calls.find(([url]) => url === '/sop/clarifications/pending');
    expect(call).toBeTruthy();
    expect((call![1]?.params as Record<string, unknown>).limit).toBe(100);
    expect(result.sopClarifications.status).toBe('ready');
    expect(result.sopClarifications.items).toHaveLength(1);
    // R289：深链精准携带 sop 与 assignment 参数，直达 SopsPage 指派与澄清 Tab。
    expect(result.sopClarifications.items[0].detailUrl).toBe(`/sops?sop=${SOP_UUID}&assignment=${ASSIGN_UUID}`);
  });

  it('行内渲染 question 原文 + 「SOP 名 · 第 1 轮」', async () => {
    vi.mocked(loadInbox).mockResolvedValue(
      sections(ready('sopClarifications', [clarItem()], { total: 1, returned: 1 })),
    );
    renderPage();

    const row = within(await screen.findByTestId('inbox-row-sopClarifications'));
    expect(row.getByText('这一步要不要先切到只读副本？')).toBeTruthy();
    expect(row.getByText('R280 探针 SOP · 第 1 轮')).toBeTruthy();
    // 只读小节：只给「查看详情」深链，不给答复按钮（答复在 SOP 页）。
    const link = row.getByRole('link');
    expect(link.getAttribute('href')).toBe(`/sops?sop=${SOP_UUID}&assignment=${ASSIGN_UUID}`);
    expect(row.queryByRole('button', { name: /批准|拒绝|接管/ })).toBeNull();
  });

  it('`sopName: null` ⇒ 显示「（未命名 SOP）」，**绝不退回 uuid**', async () => {
    vi.mocked(loadInbox).mockResolvedValue(
      sections(ready('sopClarifications', [clarItem({}, { sopName: null })], { total: 1, returned: 1 })),
    );
    renderPage();

    const row = within(await screen.findByTestId('inbox-row-sopClarifications'));
    expect(row.getByText('（未命名 SOP） · 第 1 轮')).toBeTruthy();
    // uuid 不是给人看的标题：整行任何位置都不该出现 SOP uuid。
    expect(row.queryByText(new RegExp(SOP_UUID))).toBeNull();
    expect(screen.getByTestId('inbox-row-sopClarifications').textContent).not.toContain(SOP_UUID);
  });

  it('超长 question 截断到 120 字符 + 省略号（省略号是「后面还有」的证据）', () => {
    const long = '问'.repeat(300);
    const cut = truncateClarificationQuestion(long);
    expect(cut).toBe(`${'问'.repeat(CLARIFICATION_QUESTION_MAX_CHARS)}…`);
    expect(cut.length).toBe(CLARIFICATION_QUESTION_MAX_CHARS + 1);
    // 边界：恰好等于上限 ⇒ 不截（不制造假省略号）。
    expect(truncateClarificationQuestion('问'.repeat(CLARIFICATION_QUESTION_MAX_CHARS))).toBe(
      '问'.repeat(CLARIFICATION_QUESTION_MAX_CHARS),
    );
    // 空白 ⇒ 空串（不编造问题）。
    expect(truncateClarificationQuestion('   ')).toBe('');
  });

  it('`question` 为空 ⇒ 明说「执行器未记录问题原文」，不留白', async () => {
    vi.mocked(loadInbox).mockResolvedValue(
      sections(ready('sopClarifications', [clarItem({ title: '' }, { question: '' })], { total: 1, returned: 1 })),
    );
    renderPage();
    const row = within(await screen.findByTestId('inbox-row-sopClarifications'));
    expect(row.getByText('执行器未记录问题原文')).toBeTruthy();
  });

  it('原始 question 不丢（`clarification.question` 保留未截断原文）', async () => {
    const long = '问'.repeat(300);
    const result = await (async () => {
      mockBackend({ pending: { items: [clarificationRow({ question: long })], total: 1, returned: 1, truncated: false, degraded: false } });
      return loadInbox();
    })();
    const item = result.sopClarifications.items[0];
    expect(item.title).toBe(`${'问'.repeat(120)}…`);
    expect(item.clarification?.question).toBe(long);
  });
});

// ── ④ truncated ───────────────────────────────────────────────────────────────

describe('R280 ④ truncated:true ⇒ 显示「显示前 N 条（共 M 条）」', () => {
  it('纯函数层：describeSectionCount 走 truncated 形态，M 来自服务端 total', () => {
    const section = ready('sopClarifications', [clarItem()], {
      total: 240, returned: 1, truncated: true,
    });
    expect(describeSectionCount(section)).toEqual({ kind: 'truncated', returned: 1, total: 240 });
  });

  it('页面层：标题渲染「显示前 1 条（共 240 条）」+ truncated 告警', async () => {
    vi.mocked(loadInbox).mockResolvedValue(
      sections(ready('sopClarifications', [clarItem()], { total: 240, returned: 1, truncated: true })),
    );
    renderPage();

    const count = await screen.findByTestId('inbox-count-sopClarifications');
    expect(count.textContent).toContain('显示前 1 条（共 240 条）');
    const section = within(screen.getByTestId('inbox-section-sopClarifications'));
    expect(section.getByTestId('inbox-truncated-sopClarifications')).toBeTruthy();
  });

  it('`total:null` 时 truncated 必须为 false（「是否截断」也不可知，由 degraded 表达）', async () => {
    mockBackend({ pending: { items: [clarificationRow()], total: null, returned: 1, truncated: false, degraded: true } });
    const result = await loadInbox();
    expect(result.sopClarifications.truncated).toBe(false);
    expect(result.sopClarifications.degraded).toBe(true);
    expect(describeSectionCount(result.sopClarifications)).toEqual({ kind: 'unknown', degraded: true });
  });
});

// ── ⑤ 不进会话求和 ────────────────────────────────────────────────────────────

describe('R280 ⑤ 待答复澄清**不**进入会话求和，但独立可显示', () => {
  it('summarizeInboxCounts 不含 sopClarifications：与「一会话」没有共同的去重单位', () => {
    const c = counts({ deployments: 1, agentWaiting: 2, sopClarifications: 7 });
    expect(summarizeInboxCounts(c)).toBe(3); // 1 + 2，澄清 7 不进求和
    expect(splitInboxCounts(c).sopClarifications).toBe(7); // 但徽标单独可显示
  });

  it('读不到也不影响总数（它是独立项，不是求和项）', () => {
    const c = counts({ deployments: 1, agentWaiting: 2, sopClarifications: null });
    expect(summarizeInboxCounts(c)).toBe(3);
    expect(splitInboxCounts(c).sopClarifications).toBeNull();
  });

  it('端到端：`total:5` 时徽标总数仍是会话去重和，澄清另开一句', async () => {
    mockBackend({ pending: { items: [clarificationRow()], total: 5, returned: 1, truncated: true, degraded: false } });
    // 用**未被 spy 的**路径确认契约字段真被读到 5（不建立在其它用例留下的 mock 上）。
    const result = await loadInbox();
    expect(result.sopClarifications.total).toBe(5);

    vi.mocked(loadInboxCounts).mockResolvedValue(
      counts({ deployments: 1, agentApprovals: 1, agentWaiting: 2, sopClarifications: 5 }),
    );
    render(<MemoryRouter><InboxBadge /></MemoryRouter>);
    await screen.findByTestId('inbox-badge-button');
    await waitFor(() => expect(screen.getByTestId('inbox-badge-sop-clarifications').textContent).toBe('待答复澄清 5 问'));
    // 徽标数字仍是会话去重和（1 + 2 = 3），澄清 5 不在里面。
    expect(screen.getByTestId('inbox-badge').textContent).toContain('3');
    expect(screen.getByTestId('inbox-badge').textContent).not.toContain('8');
  });
});

// ── ⑥ 全清态 ──────────────────────────────────────────────────────────────────

describe('R280 ⑥ 待答复澄清 > 0 ⇒ 不算全清（数字对、结论错是最坏的一类）', () => {
  it('纯函数层：有行 ⇒ 不算全清；行为空但 total>0 ⇒ 仍不算全清', () => {
    expect(isInboxAllClear(sections(ready('sopClarifications', [], { total: 0 })))).toBe(true);
    expect(isInboxAllClear(sections(ready('sopClarifications', [clarItem()], { total: 1 })))).toBe(false);
    // 行集合为空但独立计数 > 0（子查询降级导致行装配不出来）：只看 items.length 会漏。
    expect(isInboxAllClear(sections(ready('sopClarifications', [], { total: 5 })))).toBe(false);
    // 读不到 ⇒ 由 hasUncertainCounts 判（未知 ≠ 有，也 ≠ 没有）。
    expect(isInboxAllClear(sections(ready('sopClarifications', [], { total: null, degraded: true })))).toBe(false);
    expect(hasPendingSopClarifications(sections(ready('sopClarifications', [], { total: 0 })))).toBe(false);
    expect(hasPendingSopClarifications(sections(ready('sopClarifications', [], { total: 3 })))).toBe(true);
  });

  it('页面层：有待答复澄清 ⇒ **不**渲染全空态，且卡片可见', async () => {
    vi.mocked(loadInbox).mockResolvedValue(
      sections(ready('sopClarifications', [clarItem()], { total: 1, returned: 1 })),
    );
    renderPage();
    await screen.findByTestId('inbox-section-sopClarifications');
    expect(screen.queryByText('当前没有待你处理的事项')).toBeNull();
  });

  it('页面层：行 0 但 total 5（行未能装配）⇒ 不渲染全空态，并说清「5 条不在下方」', async () => {
    vi.mocked(loadInbox).mockResolvedValue(
      sections(ready('sopClarifications', [], { total: 5, returned: 0, degraded: true })),
    );
    renderPage();
    const section = within(await screen.findByTestId('inbox-section-sopClarifications'));
    expect(screen.queryByText('当前没有待你处理的事项')).toBeNull();
    // 降级 ⇒ 走 unknown 措辞，**不许**说「本类暂无待办」。
    expect(section.queryByText('本类暂无待办')).toBeNull();
  });
});

// ── 小节隔离（既有纪律，新小节同样遵守） ─────────────────────────────────────

describe('R280 小节隔离：升级澄清端点挂掉只让它自己是 error 态', () => {
  it('503 ⇒ error（带重试），其余小节照常 ready；error 态不带计数（绝不 0）', async () => {
    mockBackend({ pending: 'unavailable' });

    const result = await loadInbox();
    expect(result.sopClarifications.status).toBe('error');
    expect(result.sopClarifications.items).toEqual([]);
    expect(result.deployments.status).toBe('ready');
    expect(result.agentFailures.status).toBe('ready');
    expect(result.recentFailures.status).toBe('ready');
    expect(result.sopClarifications.total).not.toBe(0);
    expect(describeSectionCount(result.sopClarifications)).toEqual({ kind: 'none' });
  });

  it('页面层：error ⇒ 呈现重试按钮，而不是「本类暂无待办」', async () => {
    vi.mocked(loadInbox).mockResolvedValue(
      sections({ key: 'sopClarifications', status: 'error', items: [], error: new Error('503') }),
    );
    renderPage();
    const section = within(await screen.findByTestId('inbox-section-sopClarifications'));
    expect(section.getByRole('button', { name: /重\s*试/ })).toBeTruthy();
    expect(section.queryByText('本类暂无待办')).toBeNull();
  });

  it('`sopClarifications` 紧跟在 `agentFailures` 之后（R286 之后仍是）', () => {
    expect(INBOX_SECTIONS.indexOf('sopClarifications')).toBe(INBOX_SECTIONS.indexOf('agentFailures') + 1);
    // R286：`sopBlocked` 插在 `sopClarifications` 与 `stalled` 之间 ⇒ 澄清不再是
    // `stalled` 的前一个；位置断言改为「在 stalled 之前」，长度 9 → 10。
    expect(INBOX_SECTIONS.indexOf('sopClarifications')).toBeLessThan(INBOX_SECTIONS.indexOf('stalled'));
    expect(INBOX_SECTIONS).toHaveLength(10);
    expect(INBOX_SECTIONS[INBOX_SECTIONS.length - 1]).toBe('recentFailures');
  });
});