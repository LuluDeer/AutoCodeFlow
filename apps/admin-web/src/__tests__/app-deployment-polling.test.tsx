/**
 * F-34（DEEP_REVIEW 0ef3bbe）回归：AppDeploymentPage 的 3s 轮询
 *  ① 标签页不可见时跳过本拍请求（对齐 ExecutionsPage 15s 兜底轮询的
 *     document.visibilityState 守卫，定时器保留、回前台下一拍恢复）；
 *  ② 轮询拍只拉**部署列表**，不再每拍全量 GET /executors（执行器清单在
 *     秒级窗口内几乎不变）。
 * 采用「捕获 3000ms 定时器回调后手动触发」的方式，避免假定时器与 antd 渲染互扰。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor, act } from '@testing-library/react';
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

const inProgressDeployment = {
  id: 'd1',
  applicationId: 'app-1',
  executorAddress: '10.0.0.1',
  status: 'deploying',
  runMode: 'daemon',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

/** 真实 setInterval（截获 3s 轮询定时器时用于放行其它调用） */
const realSetInterval = globalThis.setInterval;

beforeEach(() => {
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(deploymentsApi.list)
    .mockReset()
    .mockResolvedValue({ data: [inProgressDeployment], total: 1 } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // 还原实例上的 visibilityState 覆写（jsdom 原型 getter 仍在）
  delete (document as unknown as Record<string, unknown>).visibilityState;
});

describe('F-34 部署页轮询守卫', () => {
  it('隐藏标签页跳过本拍；可见时只拉部署列表，不重复拉执行器清单', async () => {
    const pollers: Array<() => void> = [];
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      fn: () => void,
      delay?: number,
    ) => {
      // 只截获轮询定时器（3s）；其余（RTL waitFor 等）交回真实实现
      if (delay === 3000) {
        pollers.push(fn);
        return 0 as never;
      }
      return realSetInterval(fn as never, delay as never) as never;
    }) as never);

    render(<AppDeploymentPage applicationId="app-1" />);

    // 首屏 fetchAll：部署列表 + 执行器清单各 1 次
    await waitFor(() => expect(deploymentsApi.list).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(executorsApi.list).toHaveBeenCalledTimes(1));
    // 行状态为 deploying → 起 3s 轮询
    await waitFor(() => expect(pollers.length).toBe(1));

    // ① 页面隐藏：本拍不发请求
    setVisibility('hidden');
    await act(async () => {
      pollers[0]();
    });
    expect(deploymentsApi.list).toHaveBeenCalledTimes(1);
    expect(executorsApi.list).toHaveBeenCalledTimes(1);

    // ② 回到可见：只补拉部署列表（执行器清单不再每拍全量拉取）
    setVisibility('visible');
    await act(async () => {
      pollers[0]();
    });
    await waitFor(() => expect(deploymentsApi.list).toHaveBeenCalledTimes(2));
    expect(executorsApi.list).toHaveBeenCalledTimes(1);
  });

  it('无进行中部署时不建立轮询', async () => {
    vi.mocked(deploymentsApi.list).mockReset().mockResolvedValue({
      data: [{ ...inProgressDeployment, status: 'running' }],
      total: 1,
    } as never);
    const pollers: Array<() => void> = [];
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      fn: () => void,
      delay?: number,
    ) => {
      // 只截获轮询定时器（3s）；其余（RTL waitFor 等）交回真实实现
      if (delay === 3000) {
        pollers.push(fn);
        return 0 as never;
      }
      return realSetInterval(fn as never, delay as never) as never;
    }) as never);

    render(<AppDeploymentPage applicationId="app-1" />);
    await waitFor(() => expect(deploymentsApi.list).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(pollers.length).toBe(0);
  });
});
