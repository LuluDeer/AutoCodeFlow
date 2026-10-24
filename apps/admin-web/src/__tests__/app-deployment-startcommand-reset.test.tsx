/**
 * A-4 披露（部署模型评审 2026-10-23 §9.3-2 收口）回归：
 *  升级推送的 entrypoint = 当前 app.entrypoint（app-deployment.service.ts:1811
 *  的 A-4 决策——修复陈旧快照压住新 entrypoint），行上与它不同的 startCommand
 *  （部署时自定义）会被重置。升级确认 Modal 必须点名这些行，否则用户以为
 *  自定义命令仍在生效。
 *  ① 行上有自定义 startCommand（≠ appEntrypoint）→ Modal 出现警示 Alert，
 *     title 带台数、desc 带行号与原命令；
 *  ② 行上 startCommand 与 appEntrypoint 相同（部署时未自定义）→ 不渲染
 *     披露（不打扰）；
 *  ③ appEntrypoint 未传（旧调用方/应用无 entrypoint）→ 不渲染（无对比基准，
 *     不臆造披露）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import AppDeploymentPage from '../pages/AppDeploymentPage';
import { deploymentsApi } from '../api/applications';
import { executorsApi } from '../api/executors';
import { useAuthStore } from '../store/auth';

vi.mock('../api/applications', () => ({
  deploymentsApi: { list: vi.fn(), deploy: vi.fn(), stop: vi.fn(), upgrade: vi.fn() },
  applicationsApi: { upgradeAll: vi.fn() },
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn(), picker: vi.fn() },
}));

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

const deploymentWith = (over: Record<string, unknown>) => ({
  id: 'd1',
  applicationId: 'app-1',
  executorAddress: '10.0.0.1',
  status: 'running',
  runMode: 'daemon',
  startCommand: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});

beforeEach(() => {
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  vi.mocked(executorsApi.picker)
    .mockReset()
    .mockResolvedValue({ items: [], total: 0, truncated: false, limit: 2000 } as never);
});

/** 打开「升级所有」策略 Modal（admin 按钮 → rollout Modal）。 */
async function openRolloutModal() {
  await waitFor(() => expect(screen.getByRole('button', { name: /升级所有/ })).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: /升级所有/ }));
  await waitFor(() => expect(screen.getByText(/将覆盖/)).toBeTruthy());
}

describe('A-4 披露：升级会重置部署时自定义的启动命令', () => {
  it('① 自定义 startCommand 行被点名（台数 + 行号 + 原命令 + 新 entrypoint）', async () => {
    vi.mocked(deploymentsApi.list).mockReset().mockResolvedValue({
      data: [
        deploymentWith({ id: 'dep-custom-1', startCommand: 'python run.py --port 8080' }),
        deploymentWith({ id: 'dep-custom-2', startCommand: 'sh custom.sh' }),
      ],
      total: 2,
    } as never);
    render(<AppDeploymentPage applicationId="app-1" appEntrypoint="python main.py" />);
    await openRolloutModal();
    const alert = screen.getByText('2 台设备部署时自定义的启动命令将被重置');
    expect(alert).toBeTruthy();
    const desc = screen.getByText(/升级推送的启动命令取应用当前入口/);
    expect(desc.textContent).toContain('python main.py');
    expect(desc.textContent).toContain('python run.py --port 8080');
    expect(desc.textContent).toContain('sh custom.sh');
  });

  it('② 行上命令与 appEntrypoint 相同（未自定义）→ 不渲染披露', async () => {
    vi.mocked(deploymentsApi.list).mockReset().mockResolvedValue({
      data: [deploymentWith({ id: 'dep-same', startCommand: 'python main.py' })],
      total: 1,
    } as never);
    render(<AppDeploymentPage applicationId="app-1" appEntrypoint="python main.py" />);
    await openRolloutModal();
    expect(screen.queryByText(/自定义的启动命令将被重置/)).toBeNull();
  });

  it('③ appEntrypoint 未传 → 不渲染（无基准不臆造）', async () => {
    vi.mocked(deploymentsApi.list).mockReset().mockResolvedValue({
      data: [deploymentWith({ id: 'dep-x', startCommand: 'anything' })],
      total: 1,
    } as never);
    render(<AppDeploymentPage applicationId="app-1" />);
    await openRolloutModal();
    expect(screen.queryByText(/自定义的启动命令将被重置/)).toBeNull();
  });
});
