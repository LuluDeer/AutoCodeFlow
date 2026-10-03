/**
 * P0（UX-AUDIT-2026-09-21 §P0-2）：列表页「快速部署」不得对未派发的部署谎报成功。
 *
 * ## 这条守的是什么
 *
 * 应用开启审批流（`approvalRequired`）后，后端 `deploy` **只落一条
 * pending_approval 行、直接 return，不派发**（app-deployment.service.ts）。
 * 详情页对这个返回值做了正确判定（`AppDeploymentPage.handleDeploy`：pending →
 * `message.info`，否则 `message.success`），但**列表页的快速部署无条件弹
 * 「部署已创建」**。
 *
 * 后果是典型的静默失败：用户在更常用的列表页入口点部署，看到绿色成功提示就
 * 关掉弹窗走人——而实际上什么都不会被派发，一行待审批记录静静躺在详情页等人
 * 批准。用户不会去审批页，因为界面刚刚告诉他"已经创建好了"。
 *
 * ## 断言策略
 *
 * 直接断言"调用哪个 message 方法"，因为谎报成功的本质就是**用了 success**：
 * 只断言"有提示"会漏掉这个缺陷（旧实现也有提示，只是提示错了）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { mockSuccess, mockInfo, mockError } = vi.hoisted(() => ({
  mockSuccess: vi.fn(),
  mockInfo: vi.fn(),
  mockError: vi.fn(),
}));

vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();
  return {
    ...actual,
    message: { success: mockSuccess, info: mockInfo, error: mockError, warning: vi.fn() },
  };
});

vi.mock('../api/applications', () => ({
  applicationsApi: {
    list: vi.fn(),
    get: vi.fn(),
    deploy: vi.fn(),
    remove: vi.fn(),
    create: vi.fn(),
  },
  deploymentsApi: {
    deploy: vi.fn(),
    list: vi.fn(),
  },
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn(), picker: vi.fn() },
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: 'app-1' }),
  useSearchParams: () => [new URLSearchParams('')],
  Link: (props: { to: string; children: React.ReactNode }) => <a href={props.to}>{props.children}</a>,
}));

const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

import ApplicationListPage from '../pages/ApplicationListPage';
import { applicationsApi, deploymentsApi } from '../api/applications';
import { executorsApi } from '../api/executors';
import { useAuthStore } from '../store/auth';

const APP = {
  id: 'app-1',
  name: 'refund-sync',
  runtime: 'python',
  version: '1.0.0',
  status: 'active',
  packageUrl: 'http://api/uploads/packages/a.zip',
  approvalRequired: true,
};

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const renderPage = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <ApplicationListPage />
    </QueryClientProvider>,
  );

/**
 * 打开"快速部署"弹窗并提交（走完整用户路径，不直接调 handler）。
 * 行内按钮对非管理员 disabled，故须先置管理员态（对齐 application-list-rbac 惯例）。
 */
async function openQuickDeployAndSubmit() {
  await waitFor(() => expect(screen.getByText('refund-sync')).toBeTruthy());
  // 行内动作按钮文案是「新建部署」（appList.action.deploy）
  const trigger = screen.getByText(/新建部署|Deploy/);
  fireEvent.click(trigger.closest('button') ?? trigger);
  const confirm = await screen.findByRole('button', { name: /创建部署|Create deployment/ });
  fireEvent.click(confirm);
}

beforeEach(() => {
  useAuthStore.setState({
    user: { id: 1, username: 'root', role: 'admin' } as never,
  });
  mockSuccess.mockClear();
  mockInfo.mockClear();
  mockError.mockClear();
  vi.mocked(applicationsApi.list).mockResolvedValue([APP] as never);
  vi.mocked(deploymentsApi.list).mockResolvedValue({ data: [], total: 0 } as never);
  vi.mocked(executorsApi.list).mockResolvedValue([] as never);
  vi.mocked(executorsApi.picker).mockResolvedValue({ items: [], total: 0, truncated: false, limit: 2000 } as never);
});

afterEach(() => cleanup());

describe('P0-2: 列表页快速部署的成功提示必须与真实派发状态一致', () => {
  it('审批流应用：deploy 返回 pending_approval → 用 info 而非 success', async () => {
    vi.mocked(deploymentsApi.deploy).mockResolvedValue({
      id: 'dep-1',
      status: 'pending',
      approvalStatus: 'pending_approval',
    } as never);

    renderPage();
    await openQuickDeployAndSubmit();

    await waitFor(() => expect(deploymentsApi.deploy).toHaveBeenCalled());
    // 核心断言：不得出现"成功"语义的提示（后端根本没派发）
    await waitFor(() => expect(mockInfo).toHaveBeenCalled());
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it('无审批流的应用：正常派发 → 仍然用 success（不得把正常路径改成 info）', async () => {
    vi.mocked(deploymentsApi.deploy).mockResolvedValue({
      id: 'dep-2',
      status: 'deploying',
      approvalStatus: null,
    } as never);

    renderPage();
    await openQuickDeployAndSubmit();

    await waitFor(() => expect(mockSuccess).toHaveBeenCalled());
    expect(mockInfo).not.toHaveBeenCalled();
  });
});

/**
 * UX（Select 键入搜索）+ PICKER（执行器选择器数据源）：执行器数量随接入增长，
 * 快速部署的执行器下拉必须支持键入过滤，且按**地址**（label = "name (address)"
 * 的次要字段）也能命中——若实现回退成默认按 value 过滤，此用例会红。
 *
 * 数据源回归：下拉候选必须来自 GET /executors/picker（轻读面 + 显式截断旗标），
 * 而非 GET /executors 的 listLimit(500) 静默截断列表——若实现回退吃 list()，
 * 下方 picker items 不会出现在选项里，此用例立即变红。
 */
describe('快速部署执行器下拉支持键入搜索（数据源 = /executors/picker）', () => {
  it('showSearch 开启，按地址过滤能命中唯一执行器，且选项来自 picker.items', async () => {
    vi.mocked(executorsApi.picker).mockResolvedValue({
      items: [
        { id: 'ex-1', appName: 'edge-a', address: '10.0.0.1', status: 'online', runningTaskCount: 0, maxConcurrentTasks: null },
        { id: 'ex-2', appName: 'edge-b', address: '10.0.0.2', status: 'online', runningTaskCount: 0, maxConcurrentTasks: null },
      ],
      total: 2,
      truncated: false,
      limit: 2000,
    } as never);

    renderPage();
    await waitFor(() => expect(screen.getByText('refund-sync')).toBeTruthy());
    fireEvent.click(screen.getByText(/新建部署|Deploy/).closest('button')!);

    // 页面里还有分页 pageSize 切换器等自带 showSearch 的 Select，故必须
    // 先按标题圈定「快速新建部署」弹窗，再在其中找执行器下拉。
    const modal = await waitFor(() => {
      const el = screen.getByText(/快速新建部署|Quick new deployment/).closest('.ant-modal');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    const combo = modal.querySelector<HTMLInputElement>('.ant-select-show-search input');
    expect(combo).toBeTruthy();

    fireEvent.mouseDown(combo!);
    fireEvent.change(combo!, { target: { value: '10.0.0.2' } });
    await waitFor(() => {
      const opts = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')];
      expect(opts).toHaveLength(1);
      expect(opts[0].textContent).toContain('edge-b');
    });
    // 数据源钉死：本用例的候选只挂在 picker 上——list 返回空数组，
    // 若实现回退吃 list()，下拉将空无一物。
    expect(executorsApi.picker).toHaveBeenCalled();
    expect(executorsApi.list).not.toHaveBeenCalled();
  });

  it('picker 超限（truncated=true）：下拉下方必须出现显式截断告警，不许静默', async () => {
    vi.mocked(executorsApi.picker).mockResolvedValue({
      items: [
        { id: 'ex-1', appName: 'edge-a', address: '10.0.0.1', status: 'online', runningTaskCount: 0, maxConcurrentTasks: null },
      ],
      total: 2500,
      truncated: true,
      limit: 2000,
    } as never);

    renderPage();
    await waitFor(() => expect(screen.getByText('refund-sync')).toBeTruthy());
    fireEvent.click(screen.getByText(/新建部署|Deploy/).closest('button')!);

    const modal = await waitFor(() => {
      const el = screen.getByText(/快速新建部署|Quick new deployment/).closest('.ant-modal');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    // 复用 execList.truncated 文案：总数与上限都必须如实出现
    await waitFor(() => {
      expect(modal.textContent).toContain('2500');
      expect(modal.textContent).toContain('2000');
    });
  });

  it('离线执行器禁用（既有过滤行为保留），在线可选', async () => {
    vi.mocked(executorsApi.picker).mockResolvedValue({
      items: [
        { id: 'ex-1', appName: 'edge-a', address: '10.0.0.1', status: 'online', runningTaskCount: 0, maxConcurrentTasks: null },
        { id: 'ex-3', appName: 'edge-off', address: '10.0.0.3', status: 'offline', runningTaskCount: 0, maxConcurrentTasks: null },
      ],
      total: 2,
      truncated: false,
      limit: 2000,
    } as never);

    renderPage();
    await waitFor(() => expect(screen.getByText('refund-sync')).toBeTruthy());
    fireEvent.click(screen.getByText(/新建部署|Deploy/).closest('button')!);

    const modal = await waitFor(() => {
      const el = screen.getByText(/快速新建部署|Quick new deployment/).closest('.ant-modal');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    fireEvent.mouseDown(modal.querySelector<HTMLInputElement>('.ant-select-show-search input')!);
    await waitFor(() => {
      const opts = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')];
      expect(opts).toHaveLength(2);
      const off = opts.find((o) => o.textContent?.includes('edge-off'));
      const on = opts.find((o) => o.textContent?.includes('edge-a'));
      expect(off?.getAttribute('aria-disabled')).toBe('true');
      expect(on?.getAttribute('aria-disabled')).toBe('false');
    });
  });
});

/**
 * 快速部署 picker 拉取失败的原位重试（UI-16 口径）：失败不得只弹一闪而过的
 * toast——下拉空态没有任何出口，用户只能关窗重开碰运气。模态内必须原位呈现
 * 「失败 + 重试」，重试**不关窗**重新拉取 picker；且失败时下拉空态不得谎报
 * 「无可用执行器」（执行器可能有，只是没拉到）。
 */
describe('快速部署执行器下拉：picker 失败原位重试', () => {
  it('picker 拒绝 → 模态内错误块出现（复用 appList.executorListFail 文案）且空态不谎报无执行器；点重试恢复后选项出现', async () => {
    vi.mocked(executorsApi.picker).mockRejectedValueOnce(new Error('网络中断'));
    renderPage();
    await waitFor(() => expect(screen.getByText('refund-sync')).toBeTruthy());
    fireEvent.click(screen.getByText(/新建部署|Deploy/).closest('button')!);

    const modal = await waitFor(() => {
      const el = screen.getByText(/快速新建部署|Quick new deployment/).closest('.ant-modal');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    // 原位错误块（StateError）：既有失败文案 + 具体错误信息 + 重试按钮
    await waitFor(() => {
      const err = modal.querySelector('[data-testid="state-error"]');
      expect(err).toBeTruthy();
      expect(err!.textContent).toContain('获取执行器列表失败');
      expect(err!.textContent).toContain('网络中断');
    });
    expect(mockSuccess).not.toHaveBeenCalled();

    // 失败时展开下拉：空态文案是失败说明，不是「无可用执行器」
    fireEvent.mouseDown(modal.querySelector<HTMLInputElement>('.ant-select-show-search input')!);
    await waitFor(() => {
      expect(document.body.textContent).toContain('获取执行器列表失败');
    });
    expect(document.body.textContent).not.toContain('无可用执行器');

    // 恢复 mock → 点「重试」→ 不关窗重新拉取，选项原位出现
    vi.mocked(executorsApi.picker).mockResolvedValue({
      items: [
        { id: 'ex-1', appName: 'edge-a', address: '10.0.0.1', status: 'online', runningTaskCount: 0, maxConcurrentTasks: null },
      ],
      total: 1,
      truncated: false,
      limit: 2000,
    } as never);
    fireEvent.click(screen.getByRole('button', { name: /重试/ }));
    await waitFor(() => expect(executorsApi.picker).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      const opts = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')];
      expect(opts).toHaveLength(1);
      expect(opts[0].textContent).toContain('edge-a');
    });
    // 成功后错误块消失
    await waitFor(() => {
      expect(modal.querySelector('[data-testid="state-error"]')).toBeNull();
    });
  });

  it('重试仍失败 → 错误块持续在位（不给「一切正常」假象），可再次重试', async () => {
    vi.mocked(executorsApi.picker).mockRejectedValue(new Error('网络中断'));
    renderPage();
    await waitFor(() => expect(screen.getByText('refund-sync')).toBeTruthy());
    fireEvent.click(screen.getByText(/新建部署|Deploy/).closest('button')!);

    const modal = await waitFor(() => {
      const el = screen.getByText(/快速新建部署|Quick new deployment/).closest('.ant-modal');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    await waitFor(() => {
      expect(modal.querySelector('[data-testid="state-error"]')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: /重试/ }));
    await waitFor(() => expect(executorsApi.picker).toHaveBeenCalledTimes(2));
    // 重试后错误依旧在位（不闪没），用户可继续重试
    expect(modal.querySelector('[data-testid="state-error"]')).toBeTruthy();
  });
});
