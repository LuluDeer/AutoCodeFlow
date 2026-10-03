/**
 * 编辑弹窗「最大并发数」清空语义显性化。
 *
 * ## 这条守的是什么
 *
 * 编辑弹窗走 `PATCH /executors/:id`：maxConcurrentTasks 输入框清空后提交，
 * pickExecutorEditPayload 仍携带该键（值为 null）→ 服务端**保留旧值**——但
 * 用户极易把「清空」误读为「不限制」。语义本身不改（改 PATCH 有破坏风险），
 * 只把后果说清楚：原值非空且当前输入为空时，字段下方出现
 * 「清空保存将保留当前值 N（留空≠不限制）」提示；填回数字后提示消失。
 *
 * 边界：原值本就为空（null=未限制）时清空无歧义，**不得**出现提示。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
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
    rotateToken: vi.fn(),
    remove: vi.fn(),
    removalImpact: vi.fn(),
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

const executorFixture = {
  id: 'executor-1',
  appName: 'demo-executor',
  address: '10.0.0.9:3002',
  status: 'online',
  cpuUsage: 12.5,
  memUsage: 40.1,
  runningTaskCount: 1,
  lastHeartbeat: new Date().toISOString(),
  maxConcurrentTasks: 10 as number | undefined,
};

const emptyMetrics = {
  executor: { id: 'executor-1', address: '10.0.0.9:3002', status: 'online' },
  sevenDayStats: { totalExecutions: 0, successful: 0, failed: 0, successRate: 0, averageDurationMs: 0 },
  current: { runningTaskCount: 0 },
  history: [],
};

/** antd 双汉字按钮自动插空格，textContent 归一化后精确匹配（既有先例） */
const findBtn = (root: ParentNode, text: string): HTMLButtonElement | null =>
  (Array.from(root.querySelectorAll('button')) as HTMLButtonElement[]).find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === text,
  ) ?? null;

/** 编辑弹窗里唯一的 InputNumber = maxConcurrentTasks（其余字段是 Input/Select/TextArea） */
const editMaxConcurrentInput = (): HTMLInputElement => {
  const el = document.querySelector<HTMLInputElement>('.ant-modal .ant-input-number-input');
  expect(el).toBeTruthy();
  return el!;
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
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

async function openEditModal() {
  fireEvent.click(findBtn(document.body, '编辑')!);
  await screen.findByText('分组名称');
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  mockedApi.get.mockResolvedValue(executorFixture);
  mockedApi.getMetrics.mockResolvedValue(emptyMetrics);
  mockedApi.getExecutions.mockResolvedValue({ total: 0, items: [] });
  mockedApi.getRuntimeConfig.mockResolvedValue({
    heartbeatIntervalMs: 30000,
    heartbeatTimeoutMultiplier: 3,
    heartbeatTimeoutMs: 90000,
    listLimit: 500,
    executorTotal: 1,
  });
  mockedApi.removalImpact.mockRejectedValue(new Error('removal-impact unavailable'));
});

afterEach(() => {
  cleanup();
});

describe('编辑弹窗：清空最大并发数 = 保留旧值 的显性提示', () => {
  it('原值 10、清空输入 → 字段下方出现「清空保存将保留当前值 10」提示', async () => {
    renderPage();
    await screen.findAllByText('demo-executor');
    await openEditModal();

    // 打开即回显 10：此时无提示
    expect(editMaxConcurrentInput().value).toBe('10');
    expect(screen.queryByText(/清空保存将保留当前值/)).toBeNull();

    fireEvent.change(editMaxConcurrentInput(), { target: { value: '' } });
    await waitFor(() => {
      const extra = document.querySelector('.ant-modal .ant-form-item-extra');
      expect(extra?.textContent ?? '').toContain('清空保存将保留当前值 10');
      // 必须说清「留空≠不限制」——这正是用户可能产生的误读
      expect(extra?.textContent ?? '').toContain('不限制');
    });
  });

  it('填回数字后提示消失', async () => {
    renderPage();
    await screen.findAllByText('demo-executor');
    await openEditModal();

    fireEvent.change(editMaxConcurrentInput(), { target: { value: '' } });
    await waitFor(() => {
      expect(document.querySelector('.ant-modal .ant-form-item-extra')).toBeTruthy();
    });

    fireEvent.change(editMaxConcurrentInput(), { target: { value: '8' } });
    await waitFor(() => {
      expect(document.querySelector('.ant-modal .ant-form-item-extra')).toBeNull();
    });
  });

  it('原值本就为空（null=不限制）时清空不出现提示（无歧义不打扰）', async () => {
    mockedApi.get.mockResolvedValue({ ...executorFixture, maxConcurrentTasks: undefined });
    renderPage();
    await screen.findAllByText('demo-executor');
    await openEditModal();

    // 回显即为空态，清空（再次置空）也不得出现「保留旧值」提示
    expect(editMaxConcurrentInput().value).toBe('');
    fireEvent.change(editMaxConcurrentInput(), { target: { value: '5' } });
    fireEvent.change(editMaxConcurrentInput(), { target: { value: '' } });
    await waitFor(() => {
      expect(editMaxConcurrentInput().value).toBe('');
    });
    expect(document.querySelector('.ant-modal .ant-form-item-extra')).toBeNull();
    expect(screen.queryByText(/清空保存将保留当前值/)).toBeNull();
  });
});
