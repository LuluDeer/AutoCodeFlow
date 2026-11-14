/**
 * ApplicationListPage 错误态接入回归。
 *
 * ① UI-08：applicationsApi.list reject 时，页内渲染 StateError 标准错误块
 *    （重试+复制错误信息），表格不再显示误导性空态文案。主列表自身失败必须
 *    保持真正的整页错误态。
 *
 * ② P1-8（2026-11-15 评审）：辅助统计 GET /app-deployments/stats 单独 reject
 *    时，**主列表照常渲染**，不得进整页错误态；统计列显示「暂不可用」并提供
 *    只重拉 stats 的单次重试；原始 URL/技术串收进折叠的技术详情（P3-06 同源）。
 *    反证：不得用 0 / 「暂无部署」占位伪装统计成功。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ApplicationListPage from '../pages/ApplicationListPage';
import { applicationsApi, deploymentsApi } from '../api/applications';
import { executorsApi } from '../api/executors';
import { useAuthStore } from '../store/auth';

vi.mock('../api/applications', () => ({
  applicationsApi: { list: vi.fn(), delete: vi.fn(), create: vi.fn(), update: vi.fn(), upload: vi.fn() },
  deploymentsApi: { list: vi.fn(), stats: vi.fn().mockResolvedValue([]), deploy: vi.fn() },
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn(), picker: vi.fn() },
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
  // 默认 stats 成功（无部署行）；失败路径由对应用例覆盖。
  vi.mocked(deploymentsApi.stats).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.picker).mockReset().mockResolvedValue({ items: [], total: 0, truncated: false, limit: 2000 } as never);
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
    fireEvent.click(screen.getByText(/复制错误信息/));
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

describe('P1-8：辅助统计失败不拖垮主列表', () => {
  const APP = { id: 'app-1', name: '订单同步', version: '1.0.0', runtime: 'node' };

  it('stats reject → 列表照常渲染，统计列显示「暂不可用」，不出现整页错误态与 0 占位', async () => {
    vi.mocked(applicationsApi.list).mockResolvedValue([APP] as never);
    // 夹具/后端 reject 形态：envelope 对象（拦截器在上面挂 __status）
    vi.mocked(deploymentsApi.stats).mockReset().mockRejectedValue({
      __status: 404,
      message: 'fixture missing: GET /app-deployments/stats',
    });

    render(
      <MemoryRouter>
        <ApplicationListPage />
      </MemoryRouter>,
    );

    // 主列表行照常渲染
    expect(await screen.findByText('订单同步')).toBeTruthy();

    // 反证：没有进入整页 StateError 错误态
    expect(screen.queryByTestId('state-error')).toBeNull();

    // 降级 Banner：用户可读摘要在主文案
    expect(screen.getByText('辅助统计暂不可用，应用列表仍可正常使用')).toBeTruthy();

    // 实例数 / 最后部署两列都显示「暂不可用」，不谎报「暂无部署 / 0 台」
    const unavailable = screen.getAllByText('暂不可用');
    expect(unavailable.length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('暂无部署')).toBeNull();
    expect(screen.queryByText(/台运行中/)).toBeNull();

    // 技术详情默认折叠：原始 URL/技术串不在主视图
    expect(screen.queryByText(/app-deployments\/stats/)).toBeNull();
  });

  it('技术详情可展开查看原始串，重试只重拉 stats，成功后统计恢复、Banner 消失', async () => {
    vi.mocked(applicationsApi.list).mockResolvedValue([APP] as never);
    vi.mocked(deploymentsApi.stats)
      .mockRejectedValueOnce({
        __status: 404,
        message: 'fixture missing: GET /app-deployments/stats',
      })
      .mockResolvedValueOnce([
        { applicationId: 'app-1', total: 2, running: 2, failed: 0, lastDeployedAt: new Date().toISOString() },
      ] as never);

    render(
      <MemoryRouter>
        <ApplicationListPage />
      </MemoryRouter>,
    );

    await screen.findByText('订单同步');
    expect(screen.getByText('辅助统计暂不可用，应用列表仍可正常使用')).toBeTruthy();

    // 展开技术详情 → 原始状态/URL/消息可见（P3-06 两级错误）
    fireEvent.click(screen.getByText('查看技术详情'));
    await waitFor(() => {
      expect(screen.getByText(/app-deployments\/stats/)).toBeTruthy();
    });
    expect(screen.getByText(/HTTP 404/)).toBeTruthy();

    // 重试只发 stats 请求，不重拉主列表
    fireEvent.click(screen.getByText('重试统计'));
    await waitFor(() => {
      expect(deploymentsApi.stats).toHaveBeenCalledTimes(2);
    });
    expect(applicationsApi.list).toHaveBeenCalledTimes(1);

    // 统计恢复：实例数如实显示 2 / 2 运行中，Banner 与「暂不可用」消失
    await waitFor(() => {
      expect(screen.getByText('2 / 2 台运行中')).toBeTruthy();
    });
    expect(screen.queryByText('辅助统计暂不可用，应用列表仍可正常使用')).toBeNull();
    expect(screen.queryByText('暂不可用')).toBeNull();
  });
});
