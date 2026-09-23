/**
 * E-01-RPT（生产实证：RPA5 执行器在中台恒显「当前运行任务 1/10」「活性上报 0
 * 条，与运行计数 1 不一致」，而该执行器所在设备上并没有在执行的任务）。
 *
 * 根因（代码层实证，非猜测）：
 * - E-01 防超卖机制要求 pull 循环在发起 25s 长轮询**之前**先原子预留一个容量
 *   槽位（executor-node `pull.ts` 的 `Atomics.add` / executor-python
 *   `try_reserve_running_slot`），预留计入**同一个并发账本**——所以
 *   `runningTaskCount` 在长轮询窗口内**诚实包含**该预留。这正是「长轮询窗口内
 *   中台不会再往最后一个空槽 push 派发」的实现方式本身。
 * - 但 `runningExecutionIds` 来自**另一个账本**（`liveExecutions` Map），只有
 *   真正领取到的执行才有 id。空闲执行器几乎始终处在长轮询窗口内，于是稳态上报
 *   恒为「runningTaskCount=1 + runningExecutionIds=[]」——两个数字都对，却度量
 *   了不同的东西：前者是**已占槽位**，后者是**在跑执行**。
 * - 详情页把两者直接交叉核对，遂恒亮「不一致」告警。
 *
 * 修法（协议 4，新增可选字段 `reservedSlots`）：执行器把「预留中」的槽位数单独
 * 上报，详情页把「已占槽位」换算成「实际运行 = runningTaskCount − reservedSlots」
 * 后再与 `runningExecutionIds.length` 比对。
 *
 * 本文件同时用**反证**锁死被否决的修法：绝不能用 `runningExecutionIds.length`
 * 去覆盖 `runningTaskCount`（那会让中台在预留窗口内误判有空槽 → push 派发进已
 * 被预留的槽位 → 执行器 accept 返回 429 → 任务被误判永久失败，恰是 E-01 要关闭
 * 的竞态）。
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
    rotateToken: vi.fn(),
    remove: vi.fn(),
  },
}));
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
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** RPA5 生产现场的稳态快照：已占 1 个槽位（E-01 预留）、活性上报 0 条。 */
const rpa5Executor = {
  id: 'executor-rpa5',
  appName: 'RPA5',
  address: '10.0.0.5:3002',
  status: 'online',
  cpuUsage: 3.2,
  memUsage: 21.5,
  // 执行器自报：已占槽位 1（含预留），实际在跑 0。
  runningTaskCount: 1,
  reservedSlots: 1,
  // 另一个账本：没有任何真正领取到的执行。
  runningExecutionIds: [],
  maxConcurrentTasks: 10,
  lastHeartbeat: new Date().toISOString(),
};

const rpa5Metrics = {
  executor: { id: 'executor-rpa5', address: '10.0.0.5:3002', status: 'online' },
  sevenDayStats: { totalExecutions: 0, successful: 0, failed: 0, successRate: 0, averageDurationMs: 0 },
  current: { runningTaskCount: 1, reservedSlots: 1 },
  history: [],
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/executors/executor-rpa5']}>
        <Routes>
          <Route path="/executors/:id" element={<ExecutorDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 「当前运行任务」卡片的**数值**文本——页面上有多个 .ant-statistic（CPU/内存
 *  等），必须按标题定位，否则会断言到 CPU 卡片上（首版即踩此坑）。只取
 *  value 节点而非整卡：卡片 suffix 是 `/ 10`，整卡文本里含 "1" 会让
 *  `not.toContain('1')` 这类断言永远失败。 */
const currentRunningValue = (): string => {
  const card = (Array.from(document.querySelectorAll('.ant-statistic')) as HTMLElement[]).find(
    (el) => (el.textContent ?? '').includes('当前运行任务'),
  );
  return card?.querySelector('.ant-statistic-content-value')?.textContent ?? '';
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  mockedApi.get.mockResolvedValue({ ...rpa5Executor } as never);
  mockedApi.getMetrics.mockResolvedValue({ ...rpa5Metrics } as never);
  mockedApi.getExecutions.mockResolvedValue({ total: 0, items: [] } as never);
});

afterEach(() => {
  cleanup();
});

describe('E-01-RPT: RPA5 预留槽位不再误报「活性与运行计数不一致」', () => {
  it('显示实际运行数 0（而非已占槽位 1），且不再亮不一致告警', async () => {
    renderPage();
    await screen.findAllByText('RPA5');

    // 正向：卡片显示的是「实际运行 = 已占槽位 − 预留」= 1 − 1 = 0。
    expect(currentRunningValue()).toBe('0');

    // 正向：预留差额被显式说明（可观测性，避免运维把它当成新的不一致）。
    expect(await screen.findByText(/已占 1 个槽位（含 1 个取件预留）/)).toBeTruthy();

    // 正向：活性上报 0 条 === 实际运行 0，故**不得**出现不一致告警。
    expect(screen.queryByText(/活性上报 .* 条，与运行计数 .* 不一致/)).toBeNull();
  });

  it('反证：若执行器未上报 reservedSlots（旧版协议），仍走旧口径并按原样告警', async () => {
    // 反证用例的目的：证明本修法**只**在预留数被显式上报时才生效，没有偷偷
    // 改变旧执行器的语义——否则「0 条活性 vs 计数 1」这类真实异常会被一并掩盖。
    mockedApi.get.mockResolvedValue({
      ...rpa5Executor,
      reservedSlots: null,
    } as never);
    mockedApi.getMetrics.mockResolvedValue({
      ...rpa5Metrics,
      current: { runningTaskCount: 1 },
    } as never);

    renderPage();
    await screen.findAllByText('RPA5');

    // 旧口径：显示已占槽位 1（不做换算），告警照旧出现。
    expect(currentRunningValue()).toBe('1');
    expect(await screen.findByText(/活性上报 0 条，与运行计数 1 不一致/)).toBeTruthy();
    // 且不显示预留说明（没有预留可报）。
    expect(screen.queryByText(/取件预留/)).toBeNull();
  });

  it('反证：预留数越界（> 已占槽位）时钳制，绝不显示负数或反向虚增', async () => {
    // 反证用例的目的：锁死被否决的修法方向——若把 reservedSlots 当成可以随意
    // 相减的量，脏上报会让 UI 显示负数（比真值还荒谬）。此处的钳制保证异常上报
    // 只能退化成旧口径，不会制造新的错误显示。
    mockedApi.get.mockResolvedValue({
      ...rpa5Executor,
      runningTaskCount: 1,
      reservedSlots: 5,
    } as never);
    mockedApi.getMetrics.mockResolvedValue({
      ...rpa5Metrics,
      current: { runningTaskCount: 1, reservedSlots: 5 },
    } as never);

    renderPage();
    await screen.findAllByText('RPA5');

    // 钳制到旧口径：显示已占槽位 1，绝不出现负数。
    expect(currentRunningValue()).toBe('1');
  });

  it('反证：真实运行中（有活性 id）时，预留不得把显示数错误地减掉', async () => {
    // 反证用例的目的：预留与正式占用是**互斥**的两态（领取成功即撤销预留上报），
    // 故「1 个在跑 + 0 预留」必须显示 1；若误减会让运维看到比真值少的数字。
    mockedApi.get.mockResolvedValue({
      ...rpa5Executor,
      runningTaskCount: 1,
      reservedSlots: 0,
      runningExecutionIds: ['exec-a'],
    } as never);
    mockedApi.getMetrics.mockResolvedValue({
      ...rpa5Metrics,
      current: { runningTaskCount: 1, reservedSlots: 0 },
    } as never);

    renderPage();
    await screen.findAllByText('RPA5');

    // 「1 个在跑 + 0 预留」必须显示 1（不得误减）。
    expect(currentRunningValue()).toBe('1');
    expect(screen.queryByText(/活性上报 .* 条，与运行计数 .* 不一致/)).toBeNull();
    expect(screen.queryByText(/取件预留/)).toBeNull();
  });
});
