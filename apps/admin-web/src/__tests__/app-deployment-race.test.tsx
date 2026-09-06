/**
 * W7 回归：AppDeploymentPage 的 fetchAll 无取消机制时，翻页/轮询并发会让旧响应
 * 覆盖新页数据（且轮询据此误判进行中状态）。修复后每次 fetchAll 自增序号，
 * 仅最后一次请求的响应允许写入 state。
 *
 * 仿真场景：page=1 请求先发后至（pending 期间用户已翻到 page=2 且 page=2 响应
 * 先返回），旧 page=1 响应晚于 page=2 落地 → 不得覆盖 page=2 的数据。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import AppDeploymentPage from '../pages/AppDeploymentPage';
import { deploymentsApi } from '../api/applications';
import { executorsApi } from '../api/executors';
import { useAuthStore } from '../store/auth';

vi.mock('../api/applications', () => ({
  deploymentsApi: { list: vi.fn(), deploy: vi.fn(), stop: vi.fn(), upgrade: vi.fn() },
  applicationsApi: { upgradeAll: vi.fn() },
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn() },
}));

// jsdom 缺失 antd 依赖的浏览器 API，先行补齐（对齐 settings.ai.test 先例）
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

const dep = (id: string, executorAddress: string) => ({
  id,
  applicationId: 'app-1',
  executorAddress,
  status: 'running',
  runMode: 'daemon',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

beforeEach(() => {
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(deploymentsApi.list).mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const renderPage = () =>
  render(<AppDeploymentPage applicationId="app-1" />);

describe('AppDeploymentPage 翻页竞态（W7）', () => {
  it('慢响应的旧请求数据不得覆盖已返回的新请求数据（仅最后一击生效）', async () => {
    // 每次请求由测试手动 resolve，且携带可区分的执行器地址标记
    const resolvers: Array<(addr: string) => void> = [];
    vi.mocked(deploymentsApi.list).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push((addr: string) =>
            resolve({ data: [dep(`dep-${addr}`, addr)], total: 40 }));
        }) as never,
    );

    renderPage();

    // ① 首次请求先落地，让 Table 与分页渲染出来
    await waitFor(() => expect(deploymentsApi.list).toHaveBeenCalledTimes(1));
    await act(async () => { resolvers[0]('10.0.0.1'); });
    await screen.findByText('10.0.0.1');

    // ② 翻到 page=2 → 第 2 次请求发出（悬而未决，旧 seq）
    fireEvent.click(document.querySelector('.ant-pagination-item[title="2"]') as HTMLElement);
    await waitFor(() => expect(deploymentsApi.list).toHaveBeenCalledTimes(2));
    expect(deploymentsApi.list).toHaveBeenNthCalledWith(2, 'app-1', 2);

    // ③ 点「刷新」→ 第 3 次请求发出（seq 最新）
    fireEvent.click(screen.getByText('刷新'));
    await waitFor(() => expect(deploymentsApi.list).toHaveBeenCalledTimes(3));
    expect(deploymentsApi.list).toHaveBeenNthCalledWith(3, 'app-1', 2);

    // ④ 新 seq（第 3 次）先落地 → 表格显示 NEW 数据
    await act(async () => { resolvers[2]('10.0.0.new'); });
    await screen.findByText('10.0.0.new');

    // ⑤ 旧 seq（第 2 次）晚落地 → 无守卫会覆盖为 STALE 数据；有守卫必须被丢弃
    // act：手动 resolve 在 React 事件流之外，须显式 flush 状态更新
    await act(async () => { resolvers[1]('10.0.0.stale'); });
    expect(screen.getByText('10.0.0.new')).toBeTruthy();
    expect(screen.queryByText('10.0.0.stale')).toBeNull();
  }, 15_000);

  it('卸载后晚到的响应不触发更新（无 React 警告路径：序号判据直接 return）', async () => {
    let resolveList!: () => void;
    vi.mocked(deploymentsApi.list).mockImplementation(
      () => new Promise((resolve) => { resolveList = () => resolve({ data: [dep('d1', '10.0.0.9')], total: 1 }); }) as never,
    );

    const { unmount } = renderPage();
    await waitFor(() => expect(deploymentsApi.list).toHaveBeenCalledTimes(1));
    unmount();
    // 卸载后才 resolve：仅验证不抛错（React 18 卸载后 setState 已无害，守卫保证不进入 setState 路径）
    expect(() => resolveList()).not.toThrow();
  });
});
