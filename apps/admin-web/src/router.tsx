import { lazy, Suspense } from 'react';
import type { ReactNode } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import MainLayout from './layouts/MainLayout';
import RequireAdmin from './components/RequireAdmin';
import PrivateRoute from './components/PrivateRoute';
import PageFallback from './components/PageFallback';

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

const withSuspense = (children: ReactNode) => (
  <Suspense fallback={<PageFallback />}>{children}</Suspense>
);

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
        // R5 RBAC: 安装向导依赖 ADMIN-only 的 install-cmd / executor-shared-token
        { path: 'executors/install', element: <RequireAdmin>{withSuspense(<ExecutorInstallWizardPage />)}</RequireAdmin> },
        { path: 'executors/:id', element: withSuspense(<ExecutorDetailPage />) },
        { path: 'users', element: <RequireAdmin>{withSuspense(<UserManagementPage />)}</RequireAdmin> },
        { path: 'registry', element: withSuspense(<RegistryPage />) },
        { path: 'settings', element: withSuspense(<SettingsPage />) },
        // R6 RBAC: 通知渠道配置（GET/PATCH /notification/channels）收紧为 ADMIN-only，
        // 页面整体为渠道配置表单，路由级门控（同 /audit 模式）
        { path: 'notifications', element: <RequireAdmin>{withSuspense(<NotificationSettingsPage />)}</RequireAdmin> },
        { path: 'audit', element: <RequireAdmin>{withSuspense(<AuditLogPage />)}</RequireAdmin> },
        { path: 'applications', element: withSuspense(<ApplicationListPage />) },
        { path: 'applications/:id', element: withSuspense(<ApplicationDetailPage />) },
        { path: 'executor-packages', element: <RequireAdmin>{withSuspense(<ExecutorPackagesPage />)}</RequireAdmin> },
      ],
    },
  ],
  {
    future: {
      v7_relativeSplatPath: true,
    },
  }
);
