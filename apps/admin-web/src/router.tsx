import { lazy, Suspense } from 'react';
import type { ReactNode } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import MainLayout from './layouts/MainLayout';
import { useAuthStore } from './store/auth';

const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));
const LoginPage = lazy(() => import('./pages/LoginPage'));
const TaskListPage = lazy(() => import('./pages/TaskListPage'));
const TaskDetailPage = lazy(() => import('./pages/TaskDetailPage'));
const TaskFormPage = lazy(() => import('./pages/TaskFormPage'));
const ExecutionDetailPage = lazy(() => import('./pages/ExecutionDetailPage'));
const UserManagementPage = lazy(() => import('./pages/UserManagementPage'));
const ExecutorListPage = lazy(() => import('./pages/ExecutorListPage'));
const ExecutorInstallWizardPage = lazy(() => import('./pages/ExecutorInstallWizardPage'));
const ExecutorDetailPage = lazy(() => import('./pages/ExecutorDetailPage'));
const ExecutorPackagesPage = lazy(() => import('./pages/ExecutorPackagesPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const RegistryPage = lazy(() => import('./pages/RegistryPage'));
const SettingsPage = lazy(() => import('./pages/settings/index'));
const NotificationSettingsPage = lazy(() => import('./pages/NotificationSettingsPage'));
const AuditLogPage = lazy(() => import('./pages/audit/index'));
const ApplicationListPage = lazy(() => import('./pages/ApplicationListPage'));
const ApplicationDetailPage = lazy(() => import('./pages/ApplicationDetailPage'));
const ExecutionsPage = lazy(() => import('./pages/ExecutionsPage'));

function PageFallback() {
  return <div style={{ padding: 24, textAlign: 'center' }}>加载中...</div>;
}

const withSuspense = (children: ReactNode) => (
  <Suspense fallback={<PageFallback />}>{children}</Suspense>
);

const PrivateRoute = ({ children }: { children: ReactNode }) => {
  // token is not persisted (short-lived); use refreshToken to determine if the
  // user has an active session. The axios interceptor will obtain a new access
  // token on the first authenticated request.
  const refreshToken = useAuthStore((state) => state.refreshToken);
  const hasHydrated = useAuthStore((state) => state._hasHydrated);
  if (!hasHydrated) return null;
  return refreshToken ? <>{children}</> : <Navigate to="/login" replace />;
};

export const router = createBrowserRouter(
  [
    { path: '/login', element: withSuspense(<LoginPage />) },
    {
      path: '/',
      element: <PrivateRoute><MainLayout /></PrivateRoute>,
      children: [
        { index: true, element: <Navigate to="/dashboard" replace /> },
        { path: '*', element: withSuspense(<NotFoundPage />) },
        { path: 'dashboard', element: withSuspense(<DashboardPage />) },
        { path: 'tasks', element: withSuspense(<TaskListPage />) },
        { path: 'tasks/new', element: withSuspense(<TaskFormPage />) },
        { path: 'tasks/:id', element: withSuspense(<TaskDetailPage />) },
        { path: 'tasks/:id/edit', element: withSuspense(<TaskFormPage />) },
        { path: 'tasks/:taskId/executions/:execId', element: withSuspense(<ExecutionDetailPage />) },
        { path: 'executions', element: withSuspense(<ExecutionsPage />) },
        { path: 'executors', element: withSuspense(<ExecutorListPage />) },
        { path: 'executors/install', element: withSuspense(<ExecutorInstallWizardPage />) },
        { path: 'executors/:id', element: withSuspense(<ExecutorDetailPage />) },
        { path: 'users', element: withSuspense(<UserManagementPage />) },
        { path: 'registry', element: withSuspense(<RegistryPage />) },
        { path: 'settings', element: withSuspense(<SettingsPage />) },
        { path: 'notifications', element: withSuspense(<NotificationSettingsPage />) },
        { path: 'audit', element: withSuspense(<AuditLogPage />) },
        { path: 'applications', element: withSuspense(<ApplicationListPage />) },
        { path: 'applications/:id', element: withSuspense(<ApplicationDetailPage />) },
        { path: 'executor-packages', element: withSuspense(<ExecutorPackagesPage />) },
      ],
    },
  ],
  {
    future: {
      v7_relativeSplatPath: true,
    },
  }
);
