/**
 * UI-08：空态/加载态/错误态标准化测试。
 * ① ErrorFallback（整页兜底）：重试按钮（resetErrorBoundary）与「复制错误信息」
 *    双动作——复制走 navigator.clipboard（jsdom 提供 clipboard mock 路径）。
 * ② PageSkeleton 两个标准形态（table / cards）渲染。
 * ③ StateError（页内错误态标准块）错误信息提取 + 重试回调 + 复制降级。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { FallbackProps } from 'react-error-boundary';
import ErrorFallback, { copyErrorText } from '../components/ErrorFallback';
import PageSkeleton from '../components/PageSkeleton';
import StateError from '../components/StateError';

// jsdom 缺失 antd 依赖的浏览器 API（对齐 task-form-page.test 先例）
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

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  // jsdom 无原生 navigator.clipboard——提供 writeText 可写桩
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderErrorFallback(overrides: Partial<FallbackProps> = {}) {
  const resetErrorBoundary = vi.fn();
  render(
    <ErrorFallback
      error={new Error('Boom: 组件渲染失败')}
      resetErrorBoundary={resetErrorBoundary}
      {...overrides}
    />,
  );
  return { resetErrorBoundary };
}

describe('ErrorFallback（UI-08 错误态标准化）', () => {
  it('渲染错误标题/信息与「重新加载」重试按钮，点击触发 resetErrorBoundary', () => {
    const { resetErrorBoundary } = renderErrorFallback();
    expect(screen.getByText('页面出错了')).toBeTruthy();
    expect(screen.getByText(/Boom: 组件渲染失败/)).toBeTruthy();
    const retry = screen.getByText('重新加载').closest('button') as HTMLButtonElement;
    expect(retry).toBeTruthy();
    fireEvent.click(retry);
    expect(resetErrorBoundary).toHaveBeenCalledTimes(1);
  });

  it('「复制错误信息」写入剪贴板并成功提示', async () => {
    renderErrorFallback();
    fireEvent.click(screen.getByText('复制错误信息'));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    const written = writeText.mock.calls[0][0];
    expect(written).toContain('Boom: 组件渲染失败');
    expect(await screen.findByText('错误信息已复制到剪贴板')).toBeTruthy();
  });
});

describe('PageSkeleton（UI-08 加载态标准形态）', () => {
  it('table 形态渲染默认 5 行骨架条目', () => {
    const { container } = render(<PageSkeleton variant="table" />);
    expect(screen.getByTestId('page-skeleton')).toBeTruthy();
    // antd Skeleton 的段落行（bs=Paragraph）每行一个
    const items = container.querySelectorAll('.ant-skeleton');
    expect(items.length).toBe(5);
  });

  it('cards 形态渲染指定张数的卡片骨架', () => {
    const { container } = render(<PageSkeleton variant="cards" rows={2} />);
    expect(screen.getByTestId('page-skeleton')).toBeTruthy();
    const skeletons = container.querySelectorAll('.ant-skeleton');
    expect(skeletons.length).toBe(2);
    const cards = container.querySelectorAll('.ant-card');
    expect(cards.length).toBe(2);
  });
});

describe('StateError（UI-08 页内错误态标准块）', () => {
  it('渲染标题/错误消息并支持重试回调；复制走 clipboard', async () => {
    const onRetry = vi.fn();
    render(<StateError error={new Error('网络错误 500')} onRetry={onRetry} title="加载失败" />);
    expect(screen.getByText('加载失败')).toBeTruthy();
    expect(screen.getByText('网络错误 500')).toBeTruthy();
    fireEvent.click(screen.getByText('重试'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('复制错误信息'));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0][0]).toContain('网络错误 500');
  });

  it('copyErrorText 在 clipboard 缺失时降级 execCommand 路径', async () => {
    // 移除 clipboard mock，走 execCommand 降级分支
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const exec = vi.fn().mockReturnValue(true);
    document.execCommand = exec as unknown as typeof document.execCommand;
    const ok = await copyErrorText('fallback-copy');
    expect(ok).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
  });
});
