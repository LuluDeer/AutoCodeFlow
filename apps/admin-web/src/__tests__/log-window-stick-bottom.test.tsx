/**
 * F-4（UIUX 审计 P2-3）回归：LogWindow 流式追加 stick-to-bottom。
 *
 * 旧行为是 `useEffect(() => { el.scrollTop = el.scrollHeight }, [text])` 的
 * 无条件吸底：SSE 每一批追加都把用户上翻后的滚动位置拽回底部，流式阶段的
 * 日志区基本不可上翻排查。
 *
 * 新契约：
 *  1) 用户贴近底部（≤ LOG_STICK_BOTTOM_THRESHOLD_PX）时追加 → 继续吸底（原行为）；
 *  2) 用户上翻远离底部后追加 → 滚动位置保持不动，且出现「回到底部」浮钮；
 *  3) 点击浮钮 → 跳回底部，浮钮消失。
 *
 * jsdom 无布局：scrollHeight/clientHeight 是 0，用可配置 getter 把它们锚到
 * 当前行数 × LOG_ROW_HEIGHT / 视口高度上；scrollTop 换成可读写桩（组件会
 * 写回它），滚动行为即可确定性断言。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import LogWindow, { LOG_ROW_HEIGHT, LOG_STICK_BOTTOM_THRESHOLD_PX } from '../components/LogWindow';

const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const VIEWPORT = 500;

/** 挂可变布局锚：scrollHeight = 行数 × 行高、clientHeight = 视口、scrollTop 可读写。 */
function anchorLayout(el: HTMLElement, getLines: () => number): { scrollTop: number } {
  const state = { scrollTop: 0 };
  const maxScroll = () => Math.max(0, getLines() * LOG_ROW_HEIGHT - VIEWPORT);
  Object.defineProperty(el, 'clientHeight', {
    get: () => VIEWPORT,
    configurable: true,
  });
  Object.defineProperty(el, 'scrollHeight', {
    get: () => getLines() * LOG_ROW_HEIGHT,
    configurable: true,
  });
  Object.defineProperty(el, 'scrollTop', {
    get: () => state.scrollTop,
    set: (v: number) => {
      // 忠实模拟浏览器语义：scrollTop 写入会被钳位到 [0, scrollHeight - clientHeight]
      state.scrollTop = Math.max(0, Math.min(v, maxScroll()));
    },
    configurable: true,
  });
  return state;
}

const linesOf = (text: string) => text.split('\n');

const makeLines = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => `line-${String(from + i).padStart(4, '0')}`).join('\n');

beforeEach(() => {
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

describe('F-4: LogWindow stick-to-bottom', () => {
  it('贴底时追加继续吸底（原行为保留），且不出现浮钮', () => {
    let text = makeLines(0, 100);
    const { rerender } = render(<LogWindow text={text} testId="log-window" />);
    const el = screen.getByTestId('log-window') as HTMLElement;
    const state = anchorLayout(el, () => linesOf(text).length);

    // 模拟贴底滚动：scrollTop = scrollHeight - clientHeight（距底 0px）
    act(() => {
      state.scrollTop = 100 * LOG_ROW_HEIGHT - VIEWPORT;
      fireEvent.scroll(el);
    });

    text = `${text}\n${makeLines(100, 110)}`;
    rerender(<LogWindow text={text} testId="log-window" />);

    // 追加后仍被拽到新底部（scrollTop = 新 scrollHeight - clientHeight）
    expect(state.scrollTop).toBe(110 * LOG_ROW_HEIGHT - VIEWPORT);
    expect(screen.queryByTestId('log-window-back-to-bottom')).toBeNull();
  });

  it('上翻远离底部后追加：滚动位置保持不动，出现「回到底部」浮钮', () => {
    let text = makeLines(0, 100);
    const { rerender } = render(<LogWindow text={text} testId="log-window" />);
    const el = screen.getByTestId('log-window') as HTMLElement;
    const state = anchorLayout(el, () => linesOf(text).length);

    // 先贴底，再上翻到第 10 行附近（距底远超阈值）
    const scrolledUpTop = 10 * LOG_ROW_HEIGHT;
    act(() => {
      state.scrollTop = 100 * LOG_ROW_HEIGHT - VIEWPORT;
      fireEvent.scroll(el);
    });
    act(() => {
      state.scrollTop = scrolledUpTop;
      fireEvent.scroll(el);
    });

    text = `${text}\n${makeLines(100, 110)}`;
    rerender(<LogWindow text={text} testId="log-window" />);

    // 滚动位置不被新内容拽走
    expect(state.scrollTop).toBe(scrolledUpTop);
    // 浮钮出现且渲染双语词条
    const btn = screen.getByTestId('log-window-back-to-bottom');
    expect(btn.textContent).toContain('回到底部');
  });

  it('阈值边界：距底 ≤ LOG_STICK_BOTTOM_THRESHOLD_PX 仍视为贴底继续跟随', () => {
    let text = makeLines(0, 100);
    const { rerender } = render(<LogWindow text={text} testId="log-window" />);
    const el = screen.getByTestId('log-window') as HTMLElement;
    const state = anchorLayout(el, () => linesOf(text).length);

    // 恰好停在阈值内（距底 39px < 40px）
    act(() => {
      state.scrollTop = 100 * LOG_ROW_HEIGHT - VIEWPORT - (LOG_STICK_BOTTOM_THRESHOLD_PX - 1);
      fireEvent.scroll(el);
    });

    text = `${text}\n${makeLines(100, 105)}`;
    rerender(<LogWindow text={text} testId="log-window" />);
    expect(state.scrollTop).toBe(105 * LOG_ROW_HEIGHT - VIEWPORT);
    expect(screen.queryByTestId('log-window-back-to-bottom')).toBeNull();
  });

  it('点击浮钮跳回底部，浮钮消失', () => {
    let text = makeLines(0, 100);
    const { rerender } = render(<LogWindow text={text} testId="log-window" />);
    const el = screen.getByTestId('log-window') as HTMLElement;
    const state = anchorLayout(el, () => linesOf(text).length);

    act(() => {
      state.scrollTop = 5 * LOG_ROW_HEIGHT;
      fireEvent.scroll(el);
    });
    text = `${text}\n${makeLines(100, 110)}`;
    rerender(<LogWindow text={text} testId="log-window" />);
    expect(screen.getByTestId('log-window-back-to-bottom')).toBeTruthy();

    fireEvent.click(screen.getByTestId('log-window-back-to-bottom'));
    expect(state.scrollTop).toBe(110 * LOG_ROW_HEIGHT - VIEWPORT);
    expect(screen.queryByTestId('log-window-back-to-bottom')).toBeNull();
  });
});
