/**
 * P1-4 顶栏待办徽标回归（诚实口径，对齐 PendingTakeoverBadge / BacklogBadge）：
 * - 0 件隐藏；有计数展示总数；
 * - 任一源读不到 ⇒ 总数未知（显示「—」），不用局部和谎报；
 * - 计数源整体失败 ⇒ 可见的可重试错误态（不隐藏，避免被误读成没有待办）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import InboxBadge from '../components/InboxBadge';
import { loadInboxCounts } from '../api/inbox';
import type { InboxCountMap } from '../api/inbox';

vi.mock('../api/inbox', () => ({
  INBOX_REFRESH_EVENT: 'autoflow:inbox-refresh',
  loadInboxCounts: vi.fn(),
  summarizeInboxCounts: vi.fn((counts: InboxCountMap) => {
    let total = 0;
    for (const [k, v] of Object.entries(counts)) {
      if (k === 'recentFailures') continue; // 只读参考项，不计入总数
      if (v === null) return null;
      total += v;
    }
    return total;
  }),
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

const counts = (overrides: Partial<InboxCountMap> = {}): InboxCountMap => ({
  deployments: 0,
  agentApprovals: 0,
  agentWaiting: 0,
  stalled: 0,
  backlogged: 0,
  queueStall: 0,
  recentFailures: null,
  ...overrides,
});

beforeEach(() => {
  vi.mocked(loadInboxCounts).mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('InboxBadge 顶栏待办入口', () => {
  it('0 件时整体隐藏', async () => {
    vi.mocked(loadInboxCounts).mockResolvedValue(counts());
    render(<MemoryRouter><InboxBadge /></MemoryRouter>);
    await waitFor(() => expect(vi.mocked(loadInboxCounts)).toHaveBeenCalled());
    expect(screen.queryByTestId('inbox-badge-button')).toBeNull();
  });

  it('有待办时展示计数并可点击进入收件箱', async () => {
    vi.mocked(loadInboxCounts).mockResolvedValue(counts({ deployments: 2, stalled: 1 }));
    render(<MemoryRouter><InboxBadge /></MemoryRouter>);
    const btn = await screen.findByTestId('inbox-badge-button');
    expect(btn).toBeTruthy();
    // 徽标在 loading 阶段先渲染「—」，计数是后续异步落地的；
    // 直接断言会与 setState 竞态（CI 上曾报 expected '—' to contain '3'）。
    await waitFor(() => {
      expect(screen.getByTestId('inbox-badge').textContent).toContain('3');
    });
  });

  it('任一源未知（null）⇒ 徽标显示「—」而不是假总数', async () => {
    vi.mocked(loadInboxCounts).mockResolvedValue(counts({ deployments: 2, backlogged: null }));
    render(<MemoryRouter><InboxBadge /></MemoryRouter>);
    await screen.findByTestId('inbox-badge-button');
    expect(screen.getByTestId('inbox-badge').textContent).toContain('—');
  });

  it('计数源失败 ⇒ 错误态可见，点击重试重新拉取', async () => {
    vi.mocked(loadInboxCounts).mockRejectedValue(new Error('network'));
    render(<MemoryRouter><InboxBadge /></MemoryRouter>);
    const retry = await screen.findByTestId('inbox-badge-load-fail');
    fireEvent.click(retry);
    await waitFor(() => expect(vi.mocked(loadInboxCounts)).toHaveBeenCalledTimes(2));
  });
});
