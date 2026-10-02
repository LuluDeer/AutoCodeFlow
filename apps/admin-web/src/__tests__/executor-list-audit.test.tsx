/**
 * 执行器管理 UI 审计修复——列表/卡片视图专项（B-7 / B-8 / B-13 / B-14）。
 *
 *  B-7 卡片视图与表格视图对齐：pull 模式徽标、版本漂移徽标、磁盘未上报
 *      （null）显式占位（0 是真实上报值，照常渲染）、空态动作注入。
 *  B-8 status==='busy' 死分支删除：未知取值按 offline 渲染（表格视图同
 *      口径），不再出现永不可达的「忙碌」。
 *  B-13 卡片快捷按钮直达批量 confirm 流程（此前仅 setSelectedRowKeys 弹
 *      批量条，要多跳一步）：reload/rotate 都直接出确认框并执行，rotate
 *      成功后 token 结果弹窗照常一次性展示。
 *  B-14 表格状态/任务/心跳列补本地 sorter。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ExecutorListPage from '../pages/ExecutorListPage';
import { ExecutorCardGrid } from '../components/executor/ExecutorCardGrid';
import { executorsApi, type Executor } from '../api/executors';
import { useAuthStore } from '../store/auth';
import { Modal as confirmModal } from '../utils/modal';
import { message } from '../utils/toast';

vi.mock('../api/executors', () => ({
  executorsApi: {
    list: vi.fn(),
    getGroups: vi.fn(),
    getRuntimeConfig: vi.fn(),
    reloadConfig: vi.fn(),
    rotateToken: vi.fn(),
  },
}));
const mockedExecutors = vi.mocked(executorsApi, true);

vi.mock('../api/client', () => ({
  client: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

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
const baseExecutor: Executor = {
  id: 'ex-1',
  appName: 'alpha',
  address: '10.0.0.1:3002',
  status: 'online',
  cpuUsage: 10,
  memUsage: 20,
  runningTaskCount: 0,
  lastHeartbeat: new Date(NOW - 10_000).toISOString(),
};
const makeExecutor = (over: Partial<Executor>): Executor => ({ ...baseExecutor, ...over });

const runtimeCfg = {
  heartbeatIntervalMs: 30000,
  heartbeatTimeoutMultiplier: 3,
  heartbeatTimeoutMs: 90000,
  listLimit: 500,
  executorTotal: 2,
};

/** antd 双汉字按钮自动插空格，textContent 归一化后精确匹配（既有先例） */
const findBtn = (root: ParentNode, text: string): HTMLButtonElement | null =>
  (Array.from(root.querySelectorAll('button')) as HTMLButtonElement[]).find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === text,
  ) ?? null;

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/executors']}>
        <Routes>
          <Route path="/executors" element={<ExecutorListPage />} />
          <Route path="/executors/:id" element={<div>executor-detail-mock</div>} />
          <Route path="/executors/install" element={<div>install-wizard-mock</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  mockedExecutors.list.mockResolvedValue([makeExecutor({})]);
  mockedExecutors.getGroups.mockResolvedValue([]);
  mockedExecutors.getRuntimeConfig.mockResolvedValue(runtimeCfg);
  mockedExecutors.reloadConfig.mockResolvedValue({});
  mockedExecutors.rotateToken.mockResolvedValue({ token: 'new-token-12345', expiresAt: '2026-01-01' });
});

afterEach(() => {
  cleanup();
  // antd 静态 Modal/message holder 为 body 单例，不随 RTL cleanup 清理——
  // 显式销毁，避免确认框/toast 跨用例残留（既有 executor-detail-highrisk 先例）
  confirmModal.destroyAll();
  message.destroy();
});

// ── B-7 / B-8：卡片视图（组件级直渲） ────────────────────────────────────

describe('B-7 卡片视图徽标与表格视图对齐', () => {
  const renderGrid = (executor: Executor, extra?: { empty?: boolean; emptyExtra?: ReactNode }) =>
    render(
      <ExecutorCardGrid
        executors={extra?.empty ? [] : [executor]}
        selectedIds={[]}
        onToggleSelect={() => {}}
        onOpenDetail={() => {}}
        staleTimeoutMs={90000}
        emptyExtra={extra?.emptyExtra}
      />,
    );

  it('pull 模式与版本漂移徽标渲染（复用表格视图键）', () => {
    renderGrid(makeExecutor({ dispatchMode: 'pull', versionCompliant: false }));
    expect(screen.getByText('Pull 回连')).toBeTruthy();
    expect(screen.getByText('版本过低')).toBeTruthy();
  });

  it('push 模式且版本合规：徽标不渲染（防噪，表格视图同款纪律）', () => {
    renderGrid(makeExecutor({}));
    expect(screen.queryByText('Pull 回连')).toBeNull();
    expect(screen.queryByText('版本过低')).toBeNull();
  });

  it('磁盘未上报（null）显式占位「未上报」；0 是真实上报值，照常渲染进度行', () => {
    renderGrid(makeExecutor({ diskUsage: undefined }));
    expect(screen.getByText('未上报')).toBeTruthy();

    cleanup();
    // diskUsage = 0：不隐藏（磁盘为空是真实状态）
    renderGrid(makeExecutor({ diskUsage: 0 }));
    expect(screen.getByText('0%')).toBeTruthy();
    expect(screen.queryByText('未上报')).toBeNull();
  });

  it('空态渲染注入的动作按钮（emptyExtra）', () => {
    renderGrid(makeExecutor({}), { empty: true, emptyExtra: <button type="button">清除筛选</button> });
    expect(screen.getByText('无匹配执行器')).toBeTruthy();
    expect(screen.getByText('清除筛选')).toBeTruthy();
  });
});

describe('B-8 busy 死分支清理', () => {
  it('status=busy（永不可达取值）按 offline 渲染，不再出现「忙碌」', () => {
    render(
      <ExecutorCardGrid
        executors={[makeExecutor({ status: 'busy' })]}
        selectedIds={[]}
        onToggleSelect={() => {}}
        onOpenDetail={() => {}}
        staleTimeoutMs={90000}
      />,
    );
    expect(screen.getByText('离线')).toBeTruthy();
    expect(screen.queryByText('忙碌')).toBeNull();
  });
});

// ── B-13：卡片快捷按钮直达批量 confirm 流程（页面级） ─────────────────────

describe('B-13 卡片快捷按钮直达 confirm', () => {
  it('配置热更新快捷按钮：直接出现批量确认框，确认后调用 reload-config', async () => {
    renderPage();
    await screen.findByText('alpha');
    fireEvent.click(screen.getByText('卡片'));
    fireEvent.click(screen.getByLabelText('配置热更新 alpha'));

    // 直达确认框（旧实现只是 setSelectedRowKeys 弹批量条）；antd ConfirmDialog
    // 标题双节点渲染（.ant-modal-title + .ant-modal-confirm-title），用 AllBy 容忍
    expect((await screen.findAllByText(/批量配置热更新（1 台在线）/)).length).toBeGreaterThanOrEqual(1);
    await act(async () => {
      fireEvent.click(findBtn(document.body, '确认推送')!);
    });
    await waitFor(() => {
      expect(mockedExecutors.reloadConfig).toHaveBeenCalledWith('ex-1', {});
    });
  });

  it('轮换 Token 快捷按钮：直达确认框；成功后 token 结果弹窗展示', async () => {
    renderPage();
    await screen.findByText('alpha');
    fireEvent.click(screen.getByText('卡片'));
    fireEvent.click(screen.getByLabelText('轮换 Token alpha'));

    expect((await screen.findAllByText(/批量轮换 Token（1 台）/)).length).toBeGreaterThanOrEqual(1);
    await act(async () => {
      fireEvent.click(findBtn(document.body, '确认轮换')!);
    });
    await waitFor(() => {
      expect(mockedExecutors.rotateToken).toHaveBeenCalledWith('ex-1');
    });
    // token 结果弹窗（由列表页常驻持有，批量条未挂载也可见）；弹窗里 token
    // 截前 8 位展示（new-token-12345 → new-toke…）
    expect(await screen.findByText(/批量轮换结果/)).toBeTruthy();
    expect(screen.getByText(/new-toke/)).toBeTruthy();
  });

  it('控制面不可达（pull 且协议 <2）的卡片：配置热更新按钮禁用', async () => {
    mockedExecutors.list.mockResolvedValue([makeExecutor({
      id: 'ex-pull', appName: 'pull-node', dispatchMode: 'pull',
    })]);
    renderPage();
    await screen.findByText('pull-node');
    fireEvent.click(screen.getByText('卡片'));
    const reloadBtn = screen.getByLabelText('配置热更新 pull-node') as HTMLButtonElement;
    expect(reloadBtn.disabled).toBe(true);
  });
});

// ── B-14：表格列 sorter ─────────────────────────────────────────────────

describe('B-14 列表补 sorter', () => {
  const headerCells = () => Array.from(document.querySelectorAll('.ant-table-thead th'));
  const rowTexts = () =>
    Array.from(document.querySelectorAll('.ant-table-tbody tr.ant-table-row')).map((r) => r.textContent ?? '');

  it('状态/任务/心跳三列带排序器；任务列点击后按任务数升序', async () => {
    mockedExecutors.list.mockResolvedValue([
      makeExecutor({ id: 'ex-1', appName: 'alpha', runningTaskCount: 5 }),
      makeExecutor({ id: 'ex-2', appName: 'beta', runningTaskCount: 1 }),
    ]);
    renderPage();
    await screen.findByText('alpha');

    for (const label of ['状态', '任务', '心跳']) {
      const th = headerCells().find((c) => (c.textContent ?? '').includes(label));
      expect(th, `列头 ${label} 缺 sorter`).toBeTruthy();
      expect(th!.querySelector('.ant-table-column-sorter')).toBeTruthy();
    }

    // 点击「任务」列头 → 本地升序：beta(1) 排到 alpha(5) 前
    const tasksTh = headerCells().find((c) => (c.textContent ?? '').includes('任务'));
    fireEvent.click(tasksTh!);
    await waitFor(() => {
      expect(rowTexts()[0]).toContain('beta');
      expect(rowTexts()[1]).toContain('alpha');
    });
  });
});
