/**
 * ADR-045 · 收件箱发布审批卡（`pages/inbox/PublishApprovalCard.tsx`）。
 *
 * 判据不是「代码里写了 if」，而是渲染出来的**四个 testid 契约**与两条红线：
 *   · 有 `preview` ⇒ 被批对象摘要可见（sopId / 版本档位 / 方案卡锚点）；
 *   · `preview` 为 null / 空 / 不可解析 ⇒ 降级文案，**不臆造**任何 id；
 *   · 非 `sop_publish` 的审批行版式与文案**逐字不变**（回归面）；
 *   · 卡内**没有**任何直接发布入口（批准 / 发布 / 执行），业务人员连「拒绝」都看不到。
 *
 * 验收级别：单测 / 内存替身（`loadInbox` 被 spy，HTTP 边界不触网）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup, within, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Modal } from 'antd';
import '../i18n';
import InboxPage from '../pages/InboxPage';
import { loadInbox, agentApi } from '../api/inbox';
import { useAuthStore } from '../store/auth';
import type { InboxItem, InboxSectionState, InboxSections } from '../api/inbox';

vi.mock('../api/inbox', { spy: true });
vi.mock('../utils/toast', () => ({ message: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

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

const DIGEST = 'a'.repeat(64);

/** 审批单自带的 preview 信封（后端已脱敏 + 截断；args 是 JSON 文本）。 */
const envelope = (args: Record<string, unknown>, truncated = false): string =>
  JSON.stringify({ truncated, args: JSON.stringify(args) });

const publishItem = (overrides: Partial<InboxItem> = {}): InboxItem => ({
  id: 'apr-pub-1',
  section: 'agentApprovals',
  title: '方案卡发布',
  subtitle: 'sop_publish',
  waitingSince: '2026-01-01T00:00:00Z',
  detailUrl: '/agent-sessions?session=s1&tab=approvals&approvalKey=apr-pub-1',
  session: { id: 's1', title: '方案卡发布' } as never,
  approval: {
    id: 'apr-pub-1',
    approvalKey: 'apr-pub-1',
    sessionId: 's1',
    toolName: 'sop_publish',
    reason: '发布方案卡需要主管四眼批准',
    status: 'pending',
    decidedBy: null,
    decidedAt: null,
    consumedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    preview: envelope({ sopId: 'sop-1', bump: 'minor', cardHash: 'card-abcdef12' }),
    argsDigest: DIGEST,
  },
  ...overrides,
});

const shellItem = (): InboxItem => ({
  id: 'apr-shell-1',
  section: 'agentApprovals',
  title: '构建发布',
  subtitle: 'shell',
  waitingSince: '2026-01-01T00:00:00Z',
  detailUrl: '/agent-sessions?session=s2&tab=approvals&approvalKey=apr-shell-1',
  session: { id: 's2', title: '构建发布' } as never,
  approval: {
    id: 'apr-shell-1',
    approvalKey: 'apr-shell-1',
    sessionId: 's2',
    toolName: 'shell',
    reason: '写操作需要人工点头',
    status: 'pending',
    decidedBy: null,
    decidedAt: null,
    consumedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    preview: null,
    argsDigest: null,
  },
});

const ready = (
  key: InboxSectionState['key'],
  items: InboxItem[],
  extra: Partial<InboxSectionState> = {},
): InboxSectionState => ({ key, status: 'ready', items, error: null, ...extra });

const sections = (items: InboxItem[]): InboxSections => ({
  deployments: ready('deployments', []),
  agentApprovals: ready('agentApprovals', items, { total: items.length, returned: items.length }),
  agentWaiting: ready('agentWaiting', []),
  agentFailures: ready('agentFailures', [], { total: 0 }),
  sopClarifications: ready('sopClarifications', [], { total: 0 }),
  sopBlocked: ready('sopBlocked', [], { total: 0 }),
  stalled: ready('stalled', []),
  backlogged: ready('backlogged', []),
  queueStall: ready('queueStall', []),
  recentFailures: ready('recentFailures', []),
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/inbox']}>
      <Routes>
        <Route path="/inbox" element={<InboxPage />} />
        <Route path="/agent-sessions" element={<div />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(loadInbox).mockReset();
  vi.mocked(agentApi.grantApproval).mockReset().mockResolvedValue({
    ok: true,
    resumed: true,
    approval: { approvalKey: 'apr-pub-1', status: 'granted', decidedBy: 'boss', decidedAt: null, consumedAt: null },
  });
  useAuthStore.setState({ user: { id: 1, username: 'boss', role: 'admin' } });
});

afterEach(async () => {
  cleanup();
  await act(async () => { Modal.destroyAll(); });
  // jsdom 不触发 CSS 离场过渡结束，静态对话框 portal 不会自行卸载。
  document.querySelectorAll('.ant-modal-wrap, .ant-modal-root').forEach((n) => n.remove());
  vi.restoreAllMocks();
});

describe('ADR-045 收件箱发布审批卡', () => {
  it('有 preview：被批对象摘要 + 四眼红线 + 参数摘要前 16 位 + 核对入口', async () => {
    vi.mocked(loadInbox).mockResolvedValue(sections([publishItem()]));
    renderPage();

    const card = await screen.findByTestId('inbox-publish-card');
    // ① 被批对象：sopId / 版本档位 / 方案卡锚点都来自 preview 信封
    const preview = within(card).getByTestId('inbox-publish-preview');
    expect(preview.textContent).toContain('sop-1');
    expect(preview.textContent).toContain('小版本');
    expect(preview.textContent).toContain('card-abcdef12');
    // ② 四眼红线：批准 = 同意发布、执行者是系统代理、不得自批
    const fourEyes = within(card).getByTestId('inbox-publish-four-eyes').textContent ?? '';
    expect(fourEyes).toContain('同意发布');
    expect(fourEyes).toContain('系统代理');
    expect(fourEyes).toContain('不得批准自己提交');
    // ③ 摘要只露前 16 位 + 省略号，全文留在 title 供机器对账
    const digest = within(card).getByTestId('inbox-publish-digest');
    expect(digest.textContent).toContain(`${'a'.repeat(16)}…`);
    expect(digest.textContent).not.toContain(DIGEST);
    expect(digest.getAttribute('title')).toBe(DIGEST);
    // ④ 核对入口深链回该会话的审批单页签
    expect(within(card).getByTestId('inbox-publish-review').getAttribute('href')).toBe(
      '/agent-sessions?session=s1&tab=approvals&approvalKey=apr-pub-1',
    );
  });

  it('无 preview（null）⇒ 降级文案，不臆造任何被批对象', async () => {
    const item = publishItem();
    item.approval = { ...item.approval!, preview: null, argsDigest: null };
    vi.mocked(loadInbox).mockResolvedValue(sections([item]));
    renderPage();

    const card = await screen.findByTestId('inbox-publish-card');
    expect(within(card).getByTestId('inbox-publish-preview').textContent).toContain('摘要不可用');
    expect(within(card).getByTestId('inbox-publish-preview').textContent).not.toContain('sop-1');
    // 没有摘要 ⇒ 不渲染摘要元素（而不是渲染一个空壳）
    expect(within(card).queryByTestId('inbox-publish-digest')).toBeNull();
    // 四眼提示与核对入口与摘要无关，照常在场
    expect(within(card).getByTestId('inbox-publish-four-eyes')).toBeTruthy();
    expect(within(card).getByTestId('inbox-publish-review')).toBeTruthy();
  });

  it('preview 不可解析 / 空串 ⇒ 同一降级出口，不显示半截 JSON', async () => {
    for (const preview of ['', 'not-json', JSON.stringify({ truncated: false, args: '{"sopId":' })]) {
      const item = publishItem();
      item.approval = { ...item.approval!, preview, argsDigest: null };
      vi.mocked(loadInbox).mockResolvedValue(sections([item]));
      const view = renderPage();
      const card = await screen.findByTestId('inbox-publish-card');
      const text = within(card).getByTestId('inbox-publish-preview').textContent ?? '';
      expect(text).toContain('摘要不可用');
      expect(text).not.toContain('sopId');
      cleanup();
      view.unmount();
    }
  });

  it('扁平 preview（参数直接铺在顶层，无信封）⇒ 同样抽得出被批对象，哈希原样展示', async () => {
    const item = publishItem();
    item.approval = {
      ...item.approval!,
      preview: JSON.stringify({ sopId: 'sop-e2e-0072', cardHash: 'a1b2c3d4e5f60718', summary: '发布方案卡' }),
      argsDigest: null,
    };
    vi.mocked(loadInbox).mockResolvedValue(sections([item]));
    renderPage();

    const card = await screen.findByTestId('inbox-publish-card');
    const preview = within(card).getByTestId('inbox-publish-preview').textContent ?? '';
    expect(preview).toContain('sop-e2e-0072');
    // 哈希不截断：主管要能与方案卡上的值逐字对上
    expect(preview).toContain('a1b2c3d4e5f60718');
  });

  it('发布行仍带通用行容器 testid（与 update_task 行各占一行，只有一行是发布卡）', async () => {
    vi.mocked(loadInbox).mockResolvedValue(sections([publishItem(), shellItem()]));
    renderPage();

    await screen.findByTestId('inbox-publish-card');
    const rows = screen.getAllByTestId('inbox-row-agentApprovals');
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => within(r).queryByTestId('inbox-publish-card'))).toHaveLength(1);
    const generic = rows.find((r) => (r.textContent ?? '').includes('shell'));
    expect(generic).toBeTruthy();
    expect(within(generic!).queryByTestId('inbox-publish-card')).toBeNull();
    expect(within(generic!).queryByTestId('inbox-publish-preview')).toBeNull();
  });

  it('非发布行（toolName=shell）版式与文案逐字不变，且不出现发布卡', async () => {
    vi.mocked(loadInbox).mockResolvedValue(sections([shellItem()]));
    renderPage();

    const row = await screen.findByTestId('inbox-row-agentApprovals');
    expect(screen.queryByTestId('inbox-publish-card')).toBeNull();
    expect(row.textContent).toContain('构建发布');
    expect(row.textContent).toContain('shell');
    expect(row.textContent).toContain('写操作需要人工点头');
    // 通用行的两个动作仍在（查看审批 + 拒绝）
    expect(within(row).getByRole('link', { name: '查看审批' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: /拒\s*绝/ })).toBeTruthy();
  });

  it('发布卡不出现任何「直接发布」入口；主管只有「批准 / 拒绝」两个审批动作', async () => {
    vi.mocked(loadInbox).mockResolvedValue(sections([publishItem()]));
    renderPage();

    const card = await screen.findByTestId('inbox-publish-card');
    // 「批准」是审批动作，不是发布动作：卡内不得出现任何直接发布/执行入口
    expect(within(card).queryByRole('button', { name: /直接发布|立即发布|发布并执行|执\s*行/ })).toBeNull();
    expect(within(card).queryByText(/直接发布|立即发布/)).toBeNull();
    const labels = within(card).getAllByRole('button').map((b) => b.textContent ?? '');
    expect(labels).toHaveLength(2);
    // 可读名逐字是「批准 / 拒绝」（antd 两字间隔已关）——按名字找按钮的调用不会退化
    expect(labels[0]).toBe('批准');
    expect(labels[1]).toBe('拒绝');
    expect(within(card).getByRole('button', { name: '批准' })).toBeTruthy();
  });

  it('主管点「批准」走二次确认 → grant 打到该审批单，成功后刷新收件箱', async () => {
    vi.mocked(loadInbox).mockResolvedValue(sections([publishItem()]));
    renderPage();

    const card = await screen.findByTestId('inbox-publish-card');
    fireEvent.click(within(card).getByRole('button', { name: /批\s*准/ }));
    // 二次确认：未确认前不发 grant
    expect(vi.mocked(agentApi.grantApproval)).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: /确\s*认/ }));
    await waitFor(() =>
      expect(vi.mocked(agentApi.grantApproval)).toHaveBeenCalledWith('s1', 'apr-pub-1'),
    );
    await waitFor(() => expect(vi.mocked(loadInbox).mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('业务人员（非 ADMIN）只读：无按钮，且不渲染指向 ADMIN-only 会话页的核对链接', async () => {
    useAuthStore.setState({ user: { id: 3, username: 'dev', role: 'user' } });
    vi.mocked(loadInbox).mockResolvedValue(sections([publishItem()]));
    renderPage();

    const card = await screen.findByTestId('inbox-publish-card');
    expect(within(card).queryByRole('button')).toBeNull();
    // UX-AUDIT：核对深链指向 /agent-sessions（RequireAdmin）——业务用户点了只会撞 403，
    // 原测试钉住的是这个死链 bug；现在按角色隐藏，四眼红线说明仍可见。
    expect(within(card).queryByTestId('inbox-publish-review')).toBeNull();
    expect(within(card).getByTestId('inbox-publish-four-eyes')).toBeTruthy();
  });

  it('发布行不重复输出通用副标题（工具名 · 理由由卡内摘要承担）', async () => {
    vi.mocked(loadInbox).mockResolvedValue(sections([publishItem()]));
    renderPage();

    const card = await screen.findByTestId('inbox-publish-card');
    // 通用行的副标题形态是「sop_publish · 理由」；卡内只出现一次工具名（标签外无重复）
    expect(card.textContent?.match(/sop_publish/g) ?? []).toHaveLength(0);
    expect(card.textContent).toContain('发布审批');
  });
});