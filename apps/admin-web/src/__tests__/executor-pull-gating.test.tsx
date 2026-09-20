import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Modal, message } from 'antd';
import BatchActionBar from '../components/executor/BatchActionBar';
import ExecutorDetailPage from '../pages/ExecutorDetailPage';
import { executorsApi, type Executor } from '../api/executors';
import { useAuthStore } from '../store/auth';

vi.mock('../api/executors', () => ({
  executorsApi: {
    get: vi.fn(),
    getMetrics: vi.fn(),
    getExecutions: vi.fn(),
    rotateToken: vi.fn(),
    remove: vi.fn(),
    reloadConfig: vi.fn(),
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

const emptyMetrics = {
  executor: { id: 'ex-pull', address: 'nat:9999', status: 'online' },
  sevenDayStats: { totalExecutions: 0, successful: 0, failed: 0, successRate: 0, averageDurationMs: 0 },
  current: { runningTaskCount: 0 },
  history: [],
};

function renderBatch(selected: Executor[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <BatchActionBar selected={selected} isAdmin onDone={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderDetail() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/executors/ex-pull']}>
        <Routes>
          <Route path="/executors/:id" element={<ExecutorDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** antd 双汉字按钮自动插空格，textContent 归一化后精确匹配（既有先例） */
const findBtn = (root: ParentNode, text: string): HTMLButtonElement | null =>
  (Array.from(root.querySelectorAll('button')) as HTMLButtonElement[]).find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === text,
  ) ?? null;

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  mockedApi.get.mockResolvedValue(
    makeExecutor({ id: 'ex-pull', appName: 'pull-exec', address: 'nat:9999', dispatchMode: 'pull' }),
  );
  mockedApi.getMetrics.mockResolvedValue(emptyMetrics as never);
  mockedApi.getExecutions.mockResolvedValue({ total: 0, items: [] } as never);
});

afterEach(() => cleanup());

describe('UI-18 → ARCH-33: 批量 reload-config 门控（判据由「pull」改为「pull 且协议<2」）', () => {
  it('混合选择：确认后仅对 push 执行器发送 reload，v1 pull 被剔除', async () => {
    const confirmSpy = vi.spyOn(Modal, 'confirm').mockImplementation(((opt: { onOk?: () => void }) => {
      void opt.onOk?.();
    }) as never);
    renderBatch([
      makeExecutor({ id: 'ex-push', appName: 'push-exec', dispatchMode: 'push' }),
      // v1 pull：不认识 commands 字段，会静默忽略 → 必须剔除
      makeExecutor({ id: 'ex-pull', appName: 'pull-exec', dispatchMode: 'pull', protocolVersion: 1 }),
    ]);

    const btn = findBtn(document.body, '批量配置热更新');
    expect(btn).toBeTruthy();
    btn!.click();
    await vi.waitFor(() => expect(mockedApi.reloadConfig).toHaveBeenCalledTimes(1));
    expect(mockedApi.reloadConfig).toHaveBeenCalledWith('ex-push', {});
    confirmSpy.mockRestore();
  });

  // ARCH-33（ADR-016）核心行为变更：协议 v2 的 pull 执行器**可以**热更新了。
  // 旧判据（dispatchMode === 'pull' 即剔除）对它已失效——继续剔除等于把
  // ADR-016 搬上 pull 通道的控制面能力白做。
  it('ARCH-33：协议 v2 的 pull 执行器**不再**被剔除（控制面已上 pull 通道）', async () => {
    const confirmSpy = vi.spyOn(Modal, 'confirm').mockImplementation(((opt: { onOk?: () => void }) => {
      void opt.onOk?.();
    }) as never);
    renderBatch([
      makeExecutor({ id: 'ex-push', appName: 'push-exec', dispatchMode: 'push' }),
      makeExecutor({ id: 'ex-pull2', appName: 'pull-v2', dispatchMode: 'pull', protocolVersion: 2 }),
    ]);

    const btn = findBtn(document.body, '批量配置热更新');
    btn!.click();
    await vi.waitFor(() => expect(mockedApi.reloadConfig).toHaveBeenCalledTimes(2));
    expect(mockedApi.reloadConfig).toHaveBeenCalledWith('ex-pull2', {});
    expect(mockedApi.reloadConfig).toHaveBeenCalledWith('ex-push', {});
    confirmSpy.mockRestore();
  });

  it('全为 v1 pull：直接提示不弹确认、不发请求', async () => {
    const warnSpy = vi.spyOn(message, 'warning').mockImplementation(() => undefined as never);
    const confirmSpy = vi.spyOn(Modal, 'confirm').mockImplementation(() => undefined as never);
    renderBatch([
      makeExecutor({ id: 'ex-p1', appName: 'p1', dispatchMode: 'pull', protocolVersion: 1 }),
      makeExecutor({ id: 'ex-p2', appName: 'p2', dispatchMode: 'pull' }), // 未上报 = v1
    ]);

    const btn = findBtn(document.body, '批量配置热更新');
    btn!.click();
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled());
    expect(mockedApi.reloadConfig).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    confirmSpy.mockRestore();
  });

  it('全为 v2 pull：可以正常批量热更新（不再提示「仅 pull」）', async () => {
    const warnSpy = vi.spyOn(message, 'warning').mockImplementation(() => undefined as never);
    const confirmSpy = vi.spyOn(Modal, 'confirm').mockImplementation(((opt: { onOk?: () => void }) => {
      void opt.onOk?.();
    }) as never);
    renderBatch([
      makeExecutor({ id: 'ex-p1', appName: 'p1', dispatchMode: 'pull', protocolVersion: 2 }),
      makeExecutor({ id: 'ex-p2', appName: 'p2', dispatchMode: 'pull', protocolVersion: 2 }),
    ]);

    const btn = findBtn(document.body, '批量配置热更新');
    btn!.click();
    await vi.waitFor(() => expect(mockedApi.reloadConfig).toHaveBeenCalledTimes(2));
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    confirmSpy.mockRestore();
  });
});

describe('UI-18 → ARCH-33: 详情页控制面入口门控', () => {
  it('v1 pull 执行器：显示 Pull 回连 Tag，配置热更新按钮 disabled', async () => {
    mockedApi.get.mockResolvedValue(
      makeExecutor({ id: 'ex-pull', appName: 'pull-exec', address: 'nat:9999', dispatchMode: 'pull', protocolVersion: 1 }),
    );
    renderDetail();
    await screen.findAllByText('pull-exec');

    expect(await screen.findByText('Pull 回连')).toBeTruthy();
    const btn = findBtn(document.body, '配置热更新');
    expect(btn).toBeTruthy();
    expect(btn!.disabled).toBe(true);
  });

  it('ARCH-33：协议 v2 pull 执行器按钮**可用**（控制面已上 pull 通道）', async () => {
    mockedApi.get.mockResolvedValue(
      makeExecutor({ id: 'ex-pull', appName: 'pull-v2', address: 'nat:9999', dispatchMode: 'pull', protocolVersion: 2 }),
    );
    renderDetail();
    await screen.findAllByText('pull-v2');

    const btn = findBtn(document.body, '配置热更新');
    expect(btn).toBeTruthy();
    expect(btn!.disabled).toBe(false);
  });

  it('未上报协议版本的 pull 执行器：按钮 disabled（兜底为不支持）', async () => {
    mockedApi.get.mockResolvedValue(
      makeExecutor({ id: 'ex-pull', appName: 'pull-legacy', address: 'nat:9999', dispatchMode: 'pull' }),
    );
    renderDetail();
    await screen.findAllByText('pull-legacy');

    const btn = findBtn(document.body, '配置热更新');
    expect(btn!.disabled).toBe(true);
  });

  it('push 执行器（缺省）按钮可用', async () => {
    mockedApi.get.mockResolvedValue(
      makeExecutor({ id: 'ex-pull', appName: 'push-exec', address: 'lan:3002' }),
    );
    renderDetail();
    await screen.findAllByText('push-exec');

    const btn = findBtn(document.body, '配置热更新');
    expect(btn).toBeTruthy();
    expect(btn!.disabled).toBe(false);
  });
});
