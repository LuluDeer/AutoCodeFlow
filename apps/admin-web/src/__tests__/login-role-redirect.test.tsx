/**
 * 登录成功落地页：普通密码登录与 TOTP 第二段登录共用 completeLogin，
 * 无 ?redirect= 时：role 已确定则按 homePathForRole(role) 落到角色首页；
 * role 未随登录响应返回则先回壳层索引路由，由 profile 补全后 RoleHomeRedirect 再决定：
 * - admin -> /dashboard
 * - user  -> /workbench
 * 同时保留既有 ?redirect= 站内回跳优先级。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import LoginPage from '../pages/LoginPage';
import { RoleHomeRedirect } from '../layouts/RoleHomeRedirect';
import { authApi } from '../api/auth';
import { useAuthStore } from '../store/auth';

vi.mock('../api/auth', () => ({
  authApi: {
    login: vi.fn(),
    // AUTH-04：登录页挂载时探测 SSO 开关；默认关闭态，不渲染 SSO 按钮
    oidcStatus: vi.fn().mockResolvedValue({ enabled: false }),
    verifyLogin: vi.fn(),
    me: vi.fn(),
    refresh: vi.fn(),
    totpSetup: vi.fn(),
    totpEnable: vi.fn(),
    totpDisable: vi.fn(),
    listSessions: vi.fn(),
    revokeSession: vi.fn(),
    revokeOtherSessions: vi.fn(),
  },
}));

const mockNav = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNav };
});

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

function renderLogin() {
  return render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function submitLogin(username = 'alice', password = 'pw123456') {
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: username } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: password } });
  fireEvent.submit(document.querySelector('form.ant-form')!);
}

beforeEach(() => {
  localStorage.clear();
  useAuthStore.getState().logout();
  mockNav.mockReset();
  vi.mocked(authApi.login).mockReset();
  vi.mocked(authApi.verifyLogin).mockReset();
  vi.mocked(authApi.me).mockReset();
  window.history.replaceState({}, '', '/login');
});

afterEach(() => {
  cleanup();
  useAuthStore.getState().logout();
  window.history.replaceState({}, '', '/login');
});

describe('LoginPage 登录成功按角色跳转', () => {
  it('ADMIN：登录成功跳 /dashboard', async () => {
    vi.mocked(authApi.login).mockResolvedValue({
      accessToken: 'admin-at',
      refreshToken: 'admin-rt',
      user: { id: 1, username: 'admin', role: 'admin' },
    } as never);

    renderLogin();
    submitLogin('admin', 'pw123456');

    await waitFor(() =>
      expect(mockNav).toHaveBeenCalledWith('/dashboard', { replace: true }),
    );
    expect(useAuthStore.getState().user?.role).toBe('admin');
  });

  it('USER：登录成功跳 /workbench', async () => {
    vi.mocked(authApi.login).mockResolvedValue({
      accessToken: 'user-at',
      refreshToken: 'user-rt',
      user: { id: 2, username: 'alice', role: 'user' },
    } as never);

    renderLogin();
    submitLogin('alice', 'pw123456');

    await waitFor(() =>
      expect(mockNav).toHaveBeenCalledWith('/workbench', { replace: true }),
    );
    expect(useAuthStore.getState().user?.role).toBe('user');
  });

  it('保留站内 ?redirect= 优先于角色首页', async () => {
    window.history.replaceState({}, '', '/login?redirect=/tasks');
    vi.mocked(authApi.login).mockResolvedValue({
      accessToken: 'user-at',
      refreshToken: 'user-rt',
      user: { id: 2, username: 'alice', role: 'user' },
    } as never);

    renderLogin();
    submitLogin('alice', 'pw123456');

    await waitFor(() =>
      expect(mockNav).toHaveBeenCalledWith('/tasks', { replace: true }),
    );
    expect(mockNav).not.toHaveBeenCalledWith('/workbench', { replace: true });
  });

  it('ADMIN 响应缺 role：先交壳层 profile 补全，补全后由 RoleHomeRedirect 跳 /dashboard', async () => {
    vi.mocked(authApi.login).mockResolvedValue({
      accessToken: 'admin-at',
      refreshToken: 'admin-rt',
      // 后端本次可只回 token；role 由 MainLayout 的 GET /auth/profile 补齐
      user: { id: 1, username: 'admin' },
    } as never);
    vi.mocked(authApi.me).mockResolvedValue({
      id: 1, username: 'admin', role: 'admin',
    } as never);

    renderLogin();
    submitLogin('admin', 'pw123456');

    await waitFor(() =>
      expect(mockNav).toHaveBeenCalledWith('/', { replace: true }),
    );
    expect(mockNav).not.toHaveBeenCalledWith('/workbench', { replace: true });
    expect(mockNav).not.toHaveBeenCalledWith('/dashboard', { replace: true });

    // 模拟 MainLayout 的 profile effect：authApi.me() -> setUser(me)
    const profiled = await authApi.me();
    useAuthStore.getState().setUser(profiled);
    cleanup();

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<RoleHomeRedirect />} />
          <Route path="/dashboard" element={<LocationProbe />} />
          <Route path="/workbench" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/dashboard'),
    );
  });
});
