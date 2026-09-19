/**
 * NETOPT-7③ 反证回归：AppDeploymentPage 定时刷新的旧闭包 + 卸载后照发。
 *
 * 场景（复验记录）：deploy/upgrade/upgrade-all 成功后 `setTimeout(fetchAll, 1.5-2s)`
 * 持有的是动作时刻的 fetchAll 旧闭包（useCallback([applicationId, page])）。
 * 1.5-2s 窗口内翻页 → 定时器用旧 page 请求，且调用时自增 fetchSeq 使自己成为
 * 最新序号 → 旧页数据覆盖新页且分页器停在新页；若无可部署活动（3s 轮询不启动）
 * 则无人纠正。卸载后定时器照发：cleanup 里自增 fetchSeq，但 fetchAll 调用时再次
 * 自增使守卫失效 → 卸载后仍发请求并 setState。
 *
 * 修法：fetchAllRef（每渲染同步最新 fetchAll）+ timer 登记表，卸载时统一 clear。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
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

// jsdom 缺失 antd 依赖的浏览器 API，先行补齐（对齐 app-deployment-race.test 先例）
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

/** 假定时器下冲刷微任务与到期定时器（0ms 也走一遍事件循环） */
async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(deploymentsApi.upgrade).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(deploymentsApi.list).mockReset().mockImplementation(async (_appId: string, p?: number) => ({
    data: [dep(p === 2 ? 'dep-2' : 'dep-1', p === 2 ? '10.0.0.2' : '10.0.0.1')],
    total: 40,
  }) as never);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('AppDeploymentPage 定时刷新闭包与卸载（NETOPT-7③）', () => {
  it('升级后窗口内翻页：定时器触发的是最新 fetchAll（新 page），旧页数据不得回写', async () => {
    vi.useFakeTimers();
    render(<AppDeploymentPage applicationId="app-1" />);

    // 首次加载（page=1）
    await flush();
    expect(screen.getByText('10.0.0.1')).toBeTruthy();

    // 触发行内"升级"→ 2s 定时刷新登记（持有此刻 page=1 的旧闭包）。
    // 按钮可访问名带图标 aria-label 前缀（"reload 升级"），用 $ 锚定排除"升级所有"。
    fireEvent.click(screen.getByRole('button', { name: /升级$/ }));
    expect(deploymentsApi.upgrade).toHaveBeenCalledWith('dep-1');
    await flush();

    // 窗口内立即翻到 page=2 → effect 重新拉取新页
    fireEvent.click(document.querySelector('.ant-pagination-item[title="2"]') as HTMLElement);
    await flush();
    expect(deploymentsApi.list).toHaveBeenNthCalledWith(2, 'app-1', 2);
    expect(screen.getByText('10.0.0.2')).toBeTruthy();

    // 2s 到期：修复前旧闭包 fetchAll 以 page=1 重发并自增 seq 成为最新 → 旧页回写
    await flush(2000);

    // 定时器触发的请求必须用最新 page；表格行集对应新页
    expect(deploymentsApi.list).toHaveBeenLastCalledWith('app-1', 2);
    expect(screen.getByText('10.0.0.2')).toBeTruthy();
    expect(screen.queryByText('10.0.0.1')).toBeNull();
  }, 15_000);

  it('卸载后定时刷新不再发请求', async () => {
    vi.useFakeTimers();
    const { unmount } = render(<AppDeploymentPage applicationId="app-1" />);
    await flush();
    expect(deploymentsApi.list).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /升级$/ }));
    await flush();
    expect(deploymentsApi.list).toHaveBeenCalledTimes(1); // 定时器未到期

    unmount();
    await flush(5000); // 越过定时器到期点

    // 修复前：定时器照发 → fetchAll 调用时再次自增 seq 使守卫失效 → 卸载后仍发请求
    expect(deploymentsApi.list).toHaveBeenCalledTimes(1);
  }, 15_000);
});
