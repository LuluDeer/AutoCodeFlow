import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface AuthUser {
  id: number;
  username: string;
  email?: string;
  role?: string;
}

/**
 * R5 角色门控：ADMIN-only 路由/操作统一以此判断。
 * role 值来自后端 GET /auth/profile 返回的 AuthUser.role（'admin' | 'user'）；
 * role 缺失（旧 localStorage 数据、profile 尚未拉取）时按非 ADMIN 处理。
 */
export const isAdminUser = (user: AuthUser | null | undefined): boolean =>
  user?.role === 'admin';

interface AuthState {
  token: string | null;
  refreshToken: string | null;
  user: AuthUser | null;
  _hasHydrated: boolean;
  setToken: (token: string) => void;
  setRefreshToken: (refreshToken: string) => void;
  setAuth: (token: string, refreshToken: string, user: AuthUser) => void;
  setUser: (user: AuthUser) => void;
  logout: () => void;
  setHasHydrated: (state: boolean) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      refreshToken: null,
      user: null,
      _hasHydrated: false,
      setToken: (token) => set({ token }),
      setRefreshToken: (refreshToken) => set({ refreshToken }),
      setAuth: (token, refreshToken, user) => set({ token, refreshToken, user }),
      setUser: (user) => set({ user }),
      logout: () => { set({ token: null, refreshToken: null, user: null }); },
      setHasHydrated: (state) => set({ _hasHydrated: state }),
    }),
    {
      name: 'autoflow-auth',
      storage: createJSONStorage(() => localStorage),
      // Persist token, refreshToken, and user so the first request after a page
      // reload carries a valid Authorization header without needing a refresh round-trip.
      // The access token is short-lived; the 401→refresh path still handles expiry.
      partialize: (state) => ({ token: state.token, refreshToken: state.refreshToken, user: state.user }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    },
  ),
);
