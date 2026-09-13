/**
 * AUTH-04：SsoCompletePage 渲染回归——fragment 成功路径写 store 并跳转、
 * error 码分支呈现指引、StrictMode 双跑幂等（fragment 只消费一次）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SsoCompletePage from '../pages/SsoCompletePage';
import { useAuthStore } from '../store/auth';
import { authApi } from '../api/auth';

const navMock = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navMock };
});
vi.mock('../api/auth', () => ({
  authApi: { me: vi.fn().mockResolvedValue({ id: 7, username: 'alice', role: 'user' }) },
}));

// jsdom 缺失 antd 依赖的浏览器 API（对齐 task-templates-page.test 先例）
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

const renderPage = () =>
  render(
    <MemoryRouter>
      <SsoCompletePage />
    </MemoryRouter>,
  );

beforeEach(() => {
  navMock.mockReset();
  vi.mocked(authApi.me).mockClear();
  useAuthStore.setState({ token: null, refreshToken: null, user: null });
});

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('SsoCompletePage（AUTH-04）', () => {
  it('成功 fragment：写 store（token/user）并跳 dashboard，且拉 profile 补全', () => {
    window.location.hash = '#access_token=at-1&refresh_token=rt-1&username=alice';
    renderPage();

    expect(navMock).toHaveBeenCalledWith('/dashboard', { replace: true });
    const state = useAuthStore.getState();
    expect(state.token).toBe('at-1');
    expect(state.refreshToken).toBe('rt-1');
    expect(state.user?.username).toBe('alice');
    // profile 拉取成功后补全 id/role（不重跳）
    expect(authApi.me).toHaveBeenCalled();
  });

  it('error fragment：呈现稳定错误指引，不写 store 不跳转', () => {
    window.location.hash = '#error=account_not_linked';
    renderPage();

    expect(navMock).not.toHaveBeenCalledWith('/dashboard', expect.anything());
    expect(useAuthStore.getState().token).toBeNull();
    // 未绑定文案（zh 渲染）+ 返回登录按钮
    expect(screen.getByText(/未绑定任何平台账号/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '返回登录页' }));
    expect(navMock).toHaveBeenCalledWith('/login', { replace: true });
  });

  it('fragment 消费后从地址栏抹掉（防历史残留）', () => {
    window.location.hash = '#error=state_invalid';
    renderPage();
    expect(window.location.hash).toBe('');
  });

  it('缺少 token 的 fragment → missing 错误分支', async () => {
    window.location.hash = '#username=alice';
    renderPage();
    expect(await screen.findByText('回调参数缺失，请从登录页重新发起')).toBeTruthy();
  });
});
