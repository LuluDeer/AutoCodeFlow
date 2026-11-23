/**
 * UX 边界回归（本轮全站打磨）：AgentSessionsPage
 *  ① URL-SYNC-01：kind/status/page/pageSize 以 URL 为初始源并回写（对齐
 *     TaskListPage/ExecutionsPage 先例）——刷新/分享链接不丢筛选与页码；
 *  ② UI-16：首屏加载失败 → 页内 StateError（重试+复制），不再只弹 toast；
 *  ③ 空态区分：筛选无匹配给「清除筛选」出口，点击后复位筛选与页码。
 *
 * mock 风格对齐 agent-sessions-page-b14.test.tsx（api 层 mock + antd shim）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import AgentSessionsPage from '../pages/AgentSessionsPage';
import { agentApi } from '../api/agent';
import type { AgentSession } from '../api/agent';

vi.mock('../api/agent', () => ({
  agentApi: {
    list: vi.fn(),
    pendingTakeoverCount: vi.fn().mockResolvedValue(1),
    stalledCount: vi.fn().mockResolvedValue(1),
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

const sessionOf = (id: string, status: string): AgentSession => ({
  id,
  kind: 'incident',
  status,
  title: `session-${id}`,
  triggerSource: 'cron',
  // G4 起 AgentSession.createdBy 是必填字段（'user:<name>' / 'system:cron' / null=存量未知）
  createdBy: null,
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
  waitingFor: null,
  startedAt: null,
  finishedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

/** useLocation 探针：断言页面回写的 URL 查询串 */
let lastSearch = '';
function SearchProbe() {
  const { search } = useLocation();
  lastSearch = search;
  return null;
}

function renderPage(initialEntry = '/agent-sessions') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AgentSessionsPage />
      <SearchProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(agentApi.list).mockReset().mockResolvedValue({
    items: [sessionOf('s-run', 'running')],
    total: 1,
  });
  // A1 审批闭环：抽屉相关用例不涉审批，默认空列表
  vi.mocked(agentApi.listApprovals).mockReset().mockResolvedValue([]);
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

describe('AgentSessionsPage URL 同步（URL-SYNC-01）', () => {
  it('深链 ?kind=incident&page=2 → list 以 URL 参数发起', async () => {
    renderPage('/agent-sessions?kind=incident&page=2');
    await waitFor(() => {
      expect(agentApi.list).toHaveBeenCalledWith({
        kind: 'incident',
        status: undefined,
        page: 2,
        pageSize: 20,
      });
    });
  });

  it('切换类型筛选 → 回写 URL（replace，刷新/分享不丢状态）', async () => {
    renderPage();
    await screen.findByText('session-s-run');

    fireEvent.mouseDown(screen.getByText('按类型筛选', { selector: '.ant-select-placeholder' }));
    // UX-06 后选项 label 走 agents.kind.* 词条（value 仍是后端 token 'incident'）
    fireEvent.click(
      await screen.findByText('事件处置', { selector: '.ant-select-item-option-content' }),
    );

    await waitFor(() => {
      expect(lastSearch).toContain('kind=incident');
    });
  });

  it('非法深链 page=abc → 回落 page=1，不空屏不报错', async () => {
    renderPage('/agent-sessions?page=abc');
    await waitFor(() => {
      expect(agentApi.list).toHaveBeenCalledWith({
        kind: undefined,
        status: undefined,
        page: 1,
        pageSize: 20,
      });
    });
  });
});

describe('AgentSessionsPage 错误态与空态（UI-16）', () => {
  it('首屏加载失败 → 页内 StateError（重试入口），重试后恢复', async () => {
    vi.mocked(agentApi.list)
      .mockRejectedValueOnce(new Error('网关超时'))
      .mockResolvedValueOnce({ items: [sessionOf('s-run', 'running')], total: 1 });

    renderPage();
    expect(await screen.findByTestId('state-error')).toBeTruthy();
    expect(screen.getByText('网关超时')).toBeTruthy();

    fireEvent.click(screen.getByText('重试'));
    await waitFor(() => expect(agentApi.list).toHaveBeenCalledTimes(2));
    await screen.findByText('session-s-run');
    expect(screen.queryByTestId('state-error')).toBeNull();
  });

  it('筛选无匹配 → noMatch 空态 + 清除筛选复位（筛选与页码）', async () => {
    vi.mocked(agentApi.list).mockResolvedValue({ items: [], total: 0 });
    renderPage('/agent-sessions?kind=incident&page=3');
    expect(await screen.findByText('没有匹配的会话')).toBeTruthy();

    fireEvent.click(screen.getAllByText('清除筛选')[0]);
    await waitFor(() => {
      expect(agentApi.list).toHaveBeenLastCalledWith({
        kind: undefined,
        status: undefined,
        page: 1,
        pageSize: 20,
      });
    });
  });

  it('真空态（无筛选）→ 如实提示，不出现清除筛选按钮', async () => {
    vi.mocked(agentApi.list).mockResolvedValue({ items: [], total: 0 });
    renderPage();
    expect(await screen.findByText('暂无 Agent 会话')).toBeTruthy();
    expect(screen.queryByText('清除筛选')).toBeNull();
  });
});

describe('Agent 会话定位', () => {
  it('卡住与等待输入互斥；切换徽标会重新请求第一页并保留无关参数', async () => {
    renderPage('/agent-sessions?status=waiting_input&page=3&from=oncall');
    fireEvent.click(await screen.findByTestId('stalled-jump'));
    await waitFor(() => expect(agentApi.list).toHaveBeenLastCalledWith({ kind: undefined, status: undefined, page: 1, pageSize: 20, stalled: 1 }));
    let q = new URLSearchParams(lastSearch);
    expect([q.get('stalled'), q.get('status'), q.get('page'), q.get('from')]).toEqual(['1', null, null, 'oncall']);
    fireEvent.click(screen.getByTestId('pending-takeover-jump'));
    await waitFor(() => expect(agentApi.list).toHaveBeenLastCalledWith({ kind: undefined, status: 'waiting_input', page: 1, pageSize: 20 }));
    q = new URLSearchParams(lastSearch);
    expect([q.get('stalled'), q.get('status'), q.get('from')]).toEqual([null, 'waiting_input', 'oncall']);
  });

  it('格式错误的链接展示明确反馈，不发送详情或审批请求', async () => {
    vi.mocked(agentApi.detail).mockReset();
    renderPage('/agent-sessions?session=..%2Fbad');
    expect(await screen.findByText(/会话链接的格式不正确/)).toBeTruthy();
    expect(agentApi.detail).not.toHaveBeenCalled();
    expect(agentApi.listApprovals).not.toHaveBeenCalled();
  });

  it('卡住会话展示真实步骤时间，不把会话最后一次更新当作进度', async () => {
    const stepTime = '2026-01-01T10:00:00Z';
    vi.mocked(agentApi.detail).mockResolvedValue({
      session: { ...sessionOf('s-run', 'running'), updatedAt: '2026-01-01T10:40:00Z' },
      steps: [{ id: 'step-2', sessionId: 's-run', seq: 2, role: 'assistant', content: 'progress', summary: null,
        reasoning: null, toolCallsJson: null, toolCallId: null, provider: null, model: null, tokensIn: 1, tokensOut: 1, latencyMs: 1, createdAt: stepTime }],
      toolCalls: [], children: [],
    });
    renderPage('/agent-sessions?session=s-run&stalled=1');
    const label = await screen.findByText('最近记录的步骤：第 2 步');
    expect(label.parentElement?.querySelector('time')?.dateTime).toBe(stepTime);
    expect(screen.queryByRole('button', { name: /恢\s*复/ })).toBeNull();
  });

  it('目标不在列表：呈现读取错误，重试同一 ID 后显示完整问题和答复而非截短摘要', async () => {
    const full = 'step '.repeat(60) + 'FINAL LINE';
    vi.mocked(agentApi.detail).mockReset().mockRejectedValueOnce(new Error('upstream timeout')).mockResolvedValue({
      session: { ...sessionOf('off-page', 'succeeded'), contextJson: { question: 'Why?' }, summary: 'short', resultJson: { conclusion: full } },
      steps: [], toolCalls: [], children: [],
    });
    renderPage('/agent-sessions?session=off-page');
    await screen.findByText('upstream timeout');
    fireEvent.click(screen.getByText('重试'));
    const answer = await screen.findByRole('region', { name: 'Agent 答复' });
    expect(answer.textContent).toContain(full);
    expect(screen.getByRole('region', { name: '本次问题' }).textContent).toContain('Why?');
    expect(vi.mocked(agentApi.detail).mock.calls).toEqual([['off-page'], ['off-page']]);
  });
});
