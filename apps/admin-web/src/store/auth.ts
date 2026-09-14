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
      // F-06（DEEP_REVIEW @0ef3bbe）：现状注释（不改运行时行为）——token 与
      // refreshToken 均持久化在 localStorage，页面刷新后的首个请求即可携带有效
      // Authorization 头，无需先走一次 refresh 往返；access token 短效，
      // 过期仍由 401→refresh 链路兜底。
      // 安全权衡：localStorage 可被 XSS 读取（token/refreshToken 泄露面大于
      // HttpOnly Cookie）。后续方向：迁移到 HttpOnly Cookie（Set-Cookie + CSRF
      // 防护，后端 /auth/refresh 改读 Cookie），前端仅保留非敏感 user 摘要；
      // 该迁移涉及 admin-api 认证链路，不在本次前端注释修正范围内。
      partialize: (state) => ({ token: state.token, refreshToken: state.refreshToken, user: state.user }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    },
  ),
);
