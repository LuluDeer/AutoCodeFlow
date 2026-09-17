/**
 * Executor Lifecycle Audit 回归守卫（本轮审计落地修复的反证测试）：
 *
 *  P2-5 心跳阈值同源：heartbeatFreshness / isHeartbeatStale 单测 +
 *       列表页确实消费 GET /executors/runtime-config 的有效判死阈值，
 *       后端阈值变小时不得再把陈旧心跳画成绿色「刚刚」；
 *  P3-9 截断提示：executorTotal > listLimit 时必须显式告知只显示了子集；
 *  P3-11 分组加载失败：筛选器不得静默消失，原位给错误入口与重试；
 *  P2-6 interpreters 三态：未上报 / 空池 / 版本清单（含 available:false）。
 *
 * 反证写法（对齐 executor-packages-error-state.test.tsx 的教训：mock 比
 * 真 API 慷慨就会替 bug 作证）——每个用例都注明"把修复改回旧实现时哪一行
 * 断言会转红"。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import {
  heartbeatFreshness,
  isHeartbeatStale,
  HEARTBEAT_TIMEOUT_FALLBACK_MS,
} from '../utils/executorLiveness';
import ExecutorListPage from '../pages/ExecutorListPage';
import ExecutorDetailPage from '../pages/ExecutorDetailPage';
import { executorsApi } from '../api/executors';
import { client } from '../api/client';
import { useAuthStore } from '../store/auth';
import type { Executor, ExecutorRuntimeConfig } from '../api/executors';

vi.mock('../api/executors', () => ({
  executorsApi: {
    list: vi.fn(),
    getGroups: vi.fn(),
    get: vi.fn(),
    getMetrics: vi.fn(),
    getExecutions: vi.fn(),
    getRuntimeConfig: vi.fn(),
  },
}));
const mockedApi = vi.mocked(executorsApi, true);

vi.mock('../api/client', () => ({
  client: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
const mockedClient = vi.mocked(client, true);

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

const runtimeCfg = (over: Partial<ExecutorRuntimeConfig> = {}): ExecutorRuntimeConfig => ({
  heartbeatIntervalMs: 30_000,
  heartbeatTimeoutMultiplier: 3,
  heartbeatTimeoutMs: 90_000,
  listLimit: 500,
  executorTotal: 0,
  ...over,
});

const NOW = Date.now();
const makeExecutor = (over: Partial<Executor>): Executor => ({
  id: 'ex-1',
  appName: 'alpha',
  address: '10.0.0.1:3002',
  status: 'online',
  cpuUsage: 30,
  memUsage: 50,
  runningTaskCount: 1,
  lastHeartbeat: new Date(NOW - 10_000).toISOString(),
  ...over,
});

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/executors']}>
        <Routes>
          <Route path="/executors" element={<ExecutorListPage />} />
          <Route path="/executors/:id" element={<div>executor-detail-mock</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderDetail() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/executors/executor-1']}>
        <Routes>
          <Route path="/executors/:id" element={<ExecutorDetailPage />} />
          <Route path="/executors" element={<div>executor-list-mock</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  mockedApi.getRuntimeConfig.mockResolvedValue(runtimeCfg());
});

afterEach(() => {
  cleanup();
});

// ─────────────────────────────────────────────────────────────────────────
// P2-5：共享判活口径（纯函数）
// ─────────────────────────────────────────────────────────────────────────
describe('P2-5 executorLiveness 与后端判死阈值同源', () => {
  it('回退常量等于后端默认 30s × 3 = 90s', () => {
    expect(HEARTBEAT_TIMEOUT_FALLBACK_MS).toBe(90_000);
  });

  it('判死窗口内 fresh；超过阈值但不到 10 分钟 recent；更久 old', () => {
    expect(heartbeatFreshness(10_000, 90_000)).toBe('fresh');
    expect(heartbeatFreshness(89_999, 90_000)).toBe('fresh');
    // 旧实现绿色边界硬编码 2 分钟：100s 仍被画成「刚刚」。
    // 后端 90s 已判死——这里必须是 recent。
    expect(heartbeatFreshness(100_000, 90_000)).toBe('recent');
    expect(heartbeatFreshness(9 * 60_000, 90_000)).toBe('recent');
    expect(heartbeatFreshness(11 * 60_000, 90_000)).toBe('old');
  });

  it('阈值跟随配置：阈值被调小时新鲜窗口同步收窄', () => {
    // 15s 的心跳在默认 90s 阈值下是 fresh，在 10s 阈值下必须变 recent——
    // 列表页用例正是通过 runtime-config 驱动这一变化。
    expect(heartbeatFreshness(15_000, 90_000)).toBe('fresh');
    expect(heartbeatFreshness(15_000, 10_000)).toBe('recent');
  });

  it('isHeartbeatStale 严格按传入阈值判定（严格大于）', () => {
    // now - last = 95s > 90s → 陈旧；80s → 未陈旧；恰好 90s（边界）不判陈旧。
    expect(isHeartbeatStale(100_000, 195_000, 90_000)).toBe(true);
    expect(isHeartbeatStale(100_000, 190_000, 90_000)).toBe(false);
    expect(isHeartbeatStale(100_000, 180_000, 90_000)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// P2-5：列表页消费 runtime-config（集成）
// ─────────────────────────────────────────────────────────────────────────
describe('P2-5 ExecutorListPage 心跳着色跟随后端阈值', () => {
  it('runtime-config 给 10s 阈值时，15s 前的心跳不得显示绿色「刚刚」', async () => {
    // 反证：把页面里的 heartbeatTimeoutMs 改回硬编码 2/5 分钟，
    // 15s 心跳必然是「刚刚」，本用例转红。
    mockedApi.getRuntimeConfig.mockResolvedValue(
      runtimeCfg({ heartbeatTimeoutMs: 10_000 }),
    );
    mockedApi.list.mockResolvedValue([
      makeExecutor({ lastHeartbeat: new Date(NOW - 15_000).toISOString() }),
    ]);
    mockedApi.getGroups.mockResolvedValue([]);
    renderList();

    await screen.findByText('alpha');
    await waitFor(() => {
      expect(screen.queryByText('刚刚')).toBeNull();
    });
  });

  it('runtime-config 不可用时回退 90s：15s 前的心跳仍是「刚刚」（保守回退不涂绿离线机）', async () => {
    mockedApi.getRuntimeConfig.mockRejectedValue(new Error('config 500'));
    mockedApi.list.mockResolvedValue([
      makeExecutor({ lastHeartbeat: new Date(NOW - 15_000).toISOString() }),
    ]);
    mockedApi.getGroups.mockResolvedValue([]);
    renderList();

    expect(await screen.findByText('刚刚')).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// P3-9：take:500 截断必须显式提示
// ─────────────────────────────────────────────────────────────────────────
describe('P3-9 ExecutorListPage 截断提示', () => {
  it('executorTotal > listLimit 时显示截断 Alert，并带出 total/limit', async () => {
    // 反证：删掉 listTruncated Alert，本用例转红——旧实现把前 500 行
    // 的计数/搜索说成全量，且无任何"仅显示子集"指示。
    mockedApi.getRuntimeConfig.mockResolvedValue(
      runtimeCfg({ listLimit: 500, executorTotal: 501 }),
    );
    mockedApi.list.mockResolvedValue([makeExecutor({})]);
    mockedApi.getGroups.mockResolvedValue([]);
    renderList();

    const alert = await screen.findByText(/列表仅显示最近的/);
    expect(alert.textContent).toContain('501');
    expect(alert.textContent).toContain('500');
  });

  it('未超上限时不显示截断 Alert', async () => {
    mockedApi.getRuntimeConfig.mockResolvedValue(
      runtimeCfg({ listLimit: 500, executorTotal: 12 }),
    );
    mockedApi.list.mockResolvedValue([makeExecutor({})]);
    mockedApi.getGroups.mockResolvedValue([]);
    renderList();

    await screen.findByText('alpha');
    expect(screen.queryByText(/列表仅显示最近的/)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// P3-11：分组筛选加载失败不再静默消失
// ─────────────────────────────────────────────────────────────────────────
describe('P3-11 ExecutorListPage 分组加载失败态', () => {
  it('getGroups 失败 → 原位显示「分组加载失败」重试按钮，不渲染空 Select', async () => {
    // 反证：改回 `const { data: groups } = useExecutorGroups()` 且错误时
    // 整块 Select 不渲染，「分组加载失败」按钮永远不会出现，用例转红。
    mockedApi.getRuntimeConfig.mockResolvedValue(runtimeCfg());
    mockedApi.list.mockResolvedValue([makeExecutor({})]);
    mockedApi.getGroups.mockRejectedValue(new Error('groups 500'));
    renderList();

    await screen.findByText('alpha');
    const retryBtn = await screen.findByRole('button', { name: /分组加载失败/ });
    expect(retryBtn).toBeTruthy();
    expect(screen.queryByText('全部分组')).toBeNull();
  });

  it('点击重试成功后恢复分组筛选 Select', async () => {
    mockedApi.getRuntimeConfig.mockResolvedValue(runtimeCfg());
    mockedApi.list.mockResolvedValue([makeExecutor({})]);
    mockedApi.getGroups
      .mockRejectedValueOnce(new Error('groups 500'))
      .mockResolvedValueOnce(['生产组']);
    renderList();

    await screen.findByText('alpha');
    const retryBtn = await screen.findByRole('button', { name: /分组加载失败/ });
    fireEvent.click(retryBtn);

    await waitFor(() => expect(mockedApi.getGroups).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('全部分组')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /分组加载失败/ })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// P2-6：interpreters 三态展示
// ─────────────────────────────────────────────────────────────────────────
describe('P2-6 ExecutorDetailPage 解释器池三态', () => {
  const FIELD_LABEL = 'Python 解释器池（活性上报 · 进页快照）';

  const emptyMetrics = {
    executor: { id: 'executor-1', address: '10.0.0.9:3002', status: 'online' },
    sevenDayStats: {
      totalExecutions: 0, successful: 0, failed: 0, successRate: 0, averageDurationMs: 0,
    },
    current: { runningTaskCount: 0 },
    history: [],
  };

  /**
   * 页面里多个字段（标签/运行中任务等）未上报时都显示「未上报」，且 antd
   * Descriptions 一行放多个 item——断言必须精确到本字段的 content 容器
   * （非 bordered 布局下 label/content 是同一 item 容器内的两个相邻 span）。
   */
  async function interpretersCell() {
    const label = await screen.findByText(FIELD_LABEL);
    const labelSpan = label.closest('.ant-descriptions-item-label') as HTMLElement | null;
    expect(labelSpan).toBeTruthy();
    const contentSpan = labelSpan!.parentElement!.querySelector(
      '.ant-descriptions-item-content',
    ) as HTMLElement | null;
    expect(contentSpan).toBeTruthy();
    return within(contentSpan as HTMLElement);
  }

  beforeEach(() => {
    mockedApi.getMetrics.mockResolvedValue(emptyMetrics);
    mockedApi.getExecutions.mockResolvedValue({ total: 0, items: [] });
    mockedApi.getRuntimeConfig.mockResolvedValue(runtimeCfg());
  });

  it('未上报（null）→ 显示「未上报」', async () => {
    // 反证：删掉整个 interpreters Descriptions.Item（修复前状态），
    // 下面三态的任何文本都不会出现在该行。
    mockedApi.get.mockResolvedValue(
      makeExecutor({ id: 'executor-1', interpreters: null }),
    );
    renderDetail();
    const row = await interpretersCell();
    expect(row.getByText('未上报')).toBeTruthy();
    expect(row.queryByText(/池内无可用版本/)).toBeNull();
    expect(row.queryByText(/Python 3\./)).toBeNull();
  });

  it('已上报但空池（[]）→ 橙色「池内无可用版本」警告', async () => {
    mockedApi.get.mockResolvedValue(
      makeExecutor({ id: 'executor-1', interpreters: [] }),
    );
    renderDetail();
    const row = await interpretersCell();
    expect(row.getByText('池内无可用版本')).toBeTruthy();
    expect(row.queryByText('未上报')).toBeNull();
  });

  it('非空清单 → 渲染版本 Tag；available:false 的版本划线保留可见', async () => {
    mockedApi.get.mockResolvedValue(
      makeExecutor({
        id: 'executor-1',
        interpreters: [
          { version: '3.11.13', path: '/usr/bin/python3.11', available: true },
          { version: '3.12.1', path: '/opt/python3.12', available: false, discoveredAt: '2026-09-01T00:00:00.000Z' },
        ],
      }),
    );
    renderDetail();
    const row = await interpretersCell();

    const tag311 = row.getByText('Python 3.11.13');
    const tag312 = row.getByText('Python 3.12.1');
    expect(tag311).toBeTruthy();
    expect(tag312).toBeTruthy();
    // 不可用版本不是被过滤掉，而是划线 + 橙色保留——运维需要知道"探测过但坏了"。
    expect((tag312 as HTMLElement).style.textDecoration).toContain('line-through');
    expect(row.queryByText('未上报')).toBeNull();
    expect(row.queryByText(/池内无可用版本/)).toBeNull();
  });
});

// client 在本文件仅为页面导入依赖（install-cmd 走裸 client.get），保持引用
void mockedClient;
