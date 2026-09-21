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
    listByApplication: vi.fn(),
  },
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn() },
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
  vi.mocked(deploymentsApi.listByApplication).mockResolvedValue([] as never);
  vi.mocked(executorsApi.list).mockResolvedValue([] as never);
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
