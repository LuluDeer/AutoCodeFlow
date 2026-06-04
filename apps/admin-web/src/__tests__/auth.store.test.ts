/**
 * Tests for useAuthStore (store/auth.ts)
 *
 * admin-web uses Vite + React. This test file targets Vitest.
 * Run with: npx vitest run src/__tests__/auth.store.test.ts
 *
 * If vitest is not yet installed, add it:
 *   npm install -D vitest @vitest/ui jsdom
 * and add to vite.config.ts:
 *   test: { environment: 'jsdom' }
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAuthStore } from '../store/auth';

// Reset zustand store state between tests so they don't bleed into each other.
// Zustand persists to localStorage — clear it before each test.
beforeEach(() => {
  localStorage.clear();
  // Reset the store to initial state by calling logout
  act(() => {
    useAuthStore.getState().logout();
  });
});

describe('useAuthStore — initial state', () => {
  it('has null token by default', () => {
    const { result } = renderHook(() => useAuthStore());
    expect(result.current.token).toBeNull();
  });

  it('has null user by default', () => {
    const { result } = renderHook(() => useAuthStore());
    expect(result.current.user).toBeNull();
  });
});

describe('useAuthStore — setToken', () => {
  it('updates the token in state', () => {
    const { result } = renderHook(() => useAuthStore());

    act(() => {
      result.current.setToken('my-jwt-token');
    });

    expect(result.current.token).toBe('my-jwt-token');
  });

  it('persists token to localStorage under key autoflow-auth', () => {
    act(() => {
      useAuthStore.getState().setToken('persisted-token');
    });

    const raw = localStorage.getItem('autoflow-auth');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    // zustand persist wraps value in { state: {...}, version: ... }
    expect(parsed.state.token).toBe('persisted-token');
  });
});

describe('useAuthStore — setUser', () => {
  it('updates the user in state', () => {
    const { result } = renderHook(() => useAuthStore());
    const mockUser = { id: 1, name: 'Alice', email: 'alice@example.com' };

    act(() => {
      result.current.setUser(mockUser);
    });

    expect(result.current.user).toEqual(mockUser);
  });

  it('persists user to localStorage under key autoflow-auth', () => {
    const mockUser = { id: 2, name: 'Bob' };
    act(() => {
      useAuthStore.getState().setUser(mockUser);
    });

    const raw = localStorage.getItem('autoflow-auth');
    const parsed = JSON.parse(raw!);
    expect(parsed.state.user).toEqual(mockUser);
  });
});

describe('useAuthStore — logout', () => {
  it('clears token and user on logout', () => {
    const { result } = renderHook(() => useAuthStore());

    act(() => {
      result.current.setToken('some-token');
      result.current.setUser({ id: 1 });
    });

    expect(result.current.token).toBe('some-token');
    expect(result.current.user).toEqual({ id: 1 });

    act(() => {
      result.current.logout();
    });

    expect(result.current.token).toBeNull();
    expect(result.current.user).toBeNull();
  });

  it('clears persisted data in localStorage after logout', () => {
    act(() => {
      useAuthStore.getState().setToken('token-to-clear');
      useAuthStore.getState().logout();
    });

    const raw = localStorage.getItem('autoflow-auth');
    if (raw) {
      const parsed = JSON.parse(raw);
      expect(parsed.state.token).toBeNull();
    }
    // If key was removed entirely, that's also acceptable
  });
});

describe('useAuthStore — combined flow', () => {
  it('can set token and user independently', () => {
    const { result } = renderHook(() => useAuthStore());

    act(() => {
      result.current.setToken('token-abc');
    });
    expect(result.current.user).toBeNull(); // user not affected

    act(() => {
      result.current.setUser({ id: 99 });
    });
    expect(result.current.token).toBe('token-abc'); // token not affected
  });
});
