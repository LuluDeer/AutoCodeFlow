/**
 * A-8（灰度谎报成功）回归：后端 upgrade-all 在灰度被互斥拒绝（同应用已有
 * 在途批次等）时返回 **200 + ok:false + rollout.blockedReason**——不是 HTTP
 * 错误。旧实现不看 ok 恒 message.success，用户以为灰度已启动。
 *
 * 修复：按 result.ok 分支——ok=false 读 blockedReason 弹 warning（文案把
 * blockedReason 拼进去，i18n 双语键 appDeploy.msg.upgradeAllBlocked）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor, screen, fireEvent } from '@testing-library/react';
import AppDeploymentPage from '../pages/AppDeploymentPage';
import { deploymentsApi, applicationsApi } from '../api/applications';
import { executorsApi } from '../api/executors';
import { useAuthStore } from '../store/auth';

vi.mock('../api/applications', () => ({
  deploymentsApi: { list: vi.fn(), deploy: vi.fn(), stop: vi.fn(), upgrade: vi.fn(), cancel: vi.fn(), remove: vi.fn() },
  applicationsApi: { upgradeAll: vi.fn().mockResolvedValue({ ok: true, total: 1, succeeded: 1, failed: 0 }) },
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn(), picker: vi.fn() },
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

const BLOCKED_REASON =
  'another rollout batch is in flight for this application (1 row(s) pending/probing, owner=host-a:1)';

const triggerUpgradeAll = async () => {
  render(<AppDeploymentPage applicationId="app-1" />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /升级所有|Upgrade all/ })).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole('button', { name: /升级所有|Upgrade all/ }));
  await waitFor(() => expect(screen.getByText(/灰度 20%|Canary 20%/)).toBeTruthy());
  fireEvent.click(screen.getByText(/灰度 20%|Canary 20%/));
  fireEvent.click(screen.getByRole('button', { name: /确认|OK/ }));
  await waitFor(() => expect(applicationsApi.upgradeAll).toHaveBeenCalledTimes(1));
};

describe('A-8 灰度结果如实提示', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
    vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
    vi.mocked(executorsApi.picker).mockReset().mockResolvedValue({ items: [], total: 0, truncated: false, limit: 2000 } as never);
    vi.mocked(deploymentsApi.list)
      .mockReset()
      .mockResolvedValue({ data: [runningDeployment], total: 1 } as never);
    vi.mocked(applicationsApi.upgradeAll).mockReset();
  });

  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('zh/en 双语都有 blocked 提示键', async () => {
    const zh = (await import('../locales/zh')).default as Record<string, string>;
    const en = (await import('../locales/en')).default as Record<string, string>;
    for (const dict of [zh, en]) {
      expect(dict['appDeploy.msg.upgradeAllBlocked']).toContain('{{reason}}');
    }
  });

  it('ok:false → 弹 warning 且 blockedReason 拼进文案，不弹 success', async () => {
    vi.mocked(applicationsApi.upgradeAll).mockResolvedValue({
      ok: false,
      total: 2,
      succeeded: 0,
      failed: 0,
      rollout: { batchId: 'rollout-1', blockedReason: BLOCKED_REASON },
    } as never);

    await triggerUpgradeAll();

    // warning 出现，且后端原因对用户可见（不是笼统的「失败」）
    await waitFor(() =>
      expect(
        screen.getByText(new RegExp(`灰度发布未启动.*${'another rollout batch'}|Rollout not started.*${'another rollout batch'}`)),
      ).toBeTruthy(),
    );
    // 不出现成功文案（旧实现恒报成功——正是本缺陷）
    expect(screen.queryByText(/已触发 .* 个实例升级|Triggered upgrade for/)).toBeNull();
  });

  it('ok:true → 仍弹 success（不回归）', async () => {
    vi.mocked(applicationsApi.upgradeAll).mockResolvedValue({
      ok: true,
      total: 2,
      succeeded: 2,
      failed: 0,
    } as never);

    await triggerUpgradeAll();

    await waitFor(() =>
      expect(screen.getByText(/已触发 2\/2 个实例升级|Triggered upgrade for 2\/2/)).toBeTruthy(),
    );
  });
});
