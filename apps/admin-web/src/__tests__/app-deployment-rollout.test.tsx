/**
 * P1-9（UX-AUDIT-2026-09-21）回归：灰度发布终于有入口了。
 *
 * 旧实现：后端 upgrade-all 早已支持 body.rollout（canary/percentage），但前端
 * applicationsApi.upgradeAll 不带 body——「全部升级」只能全量，灰度发布在 UI
 * 上没有任何入口，部署表也不展示灰度阶段。修复：
 *   · 「全部升级」改为策略 Modal（全量 / 灰度 20%），把 rollout 透传后端；
 *   · 部署状态列加灰度阶段 Tag（pending/probing/promoted/failed/rolled_back）。
 *
 * 修复前：upgradeAll 只收 id、不带 body；页面是 Popconfirm 无策略选项——
 * 本测试点击「全部升级」找不到策略 Radio（红）；修复后转绿。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor, screen, fireEvent } from '@testing-library/react';
import AppDeploymentPage from '../pages/AppDeploymentPage';
import { deploymentsApi, applicationsApi } from '../api/applications';
import { executorsApi } from '../api/executors';
import { useAuthStore } from '../store/auth';

vi.mock('../api/applications', () => ({
  deploymentsApi: { list: vi.fn(), deploy: vi.fn(), stop: vi.fn(), upgrade: vi.fn(), cancel: vi.fn() },
  applicationsApi: { upgradeAll: vi.fn().mockResolvedValue({ ok: true, total: 1, succeeded: 1, failed: 0 }) },
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn() },
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

const runningDeployment = {
  id: 'd-run',
  applicationId: 'app-1',
  executorAddress: '10.0.0.9',
  status: 'running',
  runMode: 'daemon',
  createdAt: '2026-09-20T09:00:00Z',
  updatedAt: '2026-09-21T09:00:00Z',
};

describe('P1-9 灰度发布入口', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
    vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
    vi.mocked(deploymentsApi.list)
      .mockReset()
      .mockResolvedValue({ data: [runningDeployment], total: 1 } as never);
    vi.mocked(applicationsApi.upgradeAll).mockClear();
  });

  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('zh/en 双语都有灰度策略与灰度阶段的 i18n 键', async () => {
    const zh = (await import('../locales/zh')).default as Record<string, string>;
    const en = (await import('../locales/en')).default as Record<string, string>;
    for (const dict of [zh, en]) {
      expect(dict['appDeploy.rollout.modalTitle']).toBeTruthy();
      expect(dict['appDeploy.rollout.full']).toBeTruthy();
      expect(dict['appDeploy.rollout.canary']).toBeTruthy();
      for (const s of ['pending', 'probing', 'promoted', 'failed', 'rolledBack']) {
        expect(dict[`appDeploy.rollout.state.${s}`]).toBeTruthy();
      }
    }
  });

  it('点「全部升级」弹出策略选择；选灰度 20% 后 upgradeAll 带上 rollout body', async () => {
    render(<AppDeploymentPage applicationId="app-1" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /升级所有|Upgrade all/ })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: /升级所有|Upgrade all/ }));

    // 策略 Modal 出现两个选项
    await waitFor(() =>
      expect(screen.getByText(/灰度 20%|Canary 20%/)).toBeTruthy(),
    );
    expect(screen.getByText(/全量升级|Full rollout/)).toBeTruthy();

    // 选灰度
    fireEvent.click(screen.getByText(/灰度 20%|Canary 20%/));
    // 确认
    fireEvent.click(screen.getByRole('button', { name: /确认|OK/ }));

    await waitFor(() => expect(applicationsApi.upgradeAll).toHaveBeenCalledTimes(1));
    const [appId, rollout] = vi.mocked(applicationsApi.upgradeAll).mock.calls[0];
    expect(appId).toBe('app-1');
    // 关键断言：旧实现这里没有第二参（无 body）
    expect(rollout).toEqual({ strategy: 'canary', percentage: 20 });
  });

  it('部署行带 rolloutState=probing 时状态列显示灰度阶段 Tag', async () => {
    vi.mocked(deploymentsApi.list).mockResolvedValue({
      data: [{ ...runningDeployment, id: 'd-canary', rolloutState: 'probing' }],
      total: 1,
    } as never);
    render(<AppDeploymentPage applicationId="app-1" />);
    await waitFor(() =>
      expect(screen.getByText(/灰度观察中|Canary observing/)).toBeTruthy(),
    );
  });
});
