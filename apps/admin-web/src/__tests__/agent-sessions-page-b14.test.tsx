/**
 * B-14（前端最小步）+ B-8（前端半边）回归：AgentSessionsPage
 *  ① 15s 轮询自动刷新——interval 注入 + 失焦暂停（对齐 ExecutionsPage 先例）；
 *  ② resumable 集合排除 running——后端对 running 会话的 resume 返回 409，
 *     前端同步隐藏「恢复」入口（B-8 双保险的前端半边）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import '../i18n';
import AgentSessionsPage from '../pages/AgentSessionsPage';
import { agentApi } from '../api/agent';
import type { AgentSession } from '../api/agent';

vi.mock('../api/agent', () => ({
  agentApi: {
    list: vi.fn(),
    detail: vi.fn(),
    resume: vi.fn(),
    budget: vi.fn(),
    create: vi.fn(),
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

// jsdom 缺失 antd 依赖的浏览器 API，先行补齐（对齐既有页面测试先例）
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

const realSetInterval = globalThis.setInterval;

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

const sessionOf = (id: string, status: string): AgentSession => ({
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
  waitingFor: null,
  startedAt: null,
  finishedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

beforeEach(() => {
  setVisibility('visible');
  vi.mocked(agentApi.list).mockReset().mockResolvedValue({
    items: [sessionOf('s-run', 'running'), sessionOf('s-wait', 'waiting_input')],
    total: 2,
  });
  vi.mocked(agentApi.detail).mockReset().mockImplementation(async (id: string) => ({
    session: sessionOf(id, id === 's-run' ? 'running' : 'waiting_input'),
    steps: [],
    toolCalls: [],
    children: [],
  }));
  vi.mocked(agentApi.resume).mockReset().mockResolvedValue({ ok: true });
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
  delete (document as unknown as Record<string, unknown>).visibilityState;
});

describe('B-14 AgentSessionsPage 15s 轮询', () => {
  it('interval 注入：可见时每拍静默刷新；标签页隐藏时跳过本拍', async () => {
    const pollers: Array<() => void> = [];
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, delay?: number) => {
      if (delay === 15_000) {
        pollers.push(fn);
        return 0 as never;
      }
      return realSetInterval(fn as never, delay as never) as never;
    }) as never);

    render(<AgentSessionsPage />);
    await waitFor(() => expect(agentApi.list).toHaveBeenCalledTimes(1));

    await act(async () => {
      pollers[0]();
    });
    await waitFor(() => expect(agentApi.list).toHaveBeenCalledTimes(2));

    setVisibility('hidden');
    await act(async () => {
      pollers[0]();
    });
    expect(agentApi.list).toHaveBeenCalledTimes(2);
  });
});

describe('B-8 resumable 集合排除 running', () => {
  it('running 会话详情不出现「恢复」按钮；waiting_input 出现', async () => {
    render(<AgentSessionsPage />);
    await screen.findByText('session-s-run');

    // 行内「详 情」按钮进详情（antd 两字按钮插空格）；行本身不可点
    const detailButtons = await screen.findAllByText('详 情');
    expect(detailButtons.length).toBe(2); // s-run 行在前、s-wait 行在后
    fireEvent.click(detailButtons[0]);
    await waitFor(() => expect(agentApi.detail).toHaveBeenCalledWith('s-run'));
    // 抽屉打开的标志：meta 标签页出现
    await screen.findByText('上下文与结论');
    expect(screen.queryByText('恢复')).toBeNull();
    expect(screen.queryByText('恢 复')).toBeNull();

    // 打开第二行（waiting_input）：恢复入口在
    fireEvent.click((await screen.findAllByText('详 情'))[1]);
    await waitFor(() => expect(agentApi.detail).toHaveBeenCalledWith('s-wait'));
    await waitFor(() => {
      const resume = screen.queryByText('恢复') ?? screen.queryByText('恢 复');
      expect(resume).toBeTruthy();
    });
  });
});
