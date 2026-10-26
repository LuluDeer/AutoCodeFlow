/**
 * R2（部署模型评审 §4.4，2026-10-24）回归：upgrade-all 覆盖面显式化。
 *
 * 旧实现：handleUpgradeAll 以 runningCount===0 拦截、成功提示只报
 * succeeded/total——stopped/在途设备被静默略过，用户以为「全部升完了」。
 * 修复：
 *   · 前置统计按部署行状态分组（运行/仅部署/已停止/在途）——「仅部署
 *     （scheduled）」行实证稳态即 RUNNING，与运行行同属默认覆盖；
 *   · 弹窗如实前置「将覆盖 M 台设备（运行 X + 仅部署 Y…）」+「包含已停止
 *     的部署」开关（默认关，仅全量策略）；
 *   · 结果侧消费新 coverage/skipped 字段：skipped 非空弹 warning 列明细，
 *     存在 stopped 未覆盖时给 info 提示。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor, screen, fireEvent } from '@testing-library/react';
import AppDeploymentPage from '../pages/AppDeploymentPage';
import { deploymentsApi, applicationsApi } from '../api/applications';
import { executorsApi } from '../api/executors';
import { useAuthStore } from '../store/auth';

vi.mock('../api/applications', () => ({
  deploymentsApi: { list: vi.fn(), deploy: vi.fn(), stop: vi.fn(), upgrade: vi.fn(), cancel: vi.fn(), remove: vi.fn() },
  applicationsApi: { upgradeAll: vi.fn() },
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

const baseRow = (overrides: Record<string, unknown>) => ({
  id: 'd-x',
  applicationId: 'app-1',
  executorAddress: '10.0.0.9',
  status: 'running',
  runMode: 'daemon',
  createdAt: '2026-09-20T09:00:00Z',
  updatedAt: '2026-09-21T09:00:00Z',
  ...overrides,
});

const mixedDeployments = [
  baseRow({ id: 'd-daemon', runMode: 'daemon', status: 'running' }),
  baseRow({ id: 'd-sched', runMode: 'scheduled', status: 'running' }),
  baseRow({ id: 'd-stopped', runMode: 'daemon', status: 'stopped' }),
  baseRow({ id: 'd-inflight', runMode: 'daemon', status: 'deploying' }),
];

const openRolloutModal = async () => {
  render(<AppDeploymentPage applicationId="app-1" />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /升级所有|Upgrade all/ })).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole('button', { name: /升级所有|Upgrade all/ }));
  await waitFor(() => expect(screen.getByText(/全量升级|Full rollout/)).toBeTruthy());
};

describe('R2 §4.4 upgrade-all 覆盖面显式化', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
    vi.mocked(executorsApi.picker).mockReset().mockResolvedValue({ items: [], total: 0, truncated: false, limit: 2000 } as never);
    vi.mocked(deploymentsApi.list)
      .mockReset()
      .mockResolvedValue({ data: mixedDeployments, total: mixedDeployments.length } as never);
    vi.mocked(applicationsApi.upgradeAll).mockReset();
  });

  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('zh/en 双语都有覆盖面提示/开关/跳过原因键', async () => {
    const zh = (await import('../locales/zh')).default as Record<string, string>;
    const en = (await import('../locales/en')).default as Record<string, string>;
    for (const dict of [zh, en]) {
      for (const key of [
        'appDeploy.msg.nothingToUpgrade',
        'appDeploy.msg.upgradeAllSkipped',
        'appDeploy.msg.upgradeAllStoppedHint',
        'appDeploy.skipReason.inFlight',
        'appDeploy.skipReason.awaitingApproval',
        'appDeploy.rollout.coverageLead',
        'appDeploy.rollout.coverageRunning',
        'appDeploy.rollout.coverageScheduled',
        'appDeploy.rollout.coverageStopped',
        'appDeploy.rollout.includeStopped',
        'appDeploy.rollout.includeStoppedHint',
      ]) {
        expect(dict[key], key).toBeTruthy();
      }
    }
  });

  it('弹窗按分组如实预览「将覆盖 2 台设备：运行 1 + 仅部署 1」；默认不开 includeStopped', async () => {
    await openRolloutModal();

    await waitFor(() =>
      expect(screen.getByText(/将覆盖 2 台已部署设备|Will cover 2 deployed/)).toBeTruthy(),
    );
    expect(screen.getByText(/运行 1 台/, { exact: false })).toBeTruthy();
    expect(screen.getByText(/仅部署 1 台/, { exact: false })).toBeTruthy();

    vi.mocked(applicationsApi.upgradeAll).mockResolvedValue({
      ok: true, total: 2, succeeded: 2, failed: 0,
      coverage: { running: 1, scheduled: 1, stopped: 1, failed: 0, inFlight: 1 },
      skipped: [],
    } as never);
    fireEvent.click(screen.getByRole('button', { name: /确认升级|Confirm upgrade|OK/ }));

    await waitFor(() => expect(applicationsApi.upgradeAll).toHaveBeenCalledTimes(1));
    const args = vi.mocked(applicationsApi.upgradeAll).mock.calls[0];
    // 默认：rollout undefined + includeStopped undefined（不扩覆盖，body 保持 {}）
    expect(args[1]).toBeUndefined();
    expect(args[2]).toBeUndefined();
  });

  it('勾选「包含已停止」后 includeStopped 透传；结果 skipped 非空时 warning 列在途明细', async () => {
    await openRolloutModal();

    // 全量策略默认勾选态下渲染开关；勾上后覆盖预览把 stopped 计入
    // （用 role 定位：上例遗留的 antd message 文案与本开关 label 同名）
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() =>
      expect(screen.getByText(/将覆盖 3 台已部署设备|Will cover 3 deployed/)).toBeTruthy(),
    );

    vi.mocked(applicationsApi.upgradeAll).mockResolvedValue({
      ok: true, total: 3, succeeded: 2, failed: 1,
      coverage: { running: 1, scheduled: 1, stopped: 1, failed: 0, inFlight: 1 },
      skipped: [
        { deploymentId: 'd-inflight-aaaaaaaaaaaa', executorId: null, status: 'deploying', reason: 'in_flight' },
      ],
    } as never);
    fireEvent.click(screen.getByRole('button', { name: /确认升级|Confirm upgrade|OK/ }));

    await waitFor(() => expect(applicationsApi.upgradeAll).toHaveBeenCalledTimes(1));
    const args = vi.mocked(applicationsApi.upgradeAll).mock.calls[0];
    expect(args[2]).toBe(true);

    // skipped 明细如实透出（在途行没被升级，不能被 success 文案掩盖）
    await waitFor(() =>
      expect(screen.getByText(/已跳过 1 台在途部署|Skipped 1 in-flight/)).toBeTruthy(),
    );
    expect(screen.getByText(/在途（deploying）|in flight \(deploying\)/)).toBeTruthy();
  });

  it('stopped-only 场景：入口按钮仍可见（可 opt-in），未勾选时零覆盖被拦截并如实提示分组计数', async () => {
    vi.mocked(deploymentsApi.list).mockResolvedValue({
      data: [baseRow({ id: 'd-stopped', status: 'stopped' })],
      total: 1,
    } as never);
    await openRolloutModal();
    // 预览为 0 台（未勾选 includeStopped），开关可见
    await waitFor(() =>
      expect(screen.getByText(/将覆盖 0 台已部署设备|Will cover 0 deployed/)).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole('button', { name: /确认升级|Confirm upgrade|OK/ }));

    // 覆盖面为 0：前置拦截生效——不发请求，提示里如实带出 stopped 计数
    await waitFor(() =>
      expect(screen.getByText(/已停止 1 台，在途 0 台|{{stopped}} stopped/)).toBeTruthy(),
    );
    expect(applicationsApi.upgradeAll).not.toHaveBeenCalled();
  });
});
