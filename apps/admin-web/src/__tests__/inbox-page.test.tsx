/**
 * P1-4 待办收件箱页面回归：
 * - 部署待办行渲染批准/拒绝；批准走二次确认 → 调 approve，成功后重新装载（计数刷新）；
 * - 全空态呈现「当前没有待你处理的事项」；
 * - 小节读失败保留错误态 + 重试，重试后重新装载；
 * - 非 ADMIN 用户写按钮禁用（RBAC 前端门控，后端同口径兜底）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Modal } from 'antd';
import '../i18n';
import InboxPage from '../pages/InboxPage';
import { loadInbox, deploymentsApi, agentApi } from '../api/inbox';
import { useAuthStore } from '../store/auth';
import type { InboxSections, InboxItem } from '../api/inbox';

vi.mock('../api/inbox', () => ({
  INBOX_REFRESH_EVENT: 'autoflow:inbox-refresh',
  loadInbox: vi.fn(),
  deploymentsApi: { approve: vi.fn(), reject: vi.fn() },
  agentApi: { grantApproval: vi.fn(), denyApproval: vi.fn(), resume: vi.fn() },
  isSelfDeployment: vi.fn((d: { approvalMeta?: { requestedBy?: number } }, uid: number | null) =>
    d?.approvalMeta?.requestedBy === uid,
  ),
  sortInboxItemsByWaitingSince: (items: InboxItem[]) => [...items],
}));

// jsdom 缺失 antd 依赖的浏览器 API（既有页面测试先例）
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

const depItem = (overrides: Partial<InboxItem> = {}): InboxItem => ({
  id: 'dep-1',
  section: 'deployments',
  title: 'App A',
  subtitle: '提交者：alice',
  waitingSince: '2026-01-01T00:00:00Z',
  detailUrl: '/applications/app-1',
  deployment: { id: 'dep-1', applicationId: 'app-1', approvalMeta: { requestedBy: 7, requestedByName: 'alice' } } as never,
  ...overrides,
});

const readySections = (items: Partial<Record<keyof InboxSections, InboxItem[]>>): InboxSections => ({
  deployments: { key: 'deployments', status: 'ready', items: items.deployments ?? [], error: null },
  agentApprovals: { key: 'agentApprovals', status: 'ready', items: items.agentApprovals ?? [], error: null },
  agentWaiting: { key: 'agentWaiting', status: 'ready', items: items.agentWaiting ?? [], error: null },
  stalled: { key: 'stalled', status: 'ready', items: items.stalled ?? [], error: null },
  backlogged: { key: 'backlogged', status: 'ready', items: items.backlogged ?? [], error: null },
  queueStall: {
    key: 'queueStall',
    status: 'ready',
    items: [],
    error: null,
    snapshot: {
      stalled: false,
      reason: null,
      pendingJobs: 0,
      degraded: false,
      // R232：R211 给 QueueStallSnapshot 加了两个字段（「可能误报」/「workers 是否已知」），
      // 本夹具此前没跟上 ⇒ `typecheck:web`（tsc -b）在**本机从未完整跑过**所以一直没暴露
      // （它需要 packages/* 的 node_modules，R231 才装齐）。
      degradedCounts: false,
      workersKnown: true,
    },
  },
  recentFailures: { key: 'recentFailures', status: 'ready', items: items.recentFailures ?? [], error: null },
});

function renderPage() {
  return render(
    <MemoryRouter>
      <InboxPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useAuthStore.setState({ user: { id: 1, username: 'admin', role: 'admin' } });
  vi.mocked(deploymentsApi.approve).mockReset().mockResolvedValue({} as never);
  vi.mocked(deploymentsApi.reject).mockReset().mockResolvedValue({} as never);
  vi.mocked(agentApi.resume).mockReset().mockResolvedValue({} as never);
});

afterEach(() => {
  cleanup();
  Modal.destroyAll();
  document.querySelectorAll('.ant-modal-wrap, .ant-modal-root').forEach((n) => n.remove());
  vi.restoreAllMocks();
});

describe('InboxPage 待办收件箱', () => {
  it('渲染部署待办行，批准走二次确认后调 approve 并重新装载', async () => {
    vi.mocked(loadInbox).mockResolvedValue(readySections({ deployments: [depItem()] }));
    renderPage();

    expect(await screen.findByText('App A')).toBeTruthy();
    const approveBtn = await screen.findByRole('button', { name: /批\s*准/ });
    expect((approveBtn as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(approveBtn);
    // 命令式确认框挂 body 级 holder
    const okBtn = await screen.findByRole('button', { name: /确\s*认/ });
    fireEvent.click(okBtn);

    await waitFor(() => expect(vi.mocked(deploymentsApi.approve)).toHaveBeenCalledWith('dep-1'));
    // 成功后重新装载收件箱（顶栏计数经刷新事件同步）
    await waitFor(() => expect(vi.mocked(loadInbox)).toHaveBeenCalledTimes(2));
  });

  it('全空态：所有小节 ready 且无待办 ⇒ 呈现空态说明', async () => {
    vi.mocked(loadInbox).mockResolvedValue(readySections({}));
    renderPage();

    expect(await screen.findByText('当前没有待你处理的事项')).toBeTruthy();
  });

  it('小节读失败：保留错误态与重试按钮，重试后重新装载', async () => {
    const failed: InboxSections = {
      ...readySections({}),
      deployments: { key: 'deployments', status: 'error', items: [], error: new Error('boom') },
    };
    vi.mocked(loadInbox).mockResolvedValueOnce(failed).mockResolvedValue(readySections({}));
    renderPage();

    const retry = await screen.findByRole('button', { name: /重 试|重试/ });
    fireEvent.click(retry);
    await waitFor(() => expect(vi.mocked(loadInbox)).toHaveBeenCalledTimes(2));
  });

  it('非 ADMIN 用户：写动作按钮禁用（RBAC 前端门控）', async () => {
    useAuthStore.setState({ user: { id: 3, username: 'dev', role: 'user' } });
    vi.mocked(loadInbox).mockResolvedValue(readySections({ deployments: [depItem()] }));
    renderPage();

    const approveBtn = await screen.findByRole('button', { name: /批\s*准/ });
    const rejectBtn = screen.getByRole('button', { name: /拒\s*绝/ });
    expect((approveBtn as HTMLButtonElement).disabled).toBe(true);
    expect((rejectBtn as HTMLButtonElement).disabled).toBe(true);
  });
});
