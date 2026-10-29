/**
 * E2（审计轮 #15）：部署页 `loading` 会被 3s 轮询「抢走序号」而永久卡住。
 *
 * 事实链：`fetchAll` 与轮询 `fetchDeployments` 共用 `fetchSeq`；
 * `fetchAll` 在 finally 里只有 `seq === fetchSeq.current` 时才 `setLoading(false)`。
 * 于是「刷新/翻页请求在飞行中，一次轮询拍自增了序号」→ 刷新请求的 finally 被
 * 判定为过期 → loading 永远为 true：表格一直转圈、行变灰不可交互，直到用户
 * 再翻一页或再触发一次刷新（而界面上没有任何提示）。
 *
 * 修法：`loading` 用**独立的 loadingSeq**（只有 fetchAll 递增），数据写入仍共用
 * fetchSeq（后发者胜）。本用例用「翻页请求挂起 + 轮询拍插进来」复现那条时序。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor, act, fireEvent, screen } from '@testing-library/react';
import AppDeploymentPage from '../pages/AppDeploymentPage';
import { deploymentsApi } from '../api/applications';
import { executorsApi } from '../api/executors';
import { useAuthStore } from '../store/auth';

vi.mock('../api/applications', () => ({
  deploymentsApi: { list: vi.fn(), deploy: vi.fn(), stop: vi.fn(), upgrade: vi.fn() },
  applicationsApi: { upgradeAll: vi.fn() },
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn(), picker: vi.fn() },
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

const deploying = {
  id: 'd1',
  applicationId: 'app-1',
  executorAddress: '10.0.0.1',
  status: 'deploying',
  runMode: 'daemon',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const realSetInterval = globalThis.setInterval;

beforeEach(() => {
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  vi.mocked(executorsApi.list).mockReset();
  vi.mocked(executorsApi.picker)
    .mockReset()
    .mockResolvedValue({ items: [], total: 0, truncated: false, limit: 2000 } as never);
  vi.mocked(deploymentsApi.list)
    .mockReset()
    .mockResolvedValue({ data: [deploying], total: 50 } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const spinner = () => document.querySelector('.ant-spin-spinning');

describe('AppDeploymentPage loading 归属（E2）', () => {
  it('翻页请求在飞行中被轮询抢序号 → loading 仍必须收起来（否则表格永久转圈）', async () => {
    const pollers: Array<() => void> = [];
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, delay?: number) => {
      if (delay === 3000) {
        pollers.push(fn);
        return 0 as never;
      }
      return realSetInterval(fn as never, delay as never) as never;
    }) as never);

    render(<AppDeploymentPage applicationId="app-1" />);
    await waitFor(() => expect(deploymentsApi.list).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(pollers.length).toBe(1));

    // 翻页请求挂起（模拟慢后端）
    let releasePage2: (v: unknown) => void = () => {};
    vi.mocked(deploymentsApi.list).mockImplementationOnce(
      () => new Promise((resolve) => { releasePage2 = resolve as (v: unknown) => void; }) as never,
    );
    fireEvent.click(screen.getByTitle('2'));
    await waitFor(() => expect(deploymentsApi.list).toHaveBeenCalledTimes(2));

    // 轮询拍插进来：自增 fetchSeq，把翻页请求判成"过期"
    await act(async () => {
      pollers[0]();
    });
    await waitFor(() => expect(deploymentsApi.list).toHaveBeenCalledTimes(3));

    // 翻页请求此刻才返回
    await act(async () => {
      releasePage2({ data: [deploying], total: 50 });
      await new Promise((r) => setTimeout(r, 150)); // 给 antd 的 Spin 两帧
    });

    expect(spinner()).toBeNull();
  });
});
