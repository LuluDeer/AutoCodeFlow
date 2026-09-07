/**
 * UI-08：ApplicationListPage 首屏错误态接入回归——applicationsApi.list reject 时，
 * 页内渲染 StateError 标准错误块（重试+复制错误信息），表格不再显示误导性空态文案。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ApplicationListPage from '../pages/ApplicationListPage';
import { applicationsApi } from '../api/applications';
import { executorsApi } from '../api/executors';
import { useAuthStore } from '../store/auth';

vi.mock('../api/applications', () => ({
  applicationsApi: { list: vi.fn(), delete: vi.fn(), create: vi.fn(), update: vi.fn(), upload: vi.fn() },
  deploymentsApi: { list: vi.fn(), deploy: vi.fn() },
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn() },
}));

// jsdom 缺失 antd 依赖的浏览器 API，先行补齐（对齐既有先例）
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
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  vi.mocked(applicationsApi.list).mockReset();
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
  useAuthStore.setState({ user: { id: 1, username: 'admin', role: 'admin' } as never });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ApplicationListPage 错误态接入（UI-08）', () => {
  it('列表请求失败渲染 StateError（重试+复制），空态文案不出现，重试重新发起请求', async () => {
    vi.mocked(applicationsApi.list)
      .mockRejectedValueOnce(new Error('网关超时'))
      // 重试路径：第二次调用成功返回空列表
      .mockResolvedValueOnce([] as never);

    render(
      <MemoryRouter>
        <ApplicationListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('state-error')).toBeTruthy();
    expect(screen.getByText('网关超时')).toBeTruthy();

    // 错误态下不显示「暂无应用」误导性空态
    expect(screen.queryByText(/暂无应用/)).toBeNull();

    // 复制错误信息
    fireEvent.click(screen.getByText('复制错误信息'));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalled();
      expect(writeText.mock.calls[0][0]).toContain('网关超时');
    });

    // 重试 → list 再次被调用
    fireEvent.click(screen.getByText('重试'));
    await waitFor(() => {
      expect(applicationsApi.list).toHaveBeenCalledTimes(2);
    });
  });
});
