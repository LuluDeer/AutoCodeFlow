/**
 * R285 回归：执行器详情页「性能统计（近7天）」计数行必须**分别列出超时**。
 *
 * ## 缺陷（本文件锁死的那条）
 *
 * 展示口径曾经是 `成功 X / 失败 Y / 其他 Z`，其中 `Z = total − succ − failed`。
 * 而后端 7 日统计只数 `FAILED` 桶 ⇒ 10 条 timeout、0 条 failed 时面板显示
 * 「成功 0 / 失败 0 / **其他 10**」——「其他」把「全是超时」这个**事实**藏了
 * 起来，运维只能猜是 killed/cancelled 还是数据异常（R280「同一语义落两个字段值」
 * 的镜像：`TIMEOUT` 有桶，面板却只列 `failed`）。
 *
 * ## 判据（四态成对咬，外加一条反证见 brief ⑤）
 *
 * 1. `timedOut = 10` ⇒ 渲染「… / 超时 10 / 其他 0」；
 * 2. `timedOut` **缺失**（旧后端 / 部署未升级的接口缓存里没有这个键）⇒ **退回旧
 *    文案**，且统计卡内**不得出现「超时」字样**——「超时 0」是凭空断言出来的事实
 *    （同 R278 纪律：`null ≠ 0`，缺失 ≠ 0）；
 * 3. `timedOut = 0`（**明确为 0**，全成功场景）⇒ 照实渲染「超时 0」——0 是事实，
 *    与「缺失」必须可区分，故实现判据是 `typeof === 'number'`，不是 truthiness，
 *    也不是 `?? 0`；
 * 4. 「其他」在**两态下都 clamp ≥ 0**：`totalExecutions` 不过滤状态、含未终态行，
 *    非原子快照下 `total < succ + failed (+ timedOut)` 可达，界面不得显示负数。
 *
 * 断言落点：统计卡（`性能统计（近7天）` 的 `.ant-card`）。刻意不进全页文本匹配——
 * 详情页配置卡另有「任务超时(秒)」「离线原因：心跳超时…」等文案，全页匹配的
 * 「不出现超时」会被无关文案污染成假绿。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ExecutorDetailPage from '../pages/ExecutorDetailPage';
import { executorsApi, type ExecutorMetrics } from '../api/executors';
import { useAuthStore } from '../store/auth';

// R279：mock 必须保留契约层的**真实纯函数**（describeOfflineWindow /
// resolveEffectiveOfflineAfterMs）。整模块替换会把它抹成 undefined，页面崩在
// 「No export」，那是 mock 失真而不是实现坏了；这里只替 executorsApi。
vi.mock('../api/executors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/executors')>();
  return {
    ...actual,
    executorsApi: {
      get: vi.fn(),
      getMetrics: vi.fn(),
      getExecutions: vi.fn(),
    },
  };
});
const mockedApi = vi.mocked(executorsApi, true);

// jsdom 缺失 antd 依赖的浏览器 API（既有先例 shim）
const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const executorFixture = {
  id: 'executor-1',
  appName: 'demo-executor',
  address: '10.0.0.9:3002',
  status: 'online',
  cpuUsage: 12.5,
  memUsage: 40.1,
  runningTaskCount: 0,
  lastHeartbeat: new Date().toISOString(),
};

/**
 * 构造 metrics 响应。`timedOut` 由调用方决定**是否出现**：
 * 不传 ⇒ 响应里没有这个键（模拟旧后端 / 旧缓存），传 `0` ⇒ 键存在且为 0。
 * 两者在 JSON 层是可区分的，消费方必须也区分。
 */
function metricsFixture(sevenDayStats: Partial<ExecutorMetrics['sevenDayStats']>): ExecutorMetrics {
  return {
    executor: { id: 'executor-1', address: '10.0.0.9:3002', status: 'online' },
    sevenDayStats: {
      totalExecutions: 0,
      successful: 0,
      failed: 0,
      successRate: 0,
      averageDurationMs: 0,
      ...sevenDayStats,
    },
    current: { runningTaskCount: 0, cpuUsage: 5, memUsage: 10 },
    history: [],
  };
}

function renderPage() {
  // 必须挂 Route 才能让 useParams 拿到 :id（否则 ready=false 永不发请求）
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/executors/executor-1']}>
        <Routes>
          <Route path="/executors/:id" element={<ExecutorDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 统计卡的 textContent（只在这个作用域内断言「超时」出现/缺席） */
async function statsCardText(): Promise<string> {
  const title = await screen.findByText('性能统计（近7天）');
  const card = title.closest('.ant-card');
  if (!card) throw new Error('统计卡节点缺失：卡片标题的 .ant-card 祖先没找到');
  return card.textContent ?? '';
}

describe('ExecutorDetailPage — 7 日统计计数行分别列出超时（R285）', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
    mockedApi.get.mockResolvedValue(executorFixture);
    // 执行记录表：空列表即可，不参与本组断言
    mockedApi.getExecutions.mockResolvedValue({ total: 0, items: [] });
  });

  it('① timedOut=10（全是超时）：渲染「超时 10」且「其他 0」，不再藏进其他', async () => {
    mockedApi.getMetrics.mockResolvedValue(
      metricsFixture({ totalExecutions: 10, successful: 0, failed: 0, timedOut: 10 }),
    );
    renderPage();

    const card = await statsCardText();
    expect(card).toContain('成功 0 / 失败 0 / 超时 10 / 其他 0');
  });

  it('② timedOut 缺失（旧后端/旧缓存）：退回旧文案，统计卡内不出现「超时」', async () => {
    mockedApi.getMetrics.mockResolvedValue(
      metricsFixture({ totalExecutions: 10, successful: 0, failed: 0 }),
    );
    renderPage();

    const card = await statsCardText();
    // 旧文案原样：10 条全落在「其他」——这正是旧行为的诚实还原
    expect(card).toContain('成功 0 / 失败 0 / 其他 10');
    // 缺失 ≠ 0：不得凭空渲染「超时 0」（那是假事实）
    expect(card).not.toContain('超时');
  });

  it('③ timedOut=0（明确为 0）：照实渲染「超时 0」，与「缺失」可区分', async () => {
    mockedApi.getMetrics.mockResolvedValue(
      metricsFixture({ totalExecutions: 42, successful: 40, failed: 2, timedOut: 0 }),
    );
    renderPage();

    const card = await statsCardText();
    expect(card).toContain('成功 40 / 失败 2 / 超时 0 / 其他 0');
  });

  it('④ 异常数据（total < 各项之和）：「其他」两态下都 clamp ≥ 0，不显示负数', async () => {
    // 新后端形态：total 2 < succ 5 + failed 1 + timedOut 1 = 7
    mockedApi.getMetrics.mockResolvedValue(
      metricsFixture({ totalExecutions: 2, successful: 5, failed: 1, timedOut: 1 }),
    );
    renderPage();
    expect(await statsCardText()).toContain('成功 5 / 失败 1 / 超时 1 / 其他 0');
    cleanup();

    // 旧后端形态：total 2 < succ 5 + failed 1 = 6
    mockedApi.getMetrics.mockResolvedValue(
      metricsFixture({ totalExecutions: 2, successful: 5, failed: 1 }),
    );
    renderPage();
    const card = await statsCardText();
    expect(card).toContain('成功 5 / 失败 1 / 其他 0');
    expect(card).not.toContain('其他 -');
  });
});