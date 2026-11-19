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

// R279：mock 必须保留契约层的**真实纯函数**（resolveEffectiveOfflineAfterMs /
// describeOfflineWindow）。整模块替换会把它抹成 undefined，页面直接崩在「No export」，
// 那是 mock 失真而不是实现坏了；这里只替 executorsApi，纯函数走真实现。
vi.mock('../api/executors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/executors')>();
  return {
    ...actual,
    executorsApi: {
      get: vi.fn(),
      getMetrics: vi.fn(),
      getExecutions: vi.fn(),
      getRuntimeConfig: vi.fn(),
    },
  };
});
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
  // R279：夹具照**真机** GET /executors/runtime-config 的响应造
  // （127.0.0.1:3106 实测：heartbeatTimeoutMs=90000、staleOfflineConfirmations=2、
  // effectiveOfflineAfterMs=180000）。旧夹具只喂 heartbeatTimeoutMs=90000，
  // 等于替后端编了一个「单轮判死」的响应，把错误 UI 钉成了期望。
  mockedApi.getRuntimeConfig.mockResolvedValue({
    heartbeatIntervalMs: 30_000,
    heartbeatTimeoutMultiplier: 3,
    heartbeatTimeoutMs: 90_000,
    staleOfflineConfirmations: 2,
    effectiveOfflineAfterMs: 180_000,
    listLimit: 500,
    executorTotal: 1,
  } as never);
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

describe('P1-24 / R279: 离线 Alert 必须可回答「为什么离线、多久判死」', () => {
  it('离线 Alert 渲染**真实判死窗口** 180 秒（而非单次墙钟 90 秒）+ 迟滞成因 + 最后心跳时刻', async () => {
    renderPage({
      id: 'e1', appName: 'node-1', address: '10.0.0.9:3002',
      status: 'offline', lastHeartbeat: OLD_HEARTBEAT, maxConcurrentTasks: 4, runningTaskCount: 0,
    }, 0);
    await screen.findAllByText('node-1');
    // 在离线 Alert（role=alert）内断言，避免与信息卡里的心跳字段标签撞文案。
    const alert = screen.getByRole('alert');
    // R279：旧期望 = 「90 秒」，那是拿单次墙钟当判死窗口，掩盖了 180 秒的真实窗口。
    // 真机 effectiveOfflineAfterMs=180000 ⇒ 必须渲染 180 秒。
    expect(alert.textContent).toMatch(/判死窗口[：:]\s*连续\s*180\s*秒/);
    // 迟滞成因必须摆在页面上（否则运维会问「为什么不是 90」）：连续 2 次未确认。
    expect(alert.textContent).toMatch(/连续\s*2\s*次扫描仍未确认/);
    // 单次墙钟仍然出现（作为对照说明），但**不**再承担「多久判离线」的语义。
    expect(alert.textContent).toMatch(/单次心跳墙钟为\s*90\s*秒/);
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
