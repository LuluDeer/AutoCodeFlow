/**
 * LOG-WIN-01：LogWindow 窗口化日志组件测试。
 *
 * 契约：
 *  1) 600 行输入只渲染可视窗口（±OVERSCAN）行——DOM 行数远小于总行数；
 *  2) 行内文本与输入行一致（窗口切片保真）；
 *  3) 关键词命中渲染 <mark class="log-search-hit">（与页面 <pre> 同口径）；
 *  4) 撑高层高度 = 行数 × LOG_ROW_HEIGHT（真实滚动条）。
 *
 * jsdom 无布局：scrollTop 初值 0 → 首窗从第 0 行起渲染，可确定性断言。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import LogWindow, { LOG_ROW_HEIGHT } from '../components/LogWindow';

const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const N = 600;
const makeText = () => Array.from({ length: N }, (_, i) => `line-${String(i).padStart(4, '0')}`).join('\n');

beforeEach(() => {
  // jsdom 缺 matchMedia（antd 依赖）时的既有 shim
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false, media: q, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
});

afterEach(() => cleanup());

describe('LogWindow（LOG-WIN-01）', () => {
  it('600 行只渲染可视窗口行，且首窗内容保真', () => {
    render(<LogWindow text={makeText()} testId="log-window" />);
    const container = screen.getByTestId('log-window');
    // 可视窗口（height 500 / 20 = 25 行）+ 上下 OVERSCAN 20 ≈ 65 行上限
    const renderedRows = container.querySelectorAll('div[style*="height: 20px"], div[style*="height:20px"]');
    expect(renderedRows.length).toBeGreaterThan(0);
    expect(renderedRows.length).toBeLessThan(100);
    // 首窗从 line-0000 开始
    expect(screen.getByText('line-0000')).toBeTruthy();
    // 首窗必然不含远离窗口的行
    expect(screen.queryByText(`line-${String(N - 1).padStart(4, '0')}`)).toBeNull();
  });

  it('撑高层高度 = 行数 × 行高', () => {
    const { container } = render(<LogWindow text={makeText()} testId="log-window" />);
    const spacer = container.querySelector('div[style*="height: 12000px"], div[style*="height:12000px"]');
    expect(spacer).toBeTruthy();
  });

  it('滚动事件移动窗口（scrollTop=6000 → 第 300 行附近可见）', () => {
    render(<LogWindow text={makeText()} testId="log-window" />);
    const el = screen.getByTestId('log-window') as HTMLElement;
    Object.defineProperty(el, 'scrollTop', { value: 300 * LOG_ROW_HEIGHT, configurable: true });
    fireEvent.scroll(el);
    // 第 300 行进入窗口
    expect(screen.getByText('line-0300')).toBeTruthy();
    // 第 0 行已滚出窗口
    expect(screen.queryByText('line-0000')).toBeNull();
  });

  it('关键词命中渲染 mark.log-search-hit（与页面 pre 同口径）', () => {
    const text = ['normal line', 'error hit-target here', 'another line'].join('\n');
    render(<LogWindow text={text} keyword="hit-target" testId="log-window" />);
    const marks = document.querySelectorAll('mark.log-search-hit');
    expect(marks.length).toBe(1);
    expect(marks[0].textContent).toBe('hit-target');
  });

  it('行级级别高亮类透传（ERROR 行挂 log-line-error）', () => {
    // 时间戳需含时间部分才会被 TIMESTAMP_PREFIX_RE 剥离，随后 ERROR\s 命中
    const text = 'plain\n2026-09-25 10:00:00 ERROR something blew up\nplain';
    const { container } = render(<LogWindow text={text} testId="log-window" />);
    expect(container.querySelector('.log-line-error')).toBeTruthy();
  });
});
