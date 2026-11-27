import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../store/auth';
import { homePathForRole } from '../routes/route-registry';
import PageSkeleton from '../components/PageSkeleton';

/**
 * 登录后的默认落地页：ADMIN 进控制台，USER 进工作台。
 *
 * role 尚未落定时直接跳 `/workbench` 会把 ADMIN 首帧送错页——profile 是
 * `GET /auth/profile` 异步补齐的，旧实现用 `homePathForRole(undefined)` 的
 * 非 ADMIN 兜底当成了「确定是 USER」。现在失败才安全兜底，未确定时停在骨架屏。
 */
export function RoleHomeRedirect() {
  const { token, user, profileError } = useAuthStore();
  const role = user?.role;
  if (role) return <Navigate to={homePathForRole(role)} replace />;
  // 未登录或 profile 明确失败才走安全兜底；有 token 且 profile 在途时留在骨架屏。
  if (profileError || !token) return <Navigate to={homePathForRole(undefined)} replace />;
  return <PageSkeleton />;
}
