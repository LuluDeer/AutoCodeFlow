/**
 * DEP-04: 部署审批流前端——待审批行操作（批准/拒绝/撤回）、第二人规则
 * 前端禁用、审批状态徽标、审批待办 Alert、拒绝理由 Modal。
 * 后端行为（门控/原子认领/审计）由 admin-api app-deployment.approval.spec 覆盖，
 * 本文件断言 UI 消费面。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import AppDeploymentPage from '../pages/AppDeploymentPage';
import { deploymentsApi } from '../api/applications';
import { executorsApi } from '../api/executors';
import { useAuthStore } from '../store/auth';

vi.mock('../api/applications', () => ({
  deploymentsApi: {
    list: vi.fn(),
    deploy: vi.fn(),
    stop: vi.fn(),
    upgrade: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    cancel: vi.fn(),
  },
  applicationsApi: { upgradeAll: vi.fn() },
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn() },
}));

// jsdom 缺失 antd 依赖的浏览器 API，先行补齐（对齐既有先例）
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

const dep = (overrides: Record<string, unknown> = {}) => ({
  id: 'dep-1',
  applicationId: 'app-1',
  executorAddress: 'executor-a:3001',
  status: 'running',
  runMode: 'daemon',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

const pendingDep = (overrides: Record<string, unknown> = {}) =>
  dep({
    status: 'pending',
    approvalStatus: 'pending_approval',
    approvalMeta: {
      requestedBy: 7,
      requestedByName: 'alice',
      requestedAt: '2026-09-08T00:00:00Z',
    },
    statusMessage: 'Awaiting deployment approval',
    ...overrides,
  });

const mockList = (data: ReturnType<typeof dep>[], total = data.length) => {
  vi.mocked(deploymentsApi.list).mockReset().mockResolvedValue({ data, total } as never);
};

beforeEach(() => {
  useAuthStore.setState({ user: { id: 1, username: 'bob', role: 'admin' } });
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AppDeploymentPage 部署审批流（DEP-04）', () => {
  it('待审批行渲染批准/拒绝按钮 + 待办 Alert + 审批徽标', async () => {
    mockList([pendingDep()]);
    render(<AppDeploymentPage applicationId="app-1" />);

    expect(await screen.findByText('批准')).toBeTruthy();
    expect(screen.getByText('拒绝')).toBeTruthy();
    // 审批待办 Alert（管理员文案，含第二人规则提示）
    expect(screen.getByText(/等待审批/)).toBeTruthy();
    expect(screen.getByText(/第二人规则/)).toBeTruthy();
    // 状态列审批徽标
    expect(screen.getByText('待审批')).toBeTruthy();
  });

  it('批准：调 approve 且成功后刷新列表', async () => {
    mockList([pendingDep()]);
    vi.mocked(deploymentsApi.approve).mockResolvedValue({} as never);
    render(<AppDeploymentPage applicationId="app-1" />);

    fireEvent.click(await screen.findByText('批准'));
    await waitFor(() => expect(vi.mocked(deploymentsApi.approve)).toHaveBeenCalledWith('dep-1'));
    expect(vi.mocked(deploymentsApi.list).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('第二人规则：提交者本人的请求，批准/拒绝禁用且出现撤回入口', async () => {
    mockList([pendingDep({ approvalMeta: { requestedBy: 1, requestedByName: 'bob' } })]);
    render(<AppDeploymentPage applicationId="app-1" />);

    const approveBtn = (await screen.findByText('批准')).closest('button')!;
    const rejectBtn = screen.getByText('拒绝').closest('button')!;
    expect(approveBtn.disabled).toBe(true);
    expect(rejectBtn.disabled).toBe(true);
    // 撤回入口仅提交者可见
    expect(screen.getByText('撤回')).toBeTruthy();
    // 第二人规则提示（Tooltip 不展开，验证按钮禁用即为该规则的前端表现）
    expect(approveBtn.getAttribute('disabled')).not.toBeNull();
  });

  it('非提交者不显示撤回入口（想否决走拒绝）', async () => {
    mockList([pendingDep()]);
    render(<AppDeploymentPage applicationId="app-1" />);
    await screen.findByText('批准');
    expect(screen.queryByText('撤回')).toBeNull();
  });

  it('拒绝：Modal 打开 → 填理由 → reject 载荷带 reason', async () => {
    mockList([pendingDep()]);
    vi.mocked(deploymentsApi.reject).mockResolvedValue({} as never);
    render(<AppDeploymentPage applicationId="app-1" />);

    fireEvent.click(await screen.findByText('拒绝'));
    const dialog = await screen.findByText('拒绝部署请求');
    expect(dialog).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('例如：未走变更评审'), {
      target: { value: '未走变更评审' },
    });
    fireEvent.click(screen.getByText('确认拒绝'));
    await waitFor(() =>
      expect(vi.mocked(deploymentsApi.reject)).toHaveBeenCalledWith('dep-1', '未走变更评审'),
    );
  });

  it('撤回：调 cancel（提交者本人出口）', async () => {
    mockList([pendingDep({ approvalMeta: { requestedBy: 1, requestedByName: 'bob' } })]);
    vi.mocked(deploymentsApi.cancel).mockResolvedValue({} as never);
    render(<AppDeploymentPage applicationId="app-1" />);

    fireEvent.click(await screen.findByText('撤回'));
    // Popconfirm 确认按钮 okText=撤销
    const okBtn = await screen.findByRole('button', { name: '撤 销' });
    fireEvent.click(okBtn);
    await waitFor(() => expect(vi.mocked(deploymentsApi.cancel)).toHaveBeenCalledWith('dep-1'));
  });

  it('已拒绝行：FAILED 状态 + 已拒绝徽标，无批准按钮', async () => {
    mockList([
      dep({
        status: 'failed',
        approvalStatus: 'rejected',
        approvalMeta: { requestedBy: 7, reason: 'no window' },
        statusMessage: 'Deployment rejected by bob: no window',
      }),
    ]);
    render(<AppDeploymentPage applicationId="app-1" />);

    await screen.findByText('失败');
    expect(screen.getByText('已拒绝')).toBeTruthy();
    expect(screen.queryByText('批准')).toBeNull();
  });

  it('普通用户：待审批行审批按钮禁用（RBAC 对齐 W3）', async () => {
    useAuthStore.setState({ user: { id: 3, username: 'dev', role: 'user' } });
    mockList([pendingDep()]);
    render(<AppDeploymentPage applicationId="app-1" />);

    const approveBtn = (await screen.findByText('批准')).closest('button')!;
    const rejectBtn = screen.getByText('拒绝').closest('button')!;
    expect(approveBtn.disabled).toBe(true);
    expect(rejectBtn.disabled).toBe(true);
  });
});
