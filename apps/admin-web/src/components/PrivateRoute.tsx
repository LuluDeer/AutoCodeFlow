import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../store/auth';
import PageFallback from './PageFallback';

// Route guard: requires an active session (refreshToken) to render children
// F-06（DEEP_REVIEW @0ef3bbe，注释更正）：token 与 refreshToken 实际都经
// zustand persist 持久化在 localStorage（见 src/store/auth.ts 的 partialize），
// 页面刷新后两者均可恢复——下方注释曾声称「token 不持久化」，与实现矛盾；
// 按 refreshToken 判定会话的原因是其生命周期长于短效 access token，
// 401→refresh 链路负责在 access token 过期后换新。
export default function PrivateRoute({ children }: { children: ReactNode }) {
  // use refreshToken to determine if the user has an active session. The axios
  // interceptor will obtain a new access token on the first authenticated
  // request when the persisted access token has expired.
  const refreshToken = useAuthStore((state) => state.refreshToken);
  const hasHydrated = useAuthStore((state) => state._hasHydrated);
  // UX-FIRST-FRAME：persist 恢复前 refreshToken 仍是初始值 null，直接判会话会把
  // 已登录用户弹到 /login；旧实现返回 null 则首帧纯白。两种都不对——hydration
  // 未完成时渲染与路由 lazy 同款骨架屏，完成后再决定放行/跳登录。
  if (!hasHydrated) {
    return (
      <div data-testid="private-route-hydration-fallback" aria-busy="true">
        <PageFallback />
      </div>
    );
  }
  return refreshToken ? <>{children}</> : <Navigate to="/login" replace />;
}
