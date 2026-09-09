/**
 * UI-08：页面错误态接入回归——TaskTemplatesPage 列表请求 reject 时，
 * 页内渲染 StateError 标准错误块（标题+错误信息+重试+复制），
 * 且重试按钮触发 useRequest refresh（重新发起 list 请求）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaskTemplatesPage from '../pages/TaskTemplatesPage';
import { taskTemplatesApi } from '../api/task-templates';

const navMock = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navMock }));
vi.mock('../api/task-templates', () => ({
  taskTemplatesApi: { list: vi.fn(), get: vi.fn(), create: vi.fn(), remove: vi.fn(), instantiate: vi.fn() },
}));

// jsdom 缺失 antd 依赖的浏览器 API（对齐既有先例）
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
  navMock.mockReset();
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('TaskTemplatesPage 错误态接入（UI-08）', () => {
  it('列表请求失败渲染 StateError 错误块（含错误信息），重试重新发起请求，复制写入剪贴板', async () => {
    vi.mocked(taskTemplatesApi.list)
      .mockReset()
      .mockRejectedValueOnce(new Error('后端连接中断'))
      // 重试路径：第二次调用成功返回空列表
      .mockResolvedValueOnce([] as never);

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TaskTemplatesPage />
      </QueryClientProvider>,
    );

    // 错误块呈现：标题 + 具体错误消息
    expect(await screen.findByTestId('state-error')).toBeTruthy();
    expect(screen.getByText('加载模板失败')).toBeTruthy();
    expect(screen.getByText('后端连接中断')).toBeTruthy();

    // 复制错误信息写入剪贴板
    fireEvent.click(screen.getByText('复制错误信息'));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalled();
      expect(writeText.mock.calls[0][0]).toContain('后端连接中断');
    });

    // 重试 → list 再次被调用（refresh 语义）
    fireEvent.click(screen.getByText('重试'));
    await waitFor(() => {
      expect(taskTemplatesApi.list).toHaveBeenCalledTimes(2);
    });
  });
});
