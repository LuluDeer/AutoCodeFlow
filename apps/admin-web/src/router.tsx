import { lazy, Suspense } from 'react';
import type { ReactNode } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import MainLayout from './layouts/MainLayout';
import RequireAdmin from './components/RequireAdmin';
import PrivateRoute from './components/PrivateRoute';
import PageFallback from './components/PageFallback';
import RouteErrorBoundary from './components/RouteErrorBoundary';

const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));
const LoginPage = lazy(() => import('./pages/LoginPage'));
const SsoCompletePage = lazy(() => import('./pages/SsoCompletePage'));
const TaskListPage = lazy(() => import('./pages/TaskListPage'));
const TaskTemplatesPage = lazy(() => import('./pages/TaskTemplatesPage'));
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
const ProjectsPage = lazy(() => import('./pages/ProjectsPage'));
// P5/P6: SOP 管理（全 ADMIN-only——发布权 = 间接指令注入权）
const SopsPage = lazy(() => import('./pages/SopsPage'));

const withSuspense = (children: ReactNode) => (
  <Suspense fallback={<PageFallback />}>{children}</Suspense>
);

export const router = createBrowserRouter(
  [
    // NETOPT-4：三个顶层路由全部挂 errorElement——react-router 7 data router
    // 自带内部错误边界，未挂时页面级错误渲染默认英文调试页 "Unexpected
    // Application Error"（含 stack）；main.tsx 的 ErrorBoundary 包在
    // RouterProvider 外层，接不到路由内部错误。懒加载 chunk 失效（发版后
    // 旧 hash）同落此处。子路由错误向最近 errorElement 冒泡，/ 路由一处
    // 即覆盖全部子页面。
    {
      path: '/login',
      element: withSuspense(<LoginPage />),
      errorElement: <RouteErrorBoundary />,
    },
    // AUTH-04：OIDC 回调落地页（公开，token 经 #fragment 回传）
    {
      path: '/auth/sso/complete',
      element: withSuspense(<SsoCompletePage />),
      errorElement: <RouteErrorBoundary />,
    },
    {
      path: '/',
      element: <PrivateRoute><MainLayout /></PrivateRoute>,
      errorElement: <RouteErrorBoundary />,
      children: [
        { index: true, element: <Navigate to="/dashboard" replace /> },
        { path: '*', element: withSuspense(<NotFoundPage />) },
        { path: 'dashboard', element: withSuspense(<DashboardPage />) },
        { path: 'tasks', element: withSuspense(<TaskListPage />) },
        // CORE-03: 任务模板（从模板一键克隆 config 生成任务草稿）
        { path: 'task-templates', element: withSuspense(<TaskTemplatesPage />) },
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
        { path: 'projects', element: withSuspense(<ProjectsPage />) },
        { path: 'applications/:id', element: withSuspense(<ApplicationDetailPage />) },
        { path: 'executor-packages', element: <RequireAdmin>{withSuspense(<ExecutorPackagesPage />)}</RequireAdmin> },
        { path: 'sops', element: <RequireAdmin>{withSuspense(<SopsPage />)}</RequireAdmin> },
      ],
    },
  ],
  {
    future: {
      v7_relativeSplatPath: true,
    },
  }
);
