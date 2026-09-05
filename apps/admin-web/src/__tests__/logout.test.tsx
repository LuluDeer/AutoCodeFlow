import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import axios from 'axios';
import MainLayout from '../layouts/MainLayout';
import { authApi } from '../api/auth';
import { getApiBaseUrl } from '../api/client';
import { logoutRemote } from '../api/logout';
import { useAuthStore } from '../store/auth';

vi.mock('../api/auth', () => ({ authApi: { me: vi.fn() } }));

// Match the browser API shims used by settings.ai.test.tsx.
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

const user = { id: 1, username: 'alice', role: 'admin' };

beforeEach(() => {
  localStorage.clear();
  useAuthStore.getState().setAuth('logout-access', 'logout-refresh', user);
  vi.mocked(authApi.me).mockReset().mockRejectedValue(new Error('Logged out'));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAuthStore.getState().logout();
});

function expectLoggedOut() {
  const cleared = { token: null, refreshToken: null, user: null };
  expect(useAuthStore.getState()).toMatchObject(cleared);
  expect(JSON.parse(localStorage.getItem('autoflow-auth')!).state).toEqual(cleared);
}

describe('DR-04 explicit logout', () => {
  it.each(['success', 'network failure', 'timeout', '401'])('menu logout clears state and navigates after %s', async (outcome) => {
    let resolveLogout!: (value: unknown) => void;
    let rejectLogout!: (reason: unknown) => void;
    const post = vi.spyOn(axios, 'post').mockImplementation(() => new Promise((resolve, reject) => {
      resolveLogout = resolve;
      rejectLogout = reject;
    }));
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route path="/dashboard" element={<MainLayout />} />
          <Route path="/login" element={<div>Login destination</div>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('alice'));
    fireEvent.click(await screen.findByText('退出登录'));
    expect(post).toHaveBeenCalledExactlyOnceWith(`${getApiBaseUrl()}/auth/logout`, undefined, {
      headers: { Authorization: 'Bearer logout-access' }, timeout: 4000,
    });
    expect(useAuthStore.getState()).toMatchObject({ token: 'logout-access', refreshToken: 'logout-refresh', user });
    expect(screen.queryByText('Login destination')).toBeNull();
    await act(async () => {
      if (outcome === 'success') resolveLogout({ data: { success: true } });
      else rejectLogout(outcome === '401' ? { response: { status: 401 } } : new Error(outcome));
    });
    await waitFor(() => expect(screen.getByText('Login destination')).toBeTruthy());
    expectLoggedOut();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('captures the access token at logout start, even if the store changes while pending', async () => {
    let resolveLogout!: (value: unknown) => void;
    const post = vi.spyOn(axios, 'post').mockImplementation(() => new Promise(resolve => {
      resolveLogout = resolve;
    }));
    const pending = logoutRemote();
    useAuthStore.getState().setToken('refreshed-during-logout');
    expect(post.mock.calls[0][2]?.headers).toEqual({ Authorization: 'Bearer logout-access' });
    resolveLogout({ data: {} });
    await pending;
    expectLoggedOut();
  });

  it('still clears local state when no access token is available', async () => {
    useAuthStore.setState({ token: null });
    const post = vi.spyOn(axios, 'post');
    await logoutRemote();
    expectLoggedOut();
    expect(post).not.toHaveBeenCalled();
  });
});
