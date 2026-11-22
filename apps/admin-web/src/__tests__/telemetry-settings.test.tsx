/**
 * R311：TTFV 授权设置 Tab 组件测试。
 * 覆盖：状态渲染（总闸/count/安装行）、consent 参数（true/false + source）、
 * Popconfirm 取消不写入、mutation 成功后 status 重取、加载失败错误态。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TelemetrySettings from '../pages/settings/TelemetrySettings';
import { agentApi } from '../api/agent';

vi.mock('../api/agent', () => ({
  agentApi: {
    telemetryStatus: vi.fn(),
    telemetryConsent: vi.fn(),
  },
}));

// R312：auth store 可控主体（参照 projects-page.test.tsx）。默认 admin 保持
// 既有 7 例绿；非 admin 用例单独切换 role='user' 验证降级分支。
const authState: { user: { id: number; role?: string } | null } = {
  user: { id: 1, role: 'admin' },
};
vi.mock('../store/auth', () => ({
  isAdminUser: (u: { role?: string } | null | undefined) => u?.role === 'admin',
  useAuthStore: (sel: (s: unknown) => unknown) => sel(authState),
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
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const CONSENT_RESULT = {
  systemEnabled: true,
  optedIn: true,
  installIds: ['inst-alpha'],
  count: 1,
  source: 'admin-ui',
};

const ON_STATUS = {
  systemEnabled: true,
  count: 1,
  knownExecutorCount: 1,
  coverage: 'full',
  latestOptedAt: '2026-11-20T10:00:00.000Z',
  installs: [
    {
      installId: 'inst-alpha',
      optIn: true,
      optedAt: '2026-11-20T10:00:00.000Z',
      // 哈希会随 status 响应返回，但界面不得把它展示给用户。
      userIdHash: 'userhash-secret-must-not-render',
      source: 'admin-ui',
    },
  ],
};

const OFF_STATUS = {
  systemEnabled: false,
  count: 0,
  knownExecutorCount: 0,
  coverage: 'gate_off',
  latestOptedAt: null,
  installs: [],
};

/** R329 B2：总闸开 + 0 executor —— 静默零采集的反面教材。 */
const NO_EXECUTOR_STATUS = {
  systemEnabled: true,
  count: 0,
  knownExecutorCount: 0,
  coverage: 'no_executors',
  latestOptedAt: null,
  installs: [],
};

const PARTIAL_STATUS = {
  systemEnabled: true,
  count: 2,
  knownExecutorCount: 3,
  coverage: 'partial',
  latestOptedAt: '2026-11-20T10:00:00.000Z',
  installs: [
    { installId: 'inst-a', optIn: true, optedAt: '2026-11-20T10:00:00.000Z', userIdHash: null, source: 'admin-ui' },
    { installId: 'inst-b', optIn: true, optedAt: '2026-11-20T10:00:00.000Z', userIdHash: null, source: 'api' },
  ],
};

const FULL_STATUS = {
  systemEnabled: true,
  count: 2,
  knownExecutorCount: 2,
  coverage: 'full',
  latestOptedAt: '2026-11-20T10:00:00.000Z',
  installs: PARTIAL_STATUS.installs,
};

const GATE_OFF_STATUS = {
  systemEnabled: false,
  count: 0,
  knownExecutorCount: 3,
  coverage: 'gate_off',
  latestOptedAt: null,
  installs: [],
};

function renderTelemetry() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TelemetrySettings />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // 每个用例回到 admin 主体，避免上一个非 admin 用例的 role 泄漏到后续用例。
  authState.user = { id: 1, role: 'admin' };
  vi.mocked(agentApi.telemetryStatus).mockReset().mockResolvedValue(ON_STATUS as never);
  vi.mocked(agentApi.telemetryConsent).mockReset().mockResolvedValue(CONSENT_RESULT as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('R311 TTFV 授权设置', () => {
  it('渲染总闸状态、授权数与安装行，且不展示 userIdHash', async () => {
    renderTelemetry();
    expect(await screen.findByText('inst-alpha')).toBeTruthy();
    expect(screen.getByText('已开启')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
    expect(screen.getByText('管理界面')).toBeTruthy();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByText('userhash-secret-must-not-render')).toBeNull();
  });

  it('总闸关闭且无安装时显示关闭态与空表文案', async () => {
    vi.mocked(agentApi.telemetryStatus).mockResolvedValue(OFF_STATUS as never);
    renderTelemetry();
    expect(await screen.findByText('已关闭')).toBeTruthy();
    expect(screen.getByText('暂无安装授权记录')).toBeTruthy();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  it('开启开关并确认 → consent({optIn:true, source:"admin-ui"})', async () => {
    vi.mocked(agentApi.telemetryStatus).mockResolvedValue(OFF_STATUS as never);
    renderTelemetry();
    // 「已关闭」在加载中也会显示（默认态），先等 status 数据落地、Switch 解除禁用。
    await waitFor(() => expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText('已关闭')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch'));
    expect(await screen.findByText('确认参与匿名统计？')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /确\s*认/ }));
    await waitFor(() =>
      expect(agentApi.telemetryConsent).toHaveBeenCalledWith({ optIn: true, source: 'admin-ui' }),
    );
  });

  it('关闭开关并确认 → consent({optIn:false, source:"admin-ui"})', async () => {
    renderTelemetry();
    await screen.findByText('inst-alpha');
    fireEvent.click(screen.getByRole('switch'));
    expect(await screen.findByText('确认撤销匿名统计授权？')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /确\s*认/ }));
    await waitFor(() =>
      expect(agentApi.telemetryConsent).toHaveBeenCalledWith({ optIn: false, source: 'admin-ui' }),
    );
  });

  it('Popconfirm 取消不调用 consent', async () => {
    renderTelemetry();
    await screen.findByText('inst-alpha');
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(await screen.findByRole('button', { name: /取\s*消/ }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /确\s*认/ })).toBeNull());
    expect(agentApi.telemetryConsent).not.toHaveBeenCalled();
  });

  it('mutation 成功后 invalidate status query 并重取', async () => {
    renderTelemetry();
    await screen.findByText('inst-alpha');
    expect(agentApi.telemetryStatus).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(await screen.findByRole('button', { name: /确\s*认/ }));
    await waitFor(() => expect(agentApi.telemetryConsent).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(agentApi.telemetryStatus).toHaveBeenCalledTimes(2));
  });

  it('status 请求失败时显示页内错误态（可重试）', async () => {
    vi.mocked(agentApi.telemetryStatus).mockRejectedValue(new Error('后端不可达'));
    renderTelemetry();
    expect(await screen.findByText('授权状态加载失败')).toBeTruthy();
    expect(screen.queryByText('暂无安装授权记录')).toBeNull();
  });

  // R312：非管理员降级——不发会 403 的 status 查询，只渲染 adminOnly 提示。
  it('非管理员：不发 status 请求、渲染 adminOnly 提示、无 Switch/表格', async () => {
    authState.user = { id: 1, role: 'user' };
    renderTelemetry();
    expect(await screen.findByText('仅管理员可查看/设置 TTFV 匿名统计授权')).toBeTruthy();
    expect(agentApi.telemetryStatus).not.toHaveBeenCalled();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  // ── R329 B2：systemEnabled=true/count=0 的静默零采集，必须在 UI 上可见 ──
  it('R329 no_executors：warning 告警 + 重授权按钮，点击触发全量重授权', async () => {
    vi.mocked(agentApi.telemetryStatus).mockResolvedValue(NO_EXECUTOR_STATUS as never);
    renderTelemetry();
    const alert = await screen.findByTestId('telemetry-coverage-alert');
    expect(alert.getAttribute('class')).toContain('ant-alert-warning');
    expect(screen.getByText(/北极星不会采集数据/)).toBeTruthy();
    expect(screen.getByTestId('telemetry-coverage-value').textContent).toBe('0 / 0');
    fireEvent.click(screen.getByTestId('telemetry-reauthorize-btn'));
    await waitFor(() =>
      expect(agentApi.telemetryConsent).toHaveBeenCalledWith({ optIn: true, source: 'admin-ui' }),
    );
    await waitFor(() => expect(agentApi.telemetryStatus).toHaveBeenCalledTimes(2));
  });

  it('R329 partial：info 提示（已授权 X / 已知 Y）+ 覆盖率 2/3', async () => {
    vi.mocked(agentApi.telemetryStatus).mockResolvedValue(PARTIAL_STATUS as never);
    renderTelemetry();
    const alert = await screen.findByTestId('telemetry-coverage-alert');
    expect(alert.getAttribute('class')).toContain('ant-alert-info');
    expect(screen.getByText(/部分执行器未授权/)).toBeTruthy();
    expect(screen.getByText(/已授权 2 \/ 已知 3/)).toBeTruthy();
    expect(screen.getByTestId('telemetry-coverage-value').textContent).toBe('2 / 3');
  });

  it('R329 full：无异常告警，覆盖率行仍在（2/2）', async () => {
    vi.mocked(agentApi.telemetryStatus).mockResolvedValue(FULL_STATUS as never);
    renderTelemetry();
    // 覆盖率行加载中也渲染（不隐藏），所以要等数据落地后再断言数值。
    await waitFor(() => expect(screen.getByTestId('telemetry-coverage-value').textContent).toBe('2 / 2'));
    expect(screen.queryByTestId('telemetry-coverage-alert')).toBeNull();
    expect(screen.queryByTestId('telemetry-reauthorize-btn')).toBeNull();
  });

  it('R329 gate_off：无异常告警，覆盖率行仍在（0/3）', async () => {
    vi.mocked(agentApi.telemetryStatus).mockResolvedValue(GATE_OFF_STATUS as never);
    renderTelemetry();
    await waitFor(() => expect(screen.getByTestId('telemetry-coverage-value').textContent).toBe('0 / 3'));
    expect(screen.queryByTestId('telemetry-coverage-alert')).toBeNull();
  });

  it('R329 非管理员：覆盖率告警与重授权入口均随既有降级不渲染', async () => {
    authState.user = { id: 1, role: 'user' };
    renderTelemetry();
    expect(await screen.findByText('仅管理员可查看/设置 TTFV 匿名统计授权')).toBeTruthy();
    expect(screen.queryByTestId('telemetry-coverage-alert')).toBeNull();
    expect(screen.queryByTestId('telemetry-reauthorize-btn')).toBeNull();
    expect(screen.queryByTestId('telemetry-coverage-value')).toBeNull();
  });
});
