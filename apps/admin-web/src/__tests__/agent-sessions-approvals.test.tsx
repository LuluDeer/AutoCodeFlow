/**
 * A1 审批闭环（审计轮 #11 → 实施轮 #12，前端半边）回归：AgentSessionsPage
 *  ① 详情抽屉「审批单」页签：列出会话审批单（工具/理由/状态徽标/处置人/时间）；
 *  ② pending 单的批准/拒绝 → 调 grant/deny 端点；成功后提示 + 刷新详情与列表；
 *  ③ resumed=true 的提示说明会话已重新入队；
 *  ④ 409（AGENT_APPROVAL_ALREADY_DECIDED，并发处置后到者）→ 如实提示并刷新。
 *
 * mock 风格对齐 agent-sessions-page-b14.test.tsx（api 层 mock + antd shim）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../i18n';
import AgentSessionsPage from '../pages/AgentSessionsPage';
import { agentApi } from '../api/agent';
import type { AgentApproval, AgentSession } from '../api/agent';

vi.mock('../api/agent', () => ({
  agentApi: {
    list: vi.fn(),
    detail: vi.fn(),
    resume: vi.fn(),
    budget: vi.fn(),
    create: vi.fn(),
    listApprovals: vi.fn(),
    grantApproval: vi.fn(),
    denyApproval: vi.fn(),
  },
  AGENT_SESSION_STATUSES: [
    'pending',
    'running',
    'waiting_input',
    'succeeded',
    'failed',
    'aborted',
    'budget_exceeded',
  ],
}));

// jsdom 缺失 antd 依赖的浏览器 API，先行补齐（既有页面测试先例）
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

const sessionOf = (id: string, status: string, waitingFor: string | null = null): AgentSession => ({
  id,
  kind: 'incident',
  status,
  title: `session-${id}`,
  triggerSource: 'cron',
  parentSessionId: null,
  contextJson: {},
  scopeJson: {},
  budgetJson: null,
  resultJson: null,
  summary: null,
  errorMessage: null,
  totalSteps: 1,
  totalTokensIn: 1,
  totalTokensOut: 1,
  totalToolCalls: 0,
  waitingFor,
  startedAt: null,
  finishedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

const approvalOf = (overrides: Partial<AgentApproval>): AgentApproval => ({
  id: 'apr-1',
  approvalKey: 'apr-s-wait-1700000000000',
  sessionId: 's-wait',
  toolName: 'task_restart',
  reason: 'write 类操作需要人工点头（审批策略 writeRequiresApproval=true）',
  status: 'pending',
  decidedBy: null,
  decidedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

function renderPage() {
  return render(
    <MemoryRouter>
      <AgentSessionsPage />
    </MemoryRouter>,
  );
}

/** 点第一行「详 情」（antd 两字按钮插空格）打开抽屉并等审批单页签出现 */
async function openDetail(id: string) {
  fireEvent.click((await screen.findAllByText('详 情'))[0]);
  await waitFor(() => expect(agentApi.detail).toHaveBeenCalledWith(id));
  await screen.findByText(/审批单（/);
}

/**
 * 切到「审批单」页签。antd 6 Tabs 的非激活且从未激活的面板**默认不挂载**
 * （@rc-component/motion CSSMotion：removeOnLeave=false 但 leavedClassName
 * 非空且 forceRender 未传时返回 null），因此断言面板内容前必须真实点击
 * 页签（默认激活页签是「推理步骤」）。
 */
async function openApprovalsTab() {
  fireEvent.click(await screen.findByRole('tab', { name: /审批单/ }));
}

beforeEach(() => {
  vi.mocked(agentApi.list).mockReset().mockResolvedValue({
    items: [sessionOf('s-wait', 'waiting_input', '等待审批 apr-s-wait-1700000000000')],
    total: 1,
  });
  vi.mocked(agentApi.detail).mockReset().mockImplementation(async (id: string) => ({
    session: sessionOf(id, 'waiting_input', '等待审批 apr-s-wait-1700000000000'),
    steps: [],
    toolCalls: [],
    children: [],
  }));
  vi.mocked(agentApi.resume).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(agentApi.listApprovals).mockReset().mockResolvedValue([
    approvalOf({}),
  ]);
  vi.mocked(agentApi.grantApproval).mockReset().mockResolvedValue({
    ok: true,
    approval: {
      approvalKey: 'apr-s-wait-1700000000000',
      status: 'granted',
      decidedBy: 'admin',
      decidedAt: '2026-01-01T00:01:00Z',
    },
    resumed: true,
  });
  vi.mocked(agentApi.denyApproval).mockReset().mockResolvedValue({
    ok: true,
    approval: {
      approvalKey: 'apr-s-wait-1700000000000',
      status: 'denied',
      decidedBy: 'admin',
      decidedAt: '2026-01-01T00:01:00Z',
    },
    resumed: false,
  });
  vi.mocked(agentApi.budget).mockReset().mockResolvedValue({
    maxSteps: 40,
    maxTokens: 1000,
    wallClockMs: 60000,
    maxToolCalls: 20,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('A1 审批闭环：详情抽屉「审批单」区块', () => {
  it('打开详情即拉取审批单列表并呈现（工具/理由/状态徽标/处置时间）', async () => {
    renderPage();
    await screen.findByText('session-s-wait');
    await openDetail('s-wait');
    await openApprovalsTab();

    expect(await screen.findByText('task_restart')).toBeTruthy();
    expect(screen.getByText(/write 类操作需要人工点头/)).toBeTruthy();
    // 状态徽标走 agents.approvalStatus.* 词表
    expect(screen.getByText('待批准')).toBeTruthy();
    // 未处置的 decidedBy/decidedAt 呈现占位
    expect(screen.getByText('批 准')).toBeTruthy();
    expect(screen.getByText('拒 绝')).toBeTruthy();
    // waiting_input 行有「等待审批」徽标
    expect(screen.getAllByText('等待审批').length).toBeGreaterThan(0);
  });

  it('无审批单 → 空态如实提示，不渲染操作按钮', async () => {
    vi.mocked(agentApi.listApprovals).mockResolvedValue([]);
    renderPage();
    await screen.findByText('session-s-wait');
    await openDetail('s-wait');
    await openApprovalsTab();
    expect(await screen.findByText(/无审批单/)).toBeTruthy();
    expect(screen.queryByText('批 准')).toBeNull();
  });
});

describe('A1 审批闭环：处置操作', () => {
  it('批准 → POST grant；resumed=true 提示会话已重新入队；详情与列表刷新', async () => {
    renderPage();
    await screen.findByText('session-s-wait');
    await openDetail('s-wait');
    await openApprovalsTab();

    fireEvent.click(screen.getByText('批 准'));
    await waitFor(() =>
      expect(agentApi.grantApproval).toHaveBeenCalledWith('s-wait', 'apr-s-wait-1700000000000'),
    );
    // resumed=true 的提示
    expect(await screen.findByText(/会话已重新入队/)).toBeTruthy();
    // 刷新详情（审批单列表重拉）与列表（silent 拍）
    await waitFor(() => expect(agentApi.listApprovals).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(agentApi.list).toHaveBeenCalledTimes(2));
  });

  it('拒绝 → POST deny；resumed=false 提示不含重新入队', async () => {
    renderPage();
    await screen.findByText('session-s-wait');
    await openDetail('s-wait');
    await openApprovalsTab();

    fireEvent.click(screen.getByText('拒 绝'));
    await waitFor(() =>
      expect(agentApi.denyApproval).toHaveBeenCalledWith('s-wait', 'apr-s-wait-1700000000000'),
    );
    const toast = await screen.findByText(/已拒绝（apr-s-wait-1700000000000）/);
    expect(toast.textContent).not.toContain('会话已重新入队');
  });

  it('409（并发已处置，拦截器已弹词条提示）→ 不再重复弹错，但刷新详情与列表', async () => {
    const conflict = Object.assign(new Error('审批单已被处置'), {
      __status: 409,
      __toastedByClient: true,
    });
    vi.mocked(agentApi.grantApproval).mockRejectedValueOnce(conflict);
    renderPage();
    await screen.findByText('session-s-wait');
    await openDetail('s-wait');
    await openApprovalsTab();

    fireEvent.click(screen.getByText('批 准'));
    await waitFor(() => expect(agentApi.grantApproval).toHaveBeenCalled());
    // 无重复 toast：文案里不应出现「处置失败」兜底（__toastedByClient 已标）
    await waitFor(() => expect(agentApi.listApprovals).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(agentApi.list).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/处置失败/)).toBeNull();
  });

  it('普通失败 → 兜底提示，且不触发刷新（可重试）', async () => {
    // 裸 Error（无 response.data.errorCode）→ getErrMsg 落到 err.message 原文
    // （「网络断开」），不走「审批单处置失败（{{key}}）」词条——兜底词条只在
    // 错误既无 localized 也无 message 时出现。
    vi.mocked(agentApi.grantApproval).mockRejectedValueOnce(new Error('网络断开'));
    renderPage();
    await screen.findByText('session-s-wait');
    await openDetail('s-wait');
    await openApprovalsTab();

    fireEvent.click(screen.getByText('批 准'));
    expect(await screen.findByText('网络断开')).toBeTruthy();
    expect(agentApi.listApprovals).toHaveBeenCalledTimes(1); // 未刷新
  });
});
