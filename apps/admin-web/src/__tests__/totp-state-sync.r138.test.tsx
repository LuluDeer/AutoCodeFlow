/**
 * R138-A1（数据层审计 · 轴 1）：TOTP 开启/关闭后的**数据源同步**。
 *
 * 缺陷（已证明存在）：`SecuritySettings` 的 enable/disable 成功后只做了
 * `qc.invalidateQueries({ queryKey: ['auth-profile'] })`——但**全仓没有任何**
 * `queryKey: ['auth-profile']` 的查询（profile 的真实来源是 zustand
 * `useAuthStore.user`，由 MainLayout 的 `authApi.me()` 写入）。于是这条失效
 * 是**静默空操作**：开关两边都不报错，卡片却仍然停在「未启用 / 开始绑定」，
 * 直到用户整页刷新（MainLayout 的 profile 同步只在 role 缺失时才跑，开启 TOTP
 * 不触发它）。用户刚看到的「两步验证已开启」toast 与卡片现状自相矛盾。
 *
 * 修法：写后同步**真实数据源**（store 的 user.totpEnabled），与其它页
 * 「写后失效列表/详情」同一纪律，只是这里的"缓存"是 store。
 *
 * 反证：
 *  ① 去掉 onSuccess 里的 store 同步 → 前两条用例变红（卡片停在旧态）；
 *  ② 让失败路径也写 store → 第三条用例（失败不得污染状态）变红。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SecuritySettings from '../pages/settings/SecuritySettings';
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

function renderSecurity() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SecuritySettings />
    </QueryClientProvider>,
  );
}

const userWithoutTotp = { id: 1, username: 'alice', role: 'user' };
const userWithTotp = { id: 1, username: 'alice', role: 'user', totpEnabled: true };

beforeEach(() => {
  vi.mocked(authApi.totpSetup).mockReset().mockResolvedValue({
    secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    otpauthUrl: 'otpauth://totp/AutoCodeFlow:alice?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  } as never);
  vi.mocked(authApi.totpEnable).mockReset().mockResolvedValue({ enabled: true } as never);
  vi.mocked(authApi.totpDisable).mockReset().mockResolvedValue({ disabled: true } as never);
  vi.mocked(authApi.listSessions).mockReset().mockResolvedValue([] as never);
  useAuthStore.setState({ user: userWithoutTotp as never });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('R138-A1 TOTP 写后必须同步真实数据源（store.user.totpEnabled）', () => {
  it('enable 成功 → 卡片立刻切到「已开启」，不必整页刷新', async () => {
    renderSecurity();
    fireEvent.click(await screen.findByText('开始绑定'));
    await screen.findByText(/otpauth:\/\/totp/);
    fireEvent.change(screen.getByLabelText('动态验证码'), { target: { value: '287082' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并开启' }));

    await waitFor(() => expect(authApi.totpEnable).toHaveBeenCalledWith('287082'));
    // 真实数据源被写回（否则「auth-profile」那条失效是空操作，卡片停在旧态）
    await waitFor(() =>
      expect((useAuthStore.getState().user as { totpEnabled?: boolean }).totpEnabled).toBe(true),
    );
    // UI 表现：已启用分支（关闭入口）出现
    expect(await screen.findByText('已开启')).toBeTruthy();
    expect(screen.getByRole('button', { name: '关闭两步验证' })).toBeTruthy();
  });

  it('disable 成功 → 卡片回到「开始绑定」，store 同步为 false', async () => {
    useAuthStore.setState({ user: userWithTotp as never });
    renderSecurity();
    fireEvent.change(await screen.findByLabelText('确认密码'), { target: { value: 'pw12345' } });
    fireEvent.click(screen.getByRole('button', { name: '关闭两步验证' }));
    // Popconfirm 的确认键：antd 会在两个中文字符间插空格（「关 闭」），
    // 按 role/name 取不到——沿用仓库既有写法（notification-silences /
    // settings.history-rollback）：先等弹层出现，再取层内最后一个按钮。
    const confirmText = await screen.findByText('确认关闭两步验证？');
    const layer = (confirmText.closest('.ant-popover') ??
      confirmText.closest('[class*="popconfirm"]') ??
      document.body) as HTMLElement;
    const layerBtns = Array.from(layer.querySelectorAll('button')) as HTMLButtonElement[];
    fireEvent.click(layerBtns[layerBtns.length - 1] as HTMLButtonElement);

    await waitFor(() => expect(authApi.totpDisable).toHaveBeenCalledWith({ password: 'pw12345' }));
    await waitFor(() =>
      expect((useAuthStore.getState().user as { totpEnabled?: boolean }).totpEnabled).toBe(false),
    );
    expect(await screen.findByText('开始绑定')).toBeTruthy();
  });

  it('钉子：enable 失败（动态码错误）不得把 UI/store 停在「已成功」', async () => {
    vi.mocked(authApi.totpEnable).mockRejectedValueOnce(new Error('invalid code'));
    renderSecurity();
    fireEvent.click(await screen.findByText('开始绑定'));
    await screen.findByText(/otpauth:\/\/totp/);
    fireEvent.change(screen.getByLabelText('动态验证码'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并开启' }));

    await waitFor(() => expect(authApi.totpEnable).toHaveBeenCalled());
    // 失败不写 store、也不切到已启用分支（仍是绑定流程）
    expect((useAuthStore.getState().user as { totpEnabled?: boolean })?.totpEnabled).toBeFalsy();
    expect(screen.queryByText('已开启')).toBeNull();
    expect(await screen.findByText(/otpauth:\/\/totp/)).toBeTruthy();
  });
});
