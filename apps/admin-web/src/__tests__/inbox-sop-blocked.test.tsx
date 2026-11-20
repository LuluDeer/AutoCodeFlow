/**
 * R286 · 收件箱第十个小节「阻塞工单」（`sopBlocked`）。
 *
 * ## 这一节钉死的六件事（brief §切片B 验收清单）
 *
 * ① `total: null` ⇒ 显示「—」而**不是 0**（读不到 ≠ 没有；R278 立的纪律）；
 * ② `total: 0` ⇒ 小节**隐藏**（事实为零，不占屏）；
 * ③ 行内 `sopName: null` ⇒ 「（未命名 SOP）」**不含 uuid**；
 * ④ `truncated: true` ⇒ 「显示前 N 条（共 M 条）」；
 * ⑤ **不进** `summarizeInboxCounts` 的会话求和；
 * ⑥ 本节 > 0 ⇒ `isInboxAllClear === false`。
 *
 * ## 契约来源（2026-11-20 与 `be-assignment-reaper` 的 send_message 对话定稿）
 *
 * - `total: number | null` 是**独立 `getCount()`**：只有「读失败 / 非有限数」才 null，
 *   `0` 就是库里真 0 条 ⇒ 两种事实必须可区分；
 * - `blockedSince: string` **非 null**，且**不是**查询窗口 `hours`：
 *   `hours=N` 是筛选条件（`updatedAt <= now − N`），行内「已阻塞 X 小时」必须由
 *   `blockedSince` 现算——拿窗口值顶上会把「卡了 30 小时」显示成「24 小时」；
 * - `round: number | null`，null ⇔ 无可用 escalated 澄清（与 `staleClarificationId`
 *   同真同假）；它是**触顶/卡住的那一轮**（maxRounds=5 触顶 ⇒ 6），
 *   **不是**「当前轮次」也**不是**「已完成轮数」；
 * - `status` 谓词是字面量 `'blocked'` ⇒ 本节不按 status 分流；
 * - 服务端**没有** `limit` 参数，截断来自内部行数上限（200）⇒ `returned < total` 才算截断；
 * - 装配缺失 ⇒ **503**（不回 200 空信封）⇒ 必须读成「读不到」，不能读成「0 条」；
 * - 排序 `blockedSince` 升序 ⇒ 行直接填 `waitingSince`，不再二次排序。
 *
 * ## 与本文件之外既有断言的边界
 *
 * 本文件只碰 `sopBlocked`；`sopClarifications` 的位置/语义断言在
 * `inbox-sop-clarifications.test.tsx`（那边只把 `sopBlocked` 当「确认清零」的邻居）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '../i18n';
import InboxPage from '../pages/InboxPage';
import InboxBadge from '../components/InboxBadge';
import {
  INBOX_SECTIONS,
  SOP_BLOCKED_WINDOW_HOURS,
  blockedHours,
  describeSectionCount,
  hasBlockedAssignments,
  isInboxAllClear,
  isSectionVisible,
  loadInbox,
  loadInboxCounts,
  metaOf,
  sopAssignmentUrl,
  splitInboxCounts,
  summarizeInboxCounts,
  type InboxCountMap,
  type InboxItem,
  type InboxSectionState,
  type InboxSections,
} from '../api/inbox';
import { sopsApi } from '../api/sops';
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

// ── 夹具（形状照抄后端 `SopAssignmentLagResponseDto`，不多不少） ──────────────

const SOP_UUID = '7c2e1b90-aaaa-4bcd-9ef0-00000000000a';
const ASSIGN_UUID = '7c2e1b90-bbbb-4bcd-9ef0-00000000000b';
const CLAR_UUID = '7c2e1b90-cccc-4bcd-9ef0-00000000000c';

/** 「一小时前」的 ISO：让 `blockedHours` 有确定结果（不依赖测试机器时钟精度）。 */
const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();

const lagRow = (overrides: Record<string, unknown> = {}) => ({
  assignmentId: ASSIGN_UUID,
  sopId: SOP_UUID,
  sopName: 'R286 阻塞探针 SOP',
  status: 'blocked',
  blockedSince: hoursAgo(30),
  staleClarificationId: CLAR_UUID,
  round: 6,
  ...overrides,
});

/**
 * 在 HTTP 读边界注入数据（真实 `loadInbox` / `loadInboxCounts` 照常运行）。
 *
 * `lagging` 省略/`'unavailable'` 时**故意**让该端点抛错（模拟 503 / 未装配）——
 * 那必须被读成 error 态或 `null`（未知），绝不渲染成「没有阻塞工单」。
 */
function mockBackend(opts: { lagging?: Record<string, unknown> | 'unavailable' } = {}) {
  return vi.spyOn(client, 'get').mockImplementation(async (url) => {
    if (url === '/sop/assignments/lagging') {
      if (opts.lagging === 'unavailable') throw new Error('503');
      return opts.lagging ?? { items: [], total: 0, returned: 0, truncated: false, degraded: false };
    }
    if (url === '/sop/clarifications/pending') {
      return { items: [], total: 0, returned: 0, truncated: false, degraded: false };
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

/** 其余小节都「确认清零」，只让阻塞工单成为变量。 */
const sections = (blocked: InboxSectionState): InboxSections =>
  ({
    deployments: ready('deployments', [], { total: 0 }),
    agentApprovals: ready('agentApprovals', [], { total: 0 }),
    agentWaiting: ready('agentWaiting', [], { total: 0 }),
    agentFailures: ready('agentFailures', [], { total: 0, rowTotal: 0 }),
    sopClarifications: ready('sopClarifications', [], { total: 0 }),
    sopBlocked: blocked,
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

const blockedItem = (overrides: Partial<InboxItem> = {}, row: Record<string, unknown> = {}): InboxItem => {
  const rowData = lagRow(row);
  return {
    id: `sopb-${rowData.assignmentId}`,
    section: 'sopBlocked',
    title: (rowData.sopName as string | null) ?? '',
    waitingSince: String(rowData.blockedSince),
    detailUrl: sopAssignmentUrl(String(rowData.sopId)),
    blockedAssignment: rowData as InboxItem['blockedAssignment'],
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

// ── ① null ≠ 0（R278 立的纪律，必须钉住） ─────────────────────────────────────

describe('R286 ① total 读不到（null）⇒ 显示「—」，绝不 0', () => {
  it('计数层：`total: null` 原样透传（不回落 0）', async () => {
    mockBackend({ lagging: { items: [], total: null, returned: 0, truncated: false, degraded: true } });
    const map = await loadInboxCounts();
    expect(map.sopBlocked).toBeNull();
    expect(splitInboxCounts(map).sopBlocked).toBeNull();
  });

  it('端到端（真 loader + 真页面）：原始 `total:null` ⇒ 小节仍是 null，标题「—」', async () => {
    // 为什么必须有这一条：上面几条在**页面层**直接 mock `loadInbox`，它们的
    // `total: null` 是手写进 state 的——**绕过了 loader 的 null 处理**。
    // 把 loader 里改成 `total: meta.total ?? 0`，那些用例照样全绿（反证实测过：
    // 只有 ④ 变红）。这一条从 HTTP 原始响应一路走到 DOM，钉住「读不到不进 0」。
    mockBackend({ lagging: { items: [], total: null, returned: 0, truncated: false, degraded: true } });
    const result = await loadInbox();
    expect(result.sopBlocked.total).toBeNull();
    expect(result.sopBlocked.total).not.toBe(0);

    vi.mocked(loadInbox).mockResolvedValue(sections(result.sopBlocked));
    renderPage();
    const count = await screen.findByTestId('inbox-count-sopBlocked');
    expect(count.textContent).toContain('—');
    expect(count.textContent).not.toMatch(/共\s*0\s*条/);
  });

  it('计数层：503（服务未装配）⇒ null（未知），而不是「0 条阻塞工单」', async () => {
    mockBackend({ lagging: 'unavailable' });
    const map = await loadInboxCounts();
    expect(map.sopBlocked).toBeNull();
    expect(map.sopBlocked).not.toBe(0);
  });

  it('计数层：字段整体缺失 ⇒ null，不是 0', async () => {
    mockBackend({ lagging: { items: [], returned: 0, truncated: false, degraded: true } });
    const map = await loadInboxCounts();
    expect(map.sopBlocked).toBeNull();
  });

  it('小节层：`total:null` ⇒ 标题「—」，**不**渲染「共 0 条」，也不说「本类暂无待办」', async () => {
    vi.mocked(loadInbox).mockResolvedValue(
      sections(ready('sopBlocked', [], { total: null, returned: 0, degraded: true })),
    );
    renderPage();

    const count = await screen.findByTestId('inbox-count-sopBlocked');
    expect(count.textContent).toContain('—');
    expect(count.textContent).not.toMatch(/·\s*共\s*0\s*条/);
    // 「已阻塞 0 小时」这种把未知说成零的形态同样不许出现。
    expect(count.textContent).not.toContain('0 小时');

    const section = within(screen.getByTestId('inbox-section-sopBlocked'));
    expect(section.getByTestId('inbox-degraded-sopBlocked')).toBeTruthy();
    expect(section.queryByText('本类暂无待办')).toBeNull();
    // 降级提示用的是本节专属措辞（说的是「阻塞工单」，不是泛化的一句）。
    expect(section.getByText(/无法确认一共多少条阻塞工单/)).toBeTruthy();
  });

  it('徽标层：`sopBlocked:null` ⇒ 单独成句「阻塞工单 — 条」并把徽标标成降级', async () => {
    vi.mocked(loadInboxCounts).mockResolvedValue(counts({ agentWaiting: 1, sopBlocked: null }));
    render(<MemoryRouter><InboxBadge /></MemoryRouter>);

    const badge = await screen.findByTestId('inbox-badge-sop-blocked');
    expect(badge.textContent).toBe('阻塞工单 — 条');
    expect(screen.getByTestId('inbox-badge').getAttribute('data-degraded')).toBe('true');
  });
});

// ── ② 0 ⇒ 隐藏 ────────────────────────────────────────────────────────────────

describe('R286 ② total 为 0（事实为零）⇒ 小节隐藏', () => {
  it('计数层：0 是事实，不是「读不到」——两者必须可区分', async () => {
    mockBackend({ lagging: { items: [], total: 0, returned: 0, truncated: false, degraded: false } });
    const map = await loadInboxCounts();
    expect(map.sopBlocked).toBe(0);
    expect(map.sopBlocked).not.toBeNull();
  });

  it('纯函数层：total:0 ⇒ 不可见；null ⇒ 仍可见；有条目 ⇒ 可见', () => {
    expect(isSectionVisible(ready('sopBlocked', [], { total: 0 }))).toBe(false);
    expect(isSectionVisible(ready('sopBlocked', [], { total: null, degraded: true }))).toBe(true);
    expect(isSectionVisible(ready('sopBlocked', [blockedItem()], { total: 1 }))).toBe(true);
  });

  it('页面层：total:0 ⇒ 卡片不渲染；total:null ⇒ 卡片仍在（未知必须可见）', async () => {
    vi.mocked(loadInbox).mockResolvedValue(
      sections(ready('sopBlocked', [], { total: 0, returned: 0 })),
    );
    renderPage();
    // `inbox-page` 是**外层容器**，loading 期就已存在 ⇒ 等它等于没等。
    // 等「全清文案」出现才是真实的终态信号（它只在全 ready 且清零时渲染）。
    await screen.findByText('当前没有待你处理的事项');
    expect(screen.queryByTestId('inbox-section-sopBlocked')).toBeNull();

    cleanup();
    vi.mocked(loadInbox).mockResolvedValue(
      sections(ready('sopBlocked', [], { total: null, degraded: true })),
    );
    renderPage();
    expect(await screen.findByTestId('inbox-section-sopBlocked')).toBeTruthy();
  });

  it('徽标层：0 件时即使其余待办归零也整体隐藏', async () => {
    vi.mocked(loadInboxCounts).mockResolvedValue(counts({ sopBlocked: 0 }));
    render(<MemoryRouter><InboxBadge /></MemoryRouter>);
    // 等最终 DOM 状态（不是「mock 被调用」）：loading 态下徽标照渲染「—」，
    // 同步断言会在 promise 落地与 React 提交之间间歇性红。
    await waitFor(() => expect(screen.queryByTestId('inbox-badge-button')).toBeNull());
  });
});

// ── ③ 行数据：sopName / round / 已阻塞小时 ────────────────────────────────────

describe('R286 ③ 行渲染：SOP 名 + 第 N 轮 + 已阻塞 X 小时', () => {
  it('loadInbox 请求 `hours=24` 一次，形状与契约一致', async () => {
    // 夹具只造一次：`hoursAgo()` 每次调用都会重新取 `Date.now()`，两次生成的
    // 毫秒不同，用 `toBe` 比时间戳会假红。
    const row = lagRow();
    const get = mockBackend({
      lagging: { items: [row], total: 1, returned: 1, truncated: false, degraded: false },
    });

    const result = await loadInbox();

    const call = get.mock.calls.find(([url]) => url === '/sop/assignments/lagging');
    expect(call).toBeTruthy();
    expect((call![1]?.params as Record<string, unknown>).hours).toBe(SOP_BLOCKED_WINDOW_HOURS);
    expect(SOP_BLOCKED_WINDOW_HOURS).toBe(24);
    expect(result.sopBlocked.status).toBe('ready');
    expect(result.sopBlocked.items).toHaveLength(1);
    // 深链只用 SOP 页已真实支持的参数（`?sop=<id>`），不编造 assignment 参数。
    expect(result.sopBlocked.items[0].detailUrl).toBe(`/sops?sop=${SOP_UUID}`);
    // 行的时间 = 进入 blocked 的时刻（不是请求时刻、也不是窗口起点）。
    expect(result.sopBlocked.items[0].waitingSince).toBe(row.blockedSince);
  });

  it('行内渲染「SOP 名」+「第 6 轮」+「已阻塞 30 小时」，深链到 /sops?sop=<id>', async () => {
    vi.mocked(loadInbox).mockResolvedValue(
      sections(ready('sopBlocked', [blockedItem()], { total: 1, returned: 1 })),
    );
    renderPage();

    const row = within(await screen.findByTestId('inbox-row-sopBlocked'));
    expect(row.getByText('R286 阻塞探针 SOP')).toBeTruthy();
    expect(row.getByText('第 6 轮 · 已阻塞 30 小时')).toBeTruthy();
    // 只读小节：只给「查看详情」深链，不给处置按钮（处置在 SOP 页）。
    const link = row.getByRole('link');
    expect(link.getAttribute('href')).toBe(`/sops?sop=${SOP_UUID}`);
    expect(row.queryByRole('button', { name: /批准|拒绝|接管/ })).toBeNull();
  });

  it('`sopName: null` ⇒ 显示「（未命名 SOP）」，**绝不退回 uuid**（端到端：真 loader）', async () => {
    // ⚠️ 这条**必须**从 HTTP 原始响应走一遍。原因是我实测出来的：
    // 若只 mock `loadInbox` 的返回值（下面那条用例），loader 里的
    // `row.sopName ?? row.sopId` 这种「退回 uuid」的改法**根本不会被执行**，
    // 用例照样全绿——即断言存在但不可证伪（空转）。
    // 实测：把 loader 改成 `title: row.sopName ?? row.sopId` ⇒ 本用例红、那条不红。
    mockBackend({
      lagging: {
        items: [lagRow({ sopName: null })],
        total: 1,
        returned: 1,
        truncated: false,
        degraded: false,
      },
    });
    const result = await loadInbox();
    // 契约：`sopName: null` ⇒ loader 的 title 必须是**空串**（交给页面渲染占位），
    // 绝不能是 uuid。这一层先钉住，防止页面层「渲染得对」掩盖 loader 已退回 uuid。
    expect(result.sopBlocked.items[0].title).toBe('');
    expect(result.sopBlocked.items[0].title).not.toContain(SOP_UUID);

    vi.mocked(loadInbox).mockResolvedValue(sections(result.sopBlocked));
    renderPage();
    const row = within(await screen.findByTestId('inbox-row-sopBlocked'));
    expect(row.getByText('（未命名 SOP）')).toBeTruthy();
    // uuid 不是给人看的标题：整行任何位置都不该出现 SOP uuid / assignment uuid。
    const text = screen.getByTestId('inbox-row-sopBlocked').textContent ?? '';
    expect(text).not.toContain(SOP_UUID);
    expect(text).not.toContain(ASSIGN_UUID);
  });

  it('`round: null` ⇒ 「第 — 轮」，保留行、**不编 1**', async () => {
    vi.mocked(loadInbox).mockResolvedValue(
      sections(ready('sopBlocked', [blockedItem({}, { round: null, staleClarificationId: null })], { total: 1, returned: 1 })),
    );
    renderPage();

    const row = within(await screen.findByTestId('inbox-row-sopBlocked'));
    expect(row.getByText(/第 — 轮/)).toBeTruthy();
    // 绝不能把「未知」渲染成「第 1 轮」。
    expect(row.queryByText(/第 1 轮/)).toBeNull();
  });

  it('「已阻塞 X 小时」由 `blockedSince` 现算，**不拿窗口 24 顶上**', async () => {
    // 关键：窗口是 24，但这张单卡了 30 小时 ⇒ 必须显示 30，不是 24。
    // 注入固定 `now`：与机器时钟解耦（同上一条的理由）。
    const t0 = Date.UTC(2026, 10, 20, 12, 0, 0);
    expect(blockedHours(new Date(t0 - 30 * 3_600_000).toISOString(), t0)).toBe(30);
    expect(blockedHours(hoursAgo(30))).toBeGreaterThanOrEqual(29);
    expect(blockedHours(hoursAgo(30))).not.toBe(SOP_BLOCKED_WINDOW_HOURS);

    vi.mocked(loadInbox).mockResolvedValue(
      sections(ready('sopBlocked', [blockedItem({}, { blockedSince: hoursAgo(72) })], { total: 1, returned: 1 })),
    );
    renderPage();
    const row = within(await screen.findByTestId('inbox-row-sopBlocked'));
    expect(row.getByText(/已阻塞 7[12] 小时/)).toBeTruthy();
    expect(row.queryByText(/已阻塞 24 小时/)).toBeNull();
  });

  it('`blockedSince` 不可解析 / 在未来 ⇒ 说「时刻未记录」，不编 0 小时', () => {
    // ⚠️ 全部**注入 `now`**，不靠 `Date.now()` 的双次读数：
    // `blockedHours` 的默认 `now = Date.now()` 是在**调用时**求值的，若测试自己
    // 也用 `Date.now()` 造夹具，两次读数之间有微秒级间隔 ⇒ 恰好跨整小时刻度时
    // `floor()` 会把「0 小时」算成「-1」⇒ 走进未来分支返回 null ⇒ 偶发假红。
    // 概率极低，但属于「测试依赖了不该依赖的外部状态」（与固定 NOW 造假红同类）。
    const now = Date.UTC(2026, 10, 20, 12, 0, 0); // 固定基准，与机器时钟无关
    expect(blockedHours('not-a-date', now)).toBeNull();
    expect(blockedHours(null, now)).toBeNull();
    expect(blockedHours(undefined, now)).toBeNull();
    // 未来时间（时钟漂移）同样算不出：说「已阻塞 -2 小时」是坏文案，说 0 是假事实。
    expect(blockedHours(new Date(now + 7_200_000).toISOString(), now)).toBeNull();
    // 边界：恰好 0 秒的过去 ⇒ 0 小时（这是真事实，不是未知）。
    expect(blockedHours(new Date(now).toISOString(), now)).toBe(0);
    // 边界：59 分 59 秒 ⇒ 仍 0 小时（向下取整）；60 分整 ⇒ 1 小时。
    expect(blockedHours(new Date(now - 3_599_000).toISOString(), now)).toBe(0);
    expect(blockedHours(new Date(now - 3_600_000).toISOString(), now)).toBe(1);
  });
});

// ── ④ truncated ───────────────────────────────────────────────────────────────

describe('R286 ④ truncated:true ⇒ 显示「显示前 N 条（共 M 条）」', () => {
  it('纯函数层：describeSectionCount 走 truncated 形态，M 来自服务端 total', () => {
    const section = ready('sopBlocked', [blockedItem()], { total: 7, returned: 1, truncated: true });
    expect(describeSectionCount(section)).toEqual({ kind: 'truncated', returned: 1, total: 7 });
  });

  it('页面层：`returned=1 / total=7` ⇒ 标题「显示前 1 条（共 7 条）」+ truncated 告警', async () => {
    vi.mocked(loadInbox).mockResolvedValue(
      sections(ready('sopBlocked', [blockedItem()], { total: 7, returned: 1, truncated: true })),
    );
    renderPage();

    const count = await screen.findByTestId('inbox-count-sopBlocked');
    expect(count.textContent).toContain('显示前 1 条（共 7 条）');
    const section = within(screen.getByTestId('inbox-section-sopBlocked'));
    expect(section.getByTestId('inbox-truncated-sopBlocked')).toBeTruthy();
  });

  it('`total:null` 时 truncated 必须为 false，且不渲染「共 M 条」（没有 M）', async () => {
    mockBackend({
      lagging: { items: [lagRow()], total: null, returned: 1, truncated: false, degraded: true },
    });
    const result = await loadInbox();
    expect(result.sopBlocked.truncated).toBe(false);
    expect(result.sopBlocked.degraded).toBe(true);
    expect(describeSectionCount(result.sopBlocked)).toEqual({ kind: 'unknown', degraded: true });

    vi.mocked(loadInbox).mockResolvedValue(sections(result.sopBlocked));
    renderPage();
    const count = await screen.findByTestId('inbox-count-sopBlocked');
    expect(count.textContent).toContain('—');
    expect(count.textContent).not.toMatch(/共\s*\d+\s*条/);
  });
});

// ── ⑤ 不进总结（yesterday 的教训：多一个求和项就是错的总数） ─────────────────

describe('R286 状态透传：`total` 归一化 / `degraded` / `truncated` 的契约', () => {
  // 这一块存在的理由：原来这几条被塞在 `R286 ④ truncated` 的 describe 里，
  // 于是「`degraded` 恒 true」的变异红在**标题写着 truncated 的块**下 —— 报告读起来
  // 像是截断出了问题，实际是降级标记。按「红的那条 `it()` 标题描述的是我要保护的
  // 字段吗」这条判据（第 ⑤a 类：靠副作用保护），分组本身也是归因的一部分。
  it('非有限数 total（NaN / Infinity）⇒ 判读失败：null + degraded，不透出去', async () => {
    // 为什么必须有这条：`metaOf` 里有一段
    //   `typeof rawTotal === 'number' && Number.isFinite(rawTotal) ? rawTotal : null`
    // **只把 `Number.isFinite` 去掉**（让 NaN/Infinity 透出去）时，本文件原本
    // **128 例全绿** —— 即那个防御分支从未被喂过非法输入（与 A 那边
    // 「非有限数 ⇒ 判读失败」守卫是同一类空转，实测双方各一处）。
    //
    // 它为什么该覆盖：`getCount()` 正常不回 NaN，但驱动/聚合/自定义 select 都可能
    // 回 `NaN`/`Infinity`；而 `NaN` 进 JSON 会被序列化成 `null`，前端再判一次就失效。
    // 契约是「读不到 ⇒ null + degraded」，不是「把不确定的数字透给 UI 显示」。
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      mockBackend({
        lagging: { items: [lagRow()], total: bad, returned: 1, truncated: false, degraded: true },
      });
      const result = await loadInbox();
      expect(result.sopBlocked.total).toBeNull();
      expect(result.sopBlocked.degraded).toBe(true);
      expect(result.sopBlocked.items).toHaveLength(1);
      expect(describeSectionCount(result.sopBlocked)).toEqual({ kind: 'unknown', degraded: true });
    }
  });

  it('`degraded` 必须**原样透传**服务端值：false 不许被抬成 true', async () => {
    // 实测：把 `degraded: !!res?.degraded` 改成 `degraded: true`（恒降级）⇒ 原 33 例全绿。
    // `degraded` 是唯一区分「数字是事实」与「数字是下界」的标记：恒 true ⇒ 每页挂
    // 「计数可能不准」⇒ 告警疲劳；恒 false ⇒ 下界冒充事实。两侧都要钉。
    mockBackend({
      lagging: { items: [lagRow()], total: 1, returned: 1, truncated: false, degraded: false },
    });
    const healthy = await loadInbox();
    expect(healthy.sopBlocked.degraded).toBe(false);
    expect(describeSectionCount(healthy.sopBlocked)).toEqual({ kind: 'total', n: 1, source: 'server' });

    mockBackend({
      lagging: { items: [lagRow()], total: 7, returned: 1, truncated: true, degraded: true },
    });
    expect((await loadInbox()).sopBlocked.degraded).toBe(true);
  });

  it('`truncated` 的服务端权威：本地与服务端结论相反时，信服务端', async () => {
    // 第一版这条用例用的是 `returned=1 / total=7` ⇒ **无区分力**：
    // 本地 `metaOf` 也算出 true，删掉服务端值照样绿。
    // 必须构造两实现结论相反的输入：`total:null`（本地必 false）+ 服务端 true。
    mockBackend({
      lagging: { items: [lagRow()], total: null, returned: 1, truncated: true, degraded: true },
    });
    const authority = await loadInbox();
    expect(authority.sopBlocked.truncated).toBe(true);
    expect(authority.sopBlocked.total).toBeNull();
  });

  it('`truncated` 的两侧都有专门断言：true 与 false 各自被独立的输入钉住', async () => {
    // 实测：`truncated` 恒 `false` 这个变异曾**只被 `degraded` 用例顺带挡住**（1 红），
    // 而那条不是为 `truncated` 写的 ⇒ 靠副作用保护（第 ⑤a 类）。
    mockBackend({
      lagging: { items: [lagRow()], total: 1, returned: 1, truncated: false, degraded: false },
    });
    expect((await loadInbox()).sopBlocked.truncated).toBe(false);

    mockBackend({
      lagging: { items: [lagRow()], total: 9, returned: 1, truncated: true, degraded: false },
    });
    const cut = await loadInbox();
    expect(cut.sopBlocked.truncated).toBe(true);
    expect(cut.sopBlocked.total).toBe(9);
    expect(cut.sopBlocked.returned).toBe(1);
    expect(describeSectionCount(cut.sopBlocked)).toEqual({ kind: 'truncated', returned: 1, total: 9 });
  });

  it('`metaOf`（共享函数，7 个入口的共同根）：非有限数一律判读失败', () => {
    // `metaOf` 在 `api/inbox.ts` 有 7 个调用点；入口级用例只覆盖其中 1 个
    // （实测：去掉 `Number.isFinite` 只红 2 条且同源）。共享函数的契约钉在函数级。
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(metaOf(1, bad)).toEqual({ total: null, returned: 1, truncated: false });
    }
    expect(metaOf(1, 7)).toEqual({ total: 7, returned: 1, truncated: true });
    expect(metaOf(0, 0)).toEqual({ total: 0, returned: 0, truncated: false });
    expect(metaOf(1, null)).toEqual({ total: null, returned: 1, truncated: false });
    expect(metaOf(1, undefined)).toEqual({ total: null, returned: 1, truncated: false });
    expect(metaOf(1, '7' as unknown as number)).toEqual({ total: null, returned: 1, truncated: false });
  });
});

describe('R286 ⑤ 阻塞工单**不**进入会话求和，但独立可显示', () => {
  it('summarizeInboxCounts 不含 sopBlocked：去重单位是「一张指派单」', () => {
    const c = counts({ deployments: 1, agentWaiting: 2, sopBlocked: 7 });
    expect(summarizeInboxCounts(c)).toBe(3); // 1 + 2，阻塞 7 不进求和
    expect(splitInboxCounts(c).sopBlocked).toBe(7); // 但单独可显示
  });

  it('读不到也不影响总数（它是独立项，不是求和项）', () => {
    const c = counts({ deployments: 1, agentWaiting: 2, sopBlocked: null });
    expect(summarizeInboxCounts(c)).toBe(3);
    expect(splitInboxCounts(c).sopBlocked).toBeNull();
  });

  it('端到端：`total:5` 时徽标总数仍是会话去重和，阻塞工单另开一句', async () => {
    mockBackend({
      lagging: { items: [lagRow()], total: 5, returned: 1, truncated: true, degraded: false },
    });
    const result = await loadInbox();
    expect(result.sopBlocked.total).toBe(5);

    vi.mocked(loadInboxCounts).mockResolvedValue(
      counts({ deployments: 1, agentApprovals: 1, agentWaiting: 2, sopBlocked: 5 }),
    );
    render(<MemoryRouter><InboxBadge /></MemoryRouter>);
    await screen.findByTestId('inbox-badge-button');
    await waitFor(() =>
      expect(screen.getByTestId('inbox-badge-sop-blocked').textContent).toBe('阻塞工单 5 条'),
    );
    // 徽标数字仍是会话去重和（1 + 2 = 3），阻塞 5 不在里面（3 + 5 = 8 不许出现）。
    expect(screen.getByTestId('inbox-badge').textContent).toContain('3');
    expect(screen.getByTestId('inbox-badge').textContent).not.toContain('8');
  });
});

// ── ⑥ 全清态 ──────────────────────────────────────────────────────────────────

describe('R286 ⑥ 阻塞工单 > 0 ⇒ 不算全清（数字对、结论错是最坏的一类）', () => {
  it('纯函数层：有行 ⇒ 不算全清；行为空但 total>0 ⇒ 仍不算全清', () => {
    expect(isInboxAllClear(sections(ready('sopBlocked', [], { total: 0 })))).toBe(true);
    expect(isInboxAllClear(sections(ready('sopBlocked', [blockedItem()], { total: 1 })))).toBe(false);
    // 行集合为空但独立计数 > 0（子查询降级导致行装配不出来）：只看 items.length 会漏。
    expect(isInboxAllClear(sections(ready('sopBlocked', [], { total: 5 })))).toBe(false);
    // 读不到 ⇒ 由 hasUncertainCounts 判（未知 ≠ 有，也 ≠ 没有）。
    expect(isInboxAllClear(sections(ready('sopBlocked', [], { total: null, degraded: true })))).toBe(false);
    expect(hasBlockedAssignments(sections(ready('sopBlocked', [], { total: 0 })))).toBe(false);
    expect(hasBlockedAssignments(sections(ready('sopBlocked', [], { total: 3 })))).toBe(true);
    expect(hasBlockedAssignments(sections(ready('sopBlocked', [blockedItem()], { total: 1 })))).toBe(true);
    // error 态不算「有」（未知由 hasUncertainCounts 负责，两件事不互相顶替）。
    expect(hasBlockedAssignments(sections({ key: 'sopBlocked', status: 'error', items: [], error: 503 }))).toBe(false);
  });

  it('页面层：有阻塞工单 ⇒ **不**渲染全空态，且卡片可见', async () => {
    vi.mocked(loadInbox).mockResolvedValue(
      sections(ready('sopBlocked', [blockedItem()], { total: 1, returned: 1 })),
    );
    renderPage();
    await screen.findByTestId('inbox-section-sopBlocked');
    expect(screen.queryByText('当前没有待你处理的事项')).toBeNull();
  });

  it('页面层：行 0 但 total 5（行未能装配）⇒ 不渲染全空态，并说清「5 条不在下方」', async () => {
    vi.mocked(loadInbox).mockResolvedValue(
      sections(ready('sopBlocked', [], { total: 5, returned: 0, degraded: true })),
    );
    renderPage();
    const section = within(await screen.findByTestId('inbox-section-sopBlocked'));
    expect(screen.queryByText('当前没有待你处理的事项')).toBeNull();
    expect(section.queryByText('本类暂无待办')).toBeNull();
  });
});

// ── 小节隔离与位置 ────────────────────────────────────────────────────────────

describe('R286 小节隔离：lagging 端点挂掉只让它自己是 error 态', () => {
  it('503 ⇒ error（带重试），其余小节照常 ready；error 态不带计数（绝不 0）', async () => {
    mockBackend({ lagging: 'unavailable' });

    const result = await loadInbox();
    expect(result.sopBlocked.status).toBe('error');
    expect(result.sopBlocked.items).toEqual([]);
    expect(result.deployments.status).toBe('ready');
    expect(result.sopClarifications.status).toBe('ready');
    expect(result.recentFailures.status).toBe('ready');
    expect(result.sopBlocked.total).not.toBe(0);
    expect(describeSectionCount(result.sopBlocked)).toEqual({ kind: 'none' });
  });

  it('页面层：error ⇒ 呈现重试按钮，而不是「本类暂无待办」', async () => {
    vi.mocked(loadInbox).mockResolvedValue(
      sections({ key: 'sopBlocked', status: 'error', items: [], error: new Error('503') }),
    );
    renderPage();
    const section = within(await screen.findByTestId('inbox-section-sopBlocked'));
    expect(section.getByRole('button', { name: /重\s*试/ })).toBeTruthy();
    expect(section.queryByText('本类暂无待办')).toBeNull();
  });

  it('`sopBlocked` 是第十个小节（`sopClarifications` 之后、`stalled` 之前）', () => {
    expect(INBOX_SECTIONS.indexOf('sopBlocked')).toBe(INBOX_SECTIONS.indexOf('sopClarifications') + 1);
    expect(INBOX_SECTIONS.indexOf('sopBlocked')).toBe(INBOX_SECTIONS.indexOf('stalled') - 1);
    expect(INBOX_SECTIONS).toHaveLength(10);
  });

  it('深链只用 SopsPage 真实支持的 `?sop=`（不编造 assignment 参数）', () => {
    expect(sopAssignmentUrl(SOP_UUID)).toBe(`/sops?sop=${SOP_UUID}`);
    const url = new URL(sopAssignmentUrl(SOP_UUID), 'http://x');
    expect([...url.searchParams.keys()]).toEqual(['sop']);
  });

  it('调用的是既有的 `laggingAssignments`（不另开端点、不改 URL）', async () => {
    mockBackend();
    const spy = vi.spyOn(sopsApi, 'laggingAssignments');
    await loadInbox();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe(SOP_BLOCKED_WINDOW_HOURS);
  });

  it('窗口只有一个事实源：方法内不藏第二个 24，调用点显式给常量', async () => {
    // 为什么钉这条：旧写法 `hours ?? 24` 让「24」在仓库里出现两处
    // （`SOP_BLOCKED_WINDOW_HOURS` + 方法内字面量）。常量一改，方法就静默用旧窗口，
    // 而窗口是**筛选条件**——它会改变「哪些工单出现在本节」，不会报错。
    const get = mockBackend();
    // 传 48 ⇒ 请求里就是 48：证明参数被原样透传、没被内部默认值吃掉。
    await sopsApi.laggingAssignments(48);
    const first = get.mock.calls.find(([url]) => url === '/sop/assignments/lagging');
    expect((first![1]?.params as Record<string, unknown>).hours).toBe(48);

    // 不传 ⇒ **不发明一个默认值**：不带 `hours` 参数（由 service 决定默认），
    // 而不是假装传了 24。这样服务端默认值将来漂移，本前端也不会静默跟随。
    await sopsApi.laggingAssignments();
    const calls = get.mock.calls.filter(([url]) => url === '/sop/assignments/lagging');
    const omitted = calls[calls.length - 1];
    expect((omitted[1]?.params as Record<string, unknown>).hours).toBeUndefined();
    expect(omitted[1]?.params).not.toHaveProperty('hours');

    // 仓库里的调用点必须全部传常量（不是字面量、不是省略）。
    const inbox = await loadInbox();
    expect(inbox.sopBlocked.status).toBe('ready');
    // 用下标而不是 `Array.prototype.at`：tsconfig 的 lib 未到 es2022，
    // vitest 能跑而 tsc 会红（假绿陷阱）。
    const laters = get.mock.calls.filter(([url]) => url === '/sop/assignments/lagging');
    const last = laters[laters.length - 1];
    expect((last[1]?.params as Record<string, unknown>).hours).toBe(SOP_BLOCKED_WINDOW_HOURS);
  });
});
