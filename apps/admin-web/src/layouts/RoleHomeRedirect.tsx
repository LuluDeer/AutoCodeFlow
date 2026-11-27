import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../store/auth';
import { homePathForRole } from '../routes/route-registry';

/** 登录后的默认落地页：ADMIN 进控制台，USER 进工作台。 */
export function RoleHomeRedirect() {
  const role = useAuthStore((state) => state.user?.role);
  return <Navigate to={homePathForRole(role)} replace />;
}
