/**
 * P1-4 待办收件箱页面回归：
 * - 部署待办行渲染批准/拒绝；批准走二次确认 → 调 approve，成功后重新装载（计数刷新）；
 * - 全空态呈现「当前没有待你处理的事项」；
 * - 小节读失败保留错误态 + 重试，重试后重新装载；
 * - 非 ADMIN 用户写按钮禁用（RBAC 前端门控，后端同口径兜底）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Modal } from 'antd';
import '../i18n';
import InboxPage from '../pages/InboxPage';
import { loadInbox, deploymentsApi, agentApi, INBOX_REFRESH_EVENT } from '../api/inbox';
import { client } from '../api/client';
import { message } from '../utils/toast';
import { useAuthStore } from '../store/auth';
import type { InboxSections, InboxItem } from '../api/inbox';

// spy 保留真实聚合与第二人规则；纯页面测试可单独覆盖 loadInbox。
vi.mock('../api/inbox', { spy: true });
vi.mock('../utils/toast', () => ({ message: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

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
  agentFailures: { key: 'agentFailures', status: 'ready', items: items.agentFailures ?? [], error: null, total: 0 },
  sopClarifications: { key: 'sopClarifications', status: 'ready', items: items.sopClarifications ?? [], error: null, total: 0 },
  // R286：第十个小节，本文件不是它的被测对象 ⇒ 恒为「确认清零」（0 ⇒ 隐藏）。
  sopBlocked: { key: 'sopBlocked', status: 'ready', items: items.sopBlocked ?? [], error: null, total: 0 },
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

function SessionDestination() {
  const location = useLocation();
  const navigate = useNavigate();
  return <><output>{location.search}</output><button onClick={() => navigate(-1)}>返回收件箱</button></>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/inbox']}>
      <Routes>
        <Route path="/inbox" element={<InboxPage />} />
        <Route path="/agent-sessions" element={<SessionDestination />} />
      </Routes>
    </MemoryRouter>,
  );
}

const firstKey = 'approval:first+item';
const secondKey = 'approval:second&item';
const session = (id: string, status: string) => ({ id, status, title: id });

// 在 HTTP 读边界提供数据：真实 loadInbox、链接构造、排序和路由导航都照常运行。
//
// R278/U1：审批单不再走「逐会话 GET /agent/sessions/:id/approvals」的 N+1，
// 而是**一次** `GET /agent/approvals/pending`。故此处按新契约注入：
// - `needs-review` 一个会话两张待批单（第一条 / 第二条）；
// - `unknown` 换成「审批单读不到」的降级形态（degraded + total:null），
//   保留原用例「读取失败不隐藏已知审批、也不假报空态」的判据面；
// - `approvalReadFails` 参数保留（签名不动），返回 true 时整体报错（等价旧语义）。
function mockAgentInbox(opts: { allFail?: boolean | (() => boolean); unreadable?: (id: string) => boolean } = {}) {
  // `allFail` 允许传函数：测试里「先失败、重试后成功」需要**每次请求时**重新求值。
  const allFailNow = (): boolean => (typeof opts.allFail === 'function' ? opts.allFail() : opts.allFail ?? false);
  const unreadable = opts.unreadable ?? (() => false);
  return vi.spyOn(client, 'get').mockImplementation(async (url, config) => {
    if (url === '/app-deployments/approvals/pending') return { data: [], total: 0 };
    if (url === '/metrics/failures') return [];
    if (url === '/agent/sessions/backlogged') return { sessionIds: ['queued', 'id-only'], probed: 2, truncated: false };
    if (url === '/agent/sessions/queue-stall') return { stalled: true, pendingJobs: 2 };
    if (url === '/agent/sessions') {
      const params = config?.params as { stalled?: number; status?: string } | undefined;
      const items = params?.stalled ? [session('running', 'running')]
        : params?.status === 'pending' ? [session('queued', 'pending')]
        : ['ready', 'needs-review', 'unknown'].map((id) => session(id, 'waiting_input'));
      return { items, total: items.length };
    }
    if (url === '/agent/approvals/pending') {
      // 全库都读不到 ⇒ 小节走 error（与原「审批单全部读取失败」等价）。
      if (allFailNow()) throw new Error('Approval read failed');
      const rows = [
        { approvalKey: firstKey, sessionId: 'needs-review', sessionTitle: 'needs-review', toolName: 'firstTool', reason: null, createdAt: '2026-01-01T00:00:00Z', preview: null, argsDigest: null },
        { approvalKey: secondKey, sessionId: 'needs-review', sessionTitle: 'needs-review', toolName: 'secondTool', reason: null, createdAt: '2026-01-01T00:00:01Z', preview: null, argsDigest: null },
      ];
      // 部分读不到 ⇒ 已知行照常透出，但 total 未知 + degraded（绝不报 0）。
      const degraded = ['ready', 'needs-review', 'unknown'].some(unreadable);
      return {
        items: rows,
        total: degraded ? null : rows.length,
        sessionTotal: degraded ? null : 1,
        returned: rows.length,
        truncated: false,
        degraded,
      };
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

function rowWith(section: keyof InboxSections, text: string) {
  const rows = screen.getAllByTestId(`inbox-row-${section}`);
  const row = rows.find((node) => within(node).queryByText(text));
  if (!row) throw new Error(`Missing row ${section}: ${text}`);
  return within(row);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadInbox).mockReset();
  useAuthStore.setState({ user: { id: 1, username: 'admin', role: 'admin' } });
  vi.mocked(deploymentsApi.approve).mockResolvedValue({} as never);
  vi.mocked(deploymentsApi.reject).mockResolvedValue({} as never);
  vi.mocked(agentApi.resume).mockResolvedValue({ ok: true });
});

afterEach(async () => {
  cleanup();
  await act(async () => { Modal.destroyAll(); });
  // jsdom 不触发 CSS 离场过渡结束，静态对话框 portal 不会自行卸载。
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

  it('点击待办导航到指定会话/单据并保留筛选；队列概览仍然只打开列表', async () => {
    mockAgentInbox();
    renderPage();
    await screen.findByTestId('inbox-row-stalled');
    const cases = [
      ['agentApprovals', 'firstTool', { session: 'needs-review', tab: 'approvals', approvalKey: firstKey }],
      ['agentApprovals', 'secondTool', { session: 'needs-review', tab: 'approvals', approvalKey: secondKey }],
      ['agentWaiting', 'needs-review', { session: 'needs-review', status: 'waiting_input', tab: 'approvals' }],
      ['agentWaiting', 'ready', { session: 'ready', status: 'waiting_input' }],
      ['stalled', 'running', { session: 'running', stalled: '1' }],
      ['backlogged', 'queued', { session: 'queued', status: 'pending' }],
      ['backlogged', 'id-only', { session: 'id-only', status: 'pending' }],
    ] as const;
    for (const [section, text, params] of cases) {
      await screen.findByTestId('inbox-row-stalled');
      const name = section === 'agentApprovals' ? '查看审批' : '查看会话';
      fireEvent.click(rowWith(section, text).getByRole('link', { name }));
      const target = await screen.findByRole('status');
      expect(Object.fromEntries(new URLSearchParams(target.textContent ?? ''))).toEqual(params);
      fireEvent.click(screen.getByRole('button', { name: '返回收件箱' }));
    }
    expect(agentApi.grantApproval).not.toHaveBeenCalled();
    const queue = await screen.findByTestId('inbox-section-queueStall');
    fireEvent.click(within(queue).getByRole('link'));
    expect((await screen.findByRole('status')).textContent).toBe('');
  });

  it('已知 pending 和无待批的 waiting 才能恢复；审批单降级不隐藏已知审批，也不假报空态', async () => {
    // R278/U1：审批单读取失败不再按「逐会话」发生，而是服务端聚合的**部分降级**
    // （`degraded:true` + `total:null`）。契约语义不变的部分保留断言：
    //   ① 已知审批行照常显示；② 不渲染「本类暂无待办」冒充空态；
    //   ③ 无法确认「该会话没有待批单」⇒ 一律不给「接管/恢复」（未知 ≠ 没有）。
    mockAgentInbox({ unreadable: (id) => id === 'unknown' });
    renderPage();
    await screen.findByTestId('inbox-row-stalled');
    expect(rowWith('stalled', 'running').queryByRole('button', { name: '接管/恢复' })).toBeNull();
    expect(rowWith('backlogged', 'id-only').queryByRole('button', { name: '接管/恢复' })).toBeNull();
    expect(rowWith('agentWaiting', 'unknown').queryByRole('button', { name: '接管/恢复' })).toBeNull();
    expect(rowWith('agentWaiting', 'needs-review').queryByRole('button', { name: '接管/恢复' })).toBeNull();
    // 审批单不完整 ⇒ 连「看起来干净」的 waiting 会话也不能接管（未知不等于无待批）。
    expect(rowWith('agentWaiting', 'ready').queryByRole('button', { name: '接管/恢复' })).toBeNull();
    expect(rowWith('backlogged', 'queued').getByRole<HTMLButtonElement>('button', { name: '接管/恢复' }).disabled).toBe(false);
    expect(rowWith('agentApprovals', 'firstTool').queryByRole('button', { name: /放\s*行/ })).toBeNull();
    const approvals = within(screen.getByTestId('inbox-section-agentApprovals'));
    expect(approvals.getByTestId('inbox-degraded-agentApprovals')).toBeTruthy();
    expect(approvals.getAllByTestId('inbox-row-agentApprovals')).toHaveLength(2);
    expect(approvals.queryByText('本类暂无待办')).toBeNull();
    // 知识点：`total:null` 不是 0——标题必须是「—」。
    expect(screen.getByTestId('inbox-count-agentApprovals').textContent).toContain('—');
  });

  it('审批单全部读取失败时不报零；重试后恢复已知单据和可用的恢复动作', async () => {
    let failed = true;
    mockAgentInbox({ allFail: () => failed });
    renderPage();
    const approvals = within(await screen.findByTestId('inbox-section-agentApprovals'));
    expect(approvals.queryByText(/·\s*0/)).toBeNull();
    expect(approvals.queryByText('本类暂无待办')).toBeNull();
    expect(rowWith('agentWaiting', 'ready').queryByRole('button', { name: '接管/恢复' })).toBeNull();
    failed = false;
    fireEvent.click(approvals.getByRole('button', { name: /重\s*试/ }));
    await approvals.findByText('firstTool');
    expect(approvals.queryByRole('button', { name: /重\s*试/ })).toBeNull();
    expect(rowWith('agentWaiting', 'ready').getByRole<HTMLButtonElement>('button', { name: '接管/恢复' }).disabled).toBe(false);
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

  it.each([
    ['agentWaiting', 'ready', { ok: false, reason: '会话已在别处终止' }],
    ['backlogged', 'queued', { ok: true }],
  ] as const)('从 %s 恢复 %s 时按实际入队结果提示，随后刷新列表和徽标', async (section, id, result) => {
    mockAgentInbox();
    vi.mocked(agentApi.resume).mockResolvedValueOnce(result);
    const refreshed = vi.fn();
    window.addEventListener(INBOX_REFRESH_EVENT, refreshed, { once: true });
    renderPage();
    await screen.findByTestId('inbox-row-stalled');
    fireEvent.click(rowWith(section, id).getByRole('button', { name: '接管/恢复' }));
    expect(agentApi.resume).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: /确\s*认/ }));
    await waitFor(() => expect(refreshed).toHaveBeenCalledOnce());
    expect(agentApi.resume).toHaveBeenCalledWith(id);
    expect(loadInbox).toHaveBeenCalledTimes(2);
    if (result.ok) {
      expect(message.success).toHaveBeenCalledWith('会话已重新入队');
    } else {
      expect(message.warning).toHaveBeenCalledWith(result.reason);
      expect(message.success).not.toHaveBeenCalled();
    }
  });

  it.each(['granted', 'conflict'] as const)('拒绝在竞争中变更的审批单（%s）：呈现服务端状态并刷新', async (outcome) => {
    mockAgentInbox();
    if (outcome === 'conflict') {
      vi.mocked(agentApi.denyApproval).mockRejectedValueOnce({
        __status: 409, errorCode: 'AGENT_APPROVAL_ALREADY_DECIDED', params: { approvalKey: secondKey, status: 'consumed' },
      });
    } else {
      vi.mocked(agentApi.denyApproval).mockResolvedValueOnce({
        ok: true, resumed: false,
        approval: { approvalKey: secondKey, status: 'granted', decidedBy: 'other', decidedAt: null, consumedAt: null },
      });
    }
    renderPage();
    await screen.findByTestId('inbox-row-stalled');
    fireEvent.click(rowWith('agentApprovals', 'secondTool').getByRole('button', { name: /拒\s*绝/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('secondTool');
    fireEvent.click(within(dialog).getByRole('button', { name: /确\s*认/ }));
    await waitFor(() => expect(loadInbox).toHaveBeenCalledTimes(2));
    expect(agentApi.denyApproval).toHaveBeenCalledWith('needs-review', secondKey);
    if (outcome === 'conflict') {
      expect(message.error).toHaveBeenCalledWith(expect.stringContaining('consumed'));
    } else {
      expect(message.warning).toHaveBeenCalledWith('审批单当前状态：已批准');
    }
    expect(message.success).not.toHaveBeenCalled();
  });

  it('即使是管理员也不能审批自己的部署', async () => {
    useAuthStore.setState({ user: { id: 7, username: 'alice', role: 'admin' } });
    vi.mocked(loadInbox).mockResolvedValue(readySections({ deployments: [depItem()] }));
    renderPage();
    const row = within(await screen.findByTestId('inbox-row-deployments'));
    for (const name of [/批\s*准/, /拒\s*绝/]) {
      const button = row.getByRole<HTMLButtonElement>('button', { name });
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(deploymentsApi.approve).not.toHaveBeenCalled();
    expect(deploymentsApi.reject).not.toHaveBeenCalled();
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
