/**
 * P1-24 / P1-28 / 补充 P2（UX-AUDIT-2026-09-21，Shard C）：执行器详情页诊断面。
 *
 * ## 旧实现怎么错（红）
 *  - P1-24：离线 Alert 只有一句通用文案，判死阈值 heartbeatTimeoutMs 取到手后
 *    只用于染色、数值从不渲染，也没有最后心跳绝对时刻 / 已静默时长——用户回答不了
 *    "为什么离线、静默了多久"。
 *  - P1-28：状态 Badge `text={executor.status}` 直接渲染裸枚举（online/offline），
 *    与列表页（execList.status.online=在线）同一概念两种措辞。
 *  - 补充 P2：当前运行 Progress `showInfo={false}` 连百分比都不显示，满载时也没有
 *    "不再派发" 的语义——用户分不清"这台已饱和"与"没有可用执行器"。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ExecutorDetailPage from '../pages/ExecutorDetailPage';
import { executorsApi } from '../api/executors';
import { useAuthStore } from '../store/auth';

vi.mock('../api/executors', () => ({
  executorsApi: {
    get: vi.fn(),
    getMetrics: vi.fn(),
    getExecutions: vi.fn(),
    getRuntimeConfig: vi.fn(),
  },
}));
const mockedApi = vi.mocked(executorsApi, true);

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
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const OLD_HEARTBEAT = new Date(Date.now() - 20 * 60_000).toISOString();

function renderPage(executor: Record<string, unknown>, runningTaskCount: number) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockedApi.get.mockResolvedValue(executor as never);
  mockedApi.getMetrics.mockResolvedValue({
    executor: { id: 'e1', address: '10.0.0.9', status: executor.status as string },
    sevenDayStats: { totalExecutions: 0, successful: 0, failed: 0, successRate: 0, averageDurationMs: 0 },
    current: { runningTaskCount },
    history: [],
  });
  mockedApi.getExecutions.mockResolvedValue({ total: 0, items: [] } as never);
  mockedApi.getRuntimeConfig.mockResolvedValue({ heartbeatTimeoutMs: 90_000 } as never);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/executors/e1']}>
        <Routes>
          <Route path="/executors/:id" element={<ExecutorDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
});
afterEach(() => cleanup());

describe('P1-28: 详情页状态不再渲染裸枚举', () => {
  it('离线执行器状态 Badge 显示中文「离线」，而非裸枚举 offline', async () => {
    renderPage({
      id: 'e1', appName: 'node-1', address: '10.0.0.9:3002',
      status: 'offline', lastHeartbeat: OLD_HEARTBEAT, maxConcurrentTasks: 4, runningTaskCount: 0,
    }, 0);
    await screen.findAllByText('node-1');
    // 旧实现 text={executor.status} → 渲染 "offline"；现复用列表页 i18n 键。
    expect(screen.getByText('离线')).toBeTruthy();
    expect(screen.queryByText(/^offline$/)).toBeNull();
  });
});

describe('P1-24: 离线 Alert 必须可回答「为什么离线」', () => {
  it('离线 Alert 带上判死阈值（秒）与最后心跳时刻，不再只有通用文案', async () => {
    renderPage({
      id: 'e1', appName: 'node-1', address: '10.0.0.9:3002',
      status: 'offline', lastHeartbeat: OLD_HEARTBEAT, maxConcurrentTasks: 4, runningTaskCount: 0,
    }, 0);
    await screen.findAllByText('node-1');
    // 阈值：runtime-config 返回 90000ms → "90 秒"；在离线 Alert（role=alert）内断言，
    // 避免与信息卡里的心跳字段标签撞文案。
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/判死阈值/);
    expect(alert.textContent).toMatch(/90\s*秒/);
    // 最后心跳绝对时刻 + 已静默时长（旧实现两者都不渲染）
    expect(alert.textContent).toMatch(/最后心跳/);
  });
});

describe('补充 P2: 满载「已饱和」语义', () => {
  it('runningCount 达到并发上限时显示「已满载」提示；进度条展示百分比', async () => {
    renderPage({
      id: 'e1', appName: 'node-1', address: '10.0.0.9:3002',
      status: 'online', lastHeartbeat: new Date().toISOString(),
      maxConcurrentTasks: 4, runningTaskCount: 4,
    }, 4);
    await screen.findAllByText('node-1');
    // 旧实现：showInfo={false} 不显示百分比、且无满载文案。
    // 核心回归：满载时出现「已满载」提示（源码侧已移除 showInfo={false}，进度条展示百分比）。
    expect(screen.getByText(/已满载/)).toBeTruthy();
  });

  it('未满载时不渲染「已满载」提示', async () => {
    renderPage({
      id: 'e1', appName: 'node-1', address: '10.0.0.9:3002',
      status: 'online', lastHeartbeat: new Date().toISOString(),
      maxConcurrentTasks: 4, runningTaskCount: 1,
    }, 1);
    await screen.findAllByText('node-1');
    expect(screen.queryByText(/已满载/)).toBeNull();
  });
});
