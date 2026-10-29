/**
 * W5（P3）：通知铃必须区分「/metrics/failures 读取失败」与「近期确实无失败」。
 *
 * 缺陷：NotificationBell 只解构 `data`。接口失败时 data 是 undefined →
 *   · 面板渲染 Empty「近期无失败记录」；
 *   · Badge count = 0。
 * 值班场景下这等于谎报「系统太平」。要求：error 时面板显示「读取失败 + 重试」
 * （refetch），Badge 用未知态（dot）而不是 0。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../i18n';
import { setLanguage } from '../i18n';
import NotificationBell from '../components/NotificationBell';
import { useRecentFailures } from '../api/queries';

vi.mock('../api/queries', () => ({
  useRecentFailures: vi.fn(),
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

const renderBell = () =>
  render(
    <MemoryRouter>
      <NotificationBell />
    </MemoryRouter>,
  );

async function openPanel() {
  fireEvent.click(screen.getByTestId('notify-bell'));
  return screen.findByTestId('notify-panel');
}

beforeEach(async () => {
  await setLanguage('zh');
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.mocked(useRecentFailures).mockReset();
});

describe('W5 通知铃失败态', () => {
  it('error → 不显示「近期无失败记录」，显示读取失败 + 重试（点击触发 refetch）', async () => {
    const refetch = vi.fn();
    vi.mocked(useRecentFailures).mockReturnValue({
      data: undefined,
      error: new Error('502 Bad Gateway'),
      refetch,
    } as never);

    renderBell();
    const panel = await openPanel();

    expect(panel.textContent).not.toContain('近期无失败记录');
    expect(panel.textContent).toContain('近期失败读取失败');
    const retry = screen.getByRole('button', { name: /重\s*试/ });
    fireEvent.click(retry);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('error 时 Badge 用未知态 dot，而不是计数 0', async () => {
    vi.mocked(useRecentFailures).mockReturnValue({
      data: undefined,
      error: new Error('502'),
      refetch: vi.fn(),
    } as never);
    const { container } = renderBell();
    // 未知态：Badge 显示「?」而不是 0（0 会被读成「没有新失败」）
    const count = container.querySelector('.ant-badge-count');
    expect(count?.textContent).toContain('?');
  });

  it('成功且无失败 → 仍显示「近期无失败记录」（失败态不吞掉正常空态）', async () => {
    vi.mocked(useRecentFailures).mockReturnValue({
      data: [],
      error: null,
      refetch: vi.fn(),
    } as never);
    renderBell();
    const panel = await openPanel();
    expect(panel.textContent).toContain('近期无失败记录');
    expect(panel.textContent).not.toContain('近期失败读取失败');
  });
});
