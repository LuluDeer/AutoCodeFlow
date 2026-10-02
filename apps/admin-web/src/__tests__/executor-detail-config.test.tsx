/**
 * 执行器管理 UI 审计修复——详情页配置热更新专项（B-1 / B-5 / B-6）。
 *
 *  B-1 配置热更新弹窗：① 打开即回显已知值（maxConcurrentTasks 取当前
 *      executor 记录，其余字段留空=保持现有值）；② 空配置体提交前二次确认
 *      （明确警示「空白字段将重置为执行器默认值」），确认后才发请求；
 *      ③ 有值提交维持原流程（不发确认框）。
 *  B-5 reload-config 响应体按 queued 分支提示：pull 执行器后端返回
 *      {queued:true,commandId}，必须提示「已入队，下次心跳 pull 生效」，
 *      不与 push 的「配置已推送」混为一谈。
 *  B-6 同路由组件 id 变化不重挂载：弹窗开合等局部状态跨执行器残留——
 *      id 切换后必须复位（以配置弹窗为例钉死）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ExecutorDetailPage from '../pages/ExecutorDetailPage';
import { executorsApi } from '../api/executors';
import { useAuthStore } from '../store/auth';
import { Modal as confirmModal } from '../utils/modal';
import { message } from '../utils/toast';

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

/** 配置热更新弹窗内的 InputNumber 输入框（表单前三个字段均为 InputNumber） */
const configNumberInputs = (): HTMLInputElement[] =>
  Array.from(document.querySelectorAll('.ant-modal .ant-input-number-input')) as HTMLInputElement[];

function renderPage(initial = '/executors/executor-1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/executors/:id" element={<ExecutorDetailPage />} />
          <Route path="/executors" element={<div>executor-list-mock</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openConfigModal() {
  fireEvent.click(findBtn(document.body, '配置热更新')!);
  await screen.findByText('任务超时(秒)');
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
  // antd 静态 Modal/message holder 为 body 单例，不随 RTL cleanup 清理——
  // 显式销毁，避免确认框/toast 跨用例残留（既有 executor-detail-highrisk 先例）
  confirmModal.destroyAll();
  message.destroy();
});

describe('B-1 配置热更新弹窗回显', () => {
  it('打开弹窗回显 maxConcurrentTasks=10，其余字段留空（保持执行器现有值）', async () => {
    renderPage();
    await screen.findAllByText('demo-executor');
    await openConfigModal();

    const inputs = configNumberInputs();
    expect(inputs.length).toBeGreaterThanOrEqual(3);
    expect(inputs[0].value).toBe('10');
    expect(inputs[1].value).toBe('');
    expect(inputs[2].value).toBe('');
    // 未提交：不发请求
    expect(mockedApi.reloadConfig).not.toHaveBeenCalled();
  });

  it('全空提交 → 先弹「推送空配置？」确认框，确认后才发空体请求', async () => {
    mockedApi.get.mockResolvedValue({ ...executorFixture, maxConcurrentTasks: undefined });
    renderPage();
    await screen.findAllByText('demo-executor');
    await openConfigModal();

    fireEvent.click(findBtn(document.body, 'OK')!);
    // 空体警示确认框出现（i18n：明示空白字段将重置为默认值）；
    // antd 静态 confirm 在 DOM 里可能双渲染/残留，用 AllBy 容忍多命中
    expect((await screen.findAllByText('推送空配置？')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/空白字段重置为服务端默认配置/).length).toBeGreaterThanOrEqual(1);
    expect(mockedApi.reloadConfig).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(findBtn(document.body, '确认')!);
    });
    await waitFor(() => {
      expect(mockedApi.reloadConfig).toHaveBeenCalledWith('executor-1', {});
    });
  });

  it('有值提交维持原流程：直接发请求，不出确认框', async () => {
    renderPage();
    await screen.findAllByText('demo-executor');
    await openConfigModal();

    const inputs = configNumberInputs();
    fireEvent.change(inputs[0], { target: { value: '8' } });
    fireEvent.click(findBtn(document.body, 'OK')!);

    // 直接 mutate（恰好一次、载荷正确）——若走了空体确认分支，未点「确认」
    // 时 reloadConfig 不会被调用，次数断言即转红。（antd 静态 confirm 关闭后
    // 在 jsdom 里残留隐藏 DOM，其文案不可作「未出现」断言，故用调用次数判定）
    await waitFor(() => {
      expect(mockedApi.reloadConfig).toHaveBeenCalledTimes(1);
      expect(mockedApi.reloadConfig).toHaveBeenCalledWith('executor-1', { maxConcurrentTasks: 8 });
    });
  });
});

describe('B-5 reload-config 按响应体 queued 分支提示', () => {
  it('queued:true → 提示「已入队，下次拉取生效」而非「配置已推送」', async () => {
    mockedApi.reloadConfig.mockResolvedValue({ queued: true, commandId: 'cmd-1' });
    // toast 断言走 message spy（antd 静态 message 关闭后在 jsdom 残留隐藏 DOM，
    // 文案存在性断言不可靠——toast.ts 注释明示 vi.spyOn(message) 侦察继续生效）
    const successSpy = vi.spyOn(message, 'success');
    renderPage();
    await screen.findAllByText('demo-executor');
    await openConfigModal();

    await act(async () => {
      fireEvent.click(findBtn(document.body, 'OK')!);
    });
    // maxConcurrentTasks=10 已回显 → 有值提交直接 mutate
    await waitFor(() => expect(mockedApi.reloadConfig).toHaveBeenCalled());
    await waitFor(() => {
      expect(successSpy).toHaveBeenCalledWith('配置更新已入队，将在执行器下次拉取（心跳）时生效');
    });
    expect(successSpy).not.toHaveBeenCalledWith('配置已推送');
  });

  it('push 路径（无 queued 字段）→ 维持「配置已推送」', async () => {
    mockedApi.reloadConfig.mockResolvedValue({});
    const successSpy = vi.spyOn(message, 'success');
    renderPage();
    await screen.findAllByText('demo-executor');
    await openConfigModal();

    await act(async () => {
      fireEvent.click(findBtn(document.body, 'OK')!);
    });
    await waitFor(() => {
      expect(successSpy).toHaveBeenCalledWith('配置已推送');
    });
    expect(successSpy).not.toHaveBeenCalledWith('配置更新已入队，将在执行器下次拉取（心跳）时生效');
  });
});

describe('B-6 id 切换重置局部状态', () => {
  it('同一路由组件内切换执行器 id：已打开的弹窗被复位（不跨执行器残留）', async () => {
    function NavProbe({ to }: { to: string }) {
      const navigate = useNavigate();
      return <button onClick={() => navigate(to)}>nav-go</button>;
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/executors/executor-1']}>
          <Routes>
            <Route path="/executors/:id" element={<><NavProbe to="/executors/executor-2" /><ExecutorDetailPage /></>} />
            <Route path="/executors" element={<div>executor-list-mock</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findAllByText('demo-executor');
    await openConfigModal();
    expect(configNumberInputs().length).toBeGreaterThanOrEqual(3);

    // 同一组件实例内导航到另一台执行器（不重挂载）
    fireEvent.click(screen.getByText('nav-go'));
    await waitFor(() => {
      expect(mockedApi.get).toHaveBeenCalledWith('executor-2', expect.anything());
    });
    // 配置弹窗已复位
    await waitFor(() => {
      expect(document.querySelector('.ant-modal .ant-input-number-input')).toBeNull();
    });
  });
});
