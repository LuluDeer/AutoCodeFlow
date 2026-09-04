import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../store/auth';

// Route guard: requires an active session (refreshToken) to render children
export default function PrivateRoute({ children }: { children: ReactNode }) {
  // token is not persisted (short-lived); use refreshToken to determine if the
  // user has an active session. The axios interceptor will obtain a new access
  // token on the first authenticated request.
  const refreshToken = useAuthStore((state) => state.refreshToken);
  const hasHydrated = useAuthStore((state) => state._hasHydrated);
  if (!hasHydrated) return null;
  return refreshToken ? <>{children}</> : <Navigate to="/login" replace />;
}
