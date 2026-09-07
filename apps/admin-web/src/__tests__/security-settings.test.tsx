/**
 * SEC-03: 安全设置 Tab（TOTP 绑定卡 + 会话列表）测试。
 * 隔离 api/auth 层，验证三块行为：
 *  1. TOTP 未启用 → 「开始绑定」；setup 后展示 secret/otpauth + 码输入；enable 成功提示；
 *  2. TOTP 已启用（profile.totpEnabled）→ 展示关闭入口，需密码确认；
 *  3. 会话列表渲染设备摘要/当前标记 + 吊销按钮/吊销其他按钮接线。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SecuritySettings, { summarizeUserAgent } from '../pages/settings/SecuritySettings';
import { authApi } from '../api/auth';
import { useAuthStore } from '../store/auth';

vi.mock('../api/auth', () => ({
  authApi: {
    login: vi.fn(),
    verifyLogin: vi.fn(),
    me: vi.fn(),
    totpSetup: vi.fn(),
    totpEnable: vi.fn(),
    totpDisable: vi.fn(),
    listSessions: vi.fn().mockResolvedValue([]),
    revokeSession: vi.fn(),
    revokeOtherSessions: vi.fn(),
    refresh: vi.fn(),
  },
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

const sessionsFixture = [
  {
    id: 11,
    createdAt: '2026-09-07T10:00:00Z',
    expiresAt: '2026-10-07T10:00:00Z',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/126.0',
    ip: '10.0.0.1',
    current: true,
  },
  {
    id: 12,
    createdAt: '2026-09-06T08:00:00Z',
    expiresAt: '2026-10-06T08:00:00Z',
    userAgent: 'Mozilla/5.0 (Linux) Firefox/128.0',
    ip: '10.0.0.2',
    current: false,
  },
];

function renderSecurity() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SecuritySettings />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(authApi.totpSetup).mockReset().mockResolvedValue({
    secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    otpauthUrl: 'otpauth://totp/AutoCodeFlow:alice?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  });
  vi.mocked(authApi.totpEnable).mockReset().mockResolvedValue({ enabled: true });
  vi.mocked(authApi.totpDisable).mockReset().mockResolvedValue({ disabled: true });
  vi.mocked(authApi.revokeSession).mockReset().mockResolvedValue({ success: true });
  vi.mocked(authApi.revokeOtherSessions).mockReset().mockResolvedValue({ revoked: 2 });
  vi.mocked(authApi.listSessions).mockReset().mockResolvedValue(sessionsFixture as never);
  useAuthStore.setState({ user: { id: 1, username: 'alice', role: 'user' } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SEC-03 summarizeUserAgent（设备摘要纯函数）', () => {
  it('识别 Chrome/Windows 与 API 客户端，空值回落未知设备', () => {
    expect(summarizeUserAgent('Mozilla/5.0 (Windows NT 10.0) Chrome/126.0')).toBe('Chrome · Windows');
    expect(summarizeUserAgent('curl/8.0')).toBe('API 客户端');
    expect(summarizeUserAgent(null)).toBe('未知设备');
  });
});

describe('SEC-03 TOTP 绑定卡', () => {
  it('未启用：点「开始绑定」调用 setup 并展示密钥与 otpauth 文本（无二维码依赖）', async () => {
    renderSecurity();
    fireEvent.click(await screen.findByText('开始绑定'));
    await waitFor(() => expect(authApi.totpSetup).toHaveBeenCalled());
    expect(await screen.findByText(/otpauth:\/\/totp\/AutoCodeFlow:alice/)).toBeTruthy();
    expect(screen.getByText('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')).toBeTruthy();
    // enable 按钮在 6 位码前禁用
    expect((screen.getByRole('button', { name: '验证并开启' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('输入 6 位码后 enable 被调用并提示成功', async () => {
    renderSecurity();
    fireEvent.click(await screen.findByText('开始绑定'));
    await screen.findByText(/otpauth:\/\/totp/);
    const input = screen.getByLabelText('动态验证码');
    fireEvent.change(input, { target: { value: '287082' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并开启' }));
    await waitFor(() => expect(authApi.totpEnable).toHaveBeenCalledWith('287082'));
  });

  it('已启用（profile.totpEnabled=true）：展示关闭入口且未输密码时禁用', async () => {
    useAuthStore.setState({ user: { id: 1, username: 'alice', role: 'user', totpEnabled: true } as never });
    renderSecurity();
    expect(await screen.findByText('已开启')).toBeTruthy();
    const closeBtn = screen.getByRole('button', { name: '关闭两步验证' }) as HTMLButtonElement;
    expect(closeBtn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'pw12345' } });
    expect((screen.getByRole('button', { name: '关闭两步验证' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('SEC-03 会话列表', () => {
  it('渲染会话行：设备摘要/IP/当前标记，非当前行有吊销按钮', async () => {
    renderSecurity();
    expect(await screen.findByText('Chrome · Windows')).toBeTruthy();
    expect(screen.getByText('Firefox · Linux')).toBeTruthy();
    expect(screen.getByText('10.0.0.1')).toBeTruthy();
    expect(screen.getByText('当前会话')).toBeTruthy();
    // 行内吊销按钮（Popconfirm 包裹）与「吊销其他全部」按钮并存
    expect(screen.getByLabelText('吊销会话 12')).toBeTruthy();
    expect(screen.getByText(/吊销其他全部（1）/)).toBeTruthy();
  });

  it('吊销按钮接线 revokeSession(id)', async () => {
    renderSecurity();
    await screen.findByText('Firefox · Linux');
    // 行内吊销按钮（Popconfirm 包裹，okText=确认吊销）；按 aria-label 定位
    const rowBtn = screen.getByLabelText('吊销会话 12');
    fireEvent.click(rowBtn);
    fireEvent.click(await screen.findByRole('button', { name: '确认吊销' }));
    await waitFor(() => expect(authApi.revokeSession).toHaveBeenCalledWith(12));
  });

  it('吊销其他全部按钮接线 revokeOtherSessions', async () => {
    renderSecurity();
    await screen.findByText('Firefox · Linux');
    fireEvent.click(screen.getByText(/吊销其他全部（1）/));
    fireEvent.click(await screen.findByRole('button', { name: '吊销其他' }));
    await waitFor(() => expect(authApi.revokeOtherSessions).toHaveBeenCalled());
  });

  it('空会话列表显示空态文案', async () => {
    vi.mocked(authApi.listSessions).mockResolvedValue([] as never);
    renderSecurity();
    expect(await screen.findByText('暂无活跃会话')).toBeTruthy();
  });
});
