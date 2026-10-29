/**
 * W1（P2）：审批单三态 —— loading / error / empty。
 *
 * 缺陷：AgentSessionsPage 的 openDetail 在 listApprovals 失败时 `setApprovals([])`，
 * 于是「网络抖动/502」与「这个会话确实没有审批单」在 UI 上完全同形：页签显示
 * 「审批单（0）· 无审批单」，而会话其实正卡在等审批。运维据此判断「没卡审批」，
 * 排障方向直接被带偏。
 *
 * 要求（与实现对齐）：
 *  ① 失败 → 页签计数显示「—」+ 面板「读取失败 + 重试」，**不得**出现「无审批单」；
 *  ② 真空数组 → 仍显示「无审批单」（两者必须可区分）；
 *  ③ 重试复用 openDetail（同一 detailSeq 序号机制），成功后表格落地。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Modal } from 'antd';
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
    exportSession: vi.fn(),
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
  createdBy: 'user:alice',
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

const approvalOf = (overrides: Partial<AgentApproval> = {}): AgentApproval => ({
  id: 'apr-1',
  approvalKey: 'apr-s-wait-1700000000000',
  sessionId: 's-wait',
  toolName: 'task_restart',
  reason: 'write 类操作需要人工点头',
  status: 'pending',
  decidedBy: null,
  decidedAt: null,
  consumedAt: null,
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

async function openDetail(id: string) {
  fireEvent.click((await screen.findAllByText('详 情'))[0]);
  await waitFor(() => expect(agentApi.detail).toHaveBeenCalledWith(id));
  await screen.findByText(/审批单（/);
}

async function openApprovalsTab() {
  fireEvent.click(await screen.findByRole('tab', { name: /审批单/ }));
}

beforeEach(() => {
  vi.mocked(agentApi.list).mockReset().mockResolvedValue({
    items: [sessionOf('s-wait', 'waiting_input', '等待审批')],
    total: 1,
  });
  vi.mocked(agentApi.detail).mockReset().mockImplementation(async (id: string) => ({
    session: sessionOf(id, 'waiting_input', '等待审批'),
    steps: [],
    toolCalls: [],
    children: [],
  }));
  vi.mocked(agentApi.resume).mockReset().mockResolvedValue({ ok: true });
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
  Modal.destroyAll();
  vi.clearAllMocks();
});

describe('W1 审批单读取失败 ≠ 无审批单', () => {
  it('listApprovals 失败 → 页签计数「—」、面板读取失败 + 重试，绝不显示「无审批单」', async () => {
    vi.mocked(agentApi.listApprovals).mockRejectedValue(new Error('502 Bad Gateway'));
    renderPage();
    await screen.findByText('session-s-wait');
    await openDetail('s-wait');
    await openApprovalsTab();

    expect(await screen.findByText(/审批单读取失败/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /重\s*试/ })).toBeTruthy();
    // 计数是未知态而不是 0
    expect(screen.getByRole('tab', { name: /审批单（—）/ })).toBeTruthy();
    // 关键：失败不得被渲染成「没有审批单」
    expect(screen.queryByText(/无审批单/)).toBeNull();
  });

  it('真空数组 → 仍显示「无审批单」（与失败态可区分）', async () => {
    vi.mocked(agentApi.listApprovals).mockResolvedValue([]);
    renderPage();
    await screen.findByText('session-s-wait');
    await openDetail('s-wait');
    await openApprovalsTab();

    expect(await screen.findByText(/无审批单/)).toBeTruthy();
    expect(screen.queryByText(/审批单读取失败/)).toBeNull();
    expect(screen.getByRole('tab', { name: /审批单（0）/ })).toBeTruthy();
  });

  it('失败后点「重试」→ 重新拉取审批单并渲染表格', async () => {
    vi.mocked(agentApi.listApprovals)
      .mockRejectedValueOnce(new Error('502'))
      .mockResolvedValue([approvalOf()]);
    renderPage();
    await screen.findByText('session-s-wait');
    await openDetail('s-wait');
    await openApprovalsTab();

    fireEvent.click(await screen.findByRole('button', { name: /重\s*试/ }));

    // 重试走 openDetail：审批单重拉一次，成功后表格落地
    await waitFor(() => expect(vi.mocked(agentApi.listApprovals).mock.calls.length).toBe(2));
    expect(await screen.findByText('task_restart')).toBeTruthy();
    expect(screen.queryByText(/审批单读取失败/)).toBeNull();
  });
});
