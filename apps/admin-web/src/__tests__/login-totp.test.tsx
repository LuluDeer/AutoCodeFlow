/**
 * SEC-03: LoginPage 两步验证分支测试。
 * 契约：login 返回 200 + { totpRequired: true } 时进入动态码阶段（不发跳转）；
 * verifyLogin 成功后写 store 并跳转 dashboard；未启用用户路径零变化。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LoginPage from '../pages/LoginPage';
import { authApi } from '../api/auth';
import { useAuthStore } from '../store/auth';

vi.mock('../api/auth', () => ({
  authApi: {
    login: vi.fn(),
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

// jsdom 缺失 antd 依赖的浏览器 API，先行补齐（同 settings.ai.test.tsx 约定）
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

function fillAndSubmit(username = 'alice', password = 'pw123456') {
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: username } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: password } });
  // antd Form onFinish 由表单 submit 事件驱动——直接对 form 元素派发 submit
  const form = document.querySelector('form.ant-form')!;
  fireEvent.submit(form);
}

beforeEach(() => {
  localStorage.clear();
  useAuthStore.getState().logout();
  mockNav.mockReset();
  vi.mocked(authApi.login).mockReset();
  vi.mocked(authApi.verifyLogin).mockReset();
});

afterEach(() => {
  cleanup();
  useAuthStore.getState().logout();
});

describe('SEC-03 LoginPage TOTP 分支', () => {
  it('普通用户（未启用 TOTP）：直接发 token 写 store 并跳转（路径零变化）', async () => {
    vi.mocked(authApi.login).mockResolvedValue({
      accessToken: 'at',
      refreshToken: 'rt',
      user: { id: 1, username: 'alice' },
    } as never);
    renderLogin();
    fillAndSubmit();
    await waitFor(() => expect(mockNav).toHaveBeenCalledWith('/dashboard', { replace: true }));
    expect(useAuthStore.getState().token).toBe('at');
    expect(authApi.verifyLogin).not.toHaveBeenCalled();
  });

  it('totpRequired=true：不跳转不发 store，进入动态码输入阶段', async () => {
    vi.mocked(authApi.login).mockResolvedValue({ totpRequired: true } as never);
    renderLogin();
    fillAndSubmit();
    await waitFor(() => expect(screen.getByLabelText('动态验证码')).toBeTruthy());
    expect(mockNav).not.toHaveBeenCalled();
    expect(useAuthStore.getState().token).toBeNull();
    expect(screen.getByText('两步验证')).toBeTruthy();
  });

  it('动态码 verify 成功后完成登录（写 store + 跳转）', async () => {
    vi.mocked(authApi.login).mockResolvedValue({ totpRequired: true } as never);
    vi.mocked(authApi.verifyLogin).mockResolvedValue({
      accessToken: 'at2',
      refreshToken: 'rt2',
      user: { id: 1, username: 'alice' },
    } as never);
    renderLogin();
    fillAndSubmit();
    await screen.findByLabelText('动态验证码');
    fireEvent.change(screen.getByLabelText('动态验证码'), { target: { value: '287082' } });
    fireEvent.submit(document.querySelector('form.ant-form')!);
    await waitFor(() =>
      expect(authApi.verifyLogin).toHaveBeenCalledWith({
        username: 'alice',
        password: 'pw123456',
        code: '287082',
      }),
    );
    await waitFor(() => expect(mockNav).toHaveBeenCalledWith('/dashboard', { replace: true }));
    expect(useAuthStore.getState().token).toBe('at2');
    expect(useAuthStore.getState().refreshToken).toBe('rt2');
  });

  it('verify 失败（错码）保持在动态码阶段', async () => {
    vi.mocked(authApi.login).mockResolvedValue({ totpRequired: true } as never);
    vi.mocked(authApi.verifyLogin).mockRejectedValue(new Error('Invalid TOTP code') as never);
    renderLogin();
    fillAndSubmit();
    await screen.findByLabelText('动态验证码');
    fireEvent.change(screen.getByLabelText('动态验证码'), { target: { value: '000000' } });
    fireEvent.submit(document.querySelector('form.ant-form')!);
    await waitFor(() => expect(authApi.verifyLogin).toHaveBeenCalled());
    expect(mockNav).not.toHaveBeenCalled();
    expect(useAuthStore.getState().token).toBeNull();
    expect(screen.getByLabelText('动态验证码')).toBeTruthy();
  });
});
