import { Suspense } from 'react';
import type { ReactNode } from 'react';
import { createBrowserRouter } from 'react-router-dom';
import MainLayout from './layouts/MainLayout';
import { RoleHomeRedirect } from './layouts/RoleHomeRedirect';
import RequireAdmin from './components/RequireAdmin';
import PrivateRoute from './components/PrivateRoute';
import PageFallback from './components/PageFallback';
import RouteErrorBoundary from './components/RouteErrorBoundary';
// react-refresh/only-export-components：本文件唯一导出是非组件的路由配置，
// 懒加载页面组件全部收在 router-pages.tsx（仅组件导出），保住各自 HMR 边界。
import {
  NotFoundPage,
  LoginPage,
  SsoCompletePage,
  TaskListPage,
  TaskTemplatesPage,
  TaskDetailPage,
  TaskFormPage,
  ExecutionDetailPage,
  UserManagementPage,
  ExecutorListPage,
  ExecutorInstallWizardPage,
  ExecutorDetailPage,
  ExecutorPackagesPage,
  DashboardPage,
  RegistryPage,
  SettingsPage,
  NotificationSettingsPage,
  AuditLogPage,
  ApplicationListPage,
  ApplicationDetailPage,
  ExecutionsPage,
  ArtifactsPage,
  ProjectsPage,
  ProjectDetailPage,
  SopsPage,
  SopFromVideoPage,
  AgentSessionsPage,
  InboxPage,
  WorkbenchPage,
  CapabilitiesPage,
  ActivationStatsPage,
} from './router-pages';

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
        { index: true, element: <RoleHomeRedirect /> },
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
        // P1-3：产物库——业务人员可见"我的交付物"（ADR-044 白名单内自主）；
        // 数据面由后端按 ownerUserId/项目角色过滤，管理页门控不动。
        { path: 'artifacts', element: withSuspense(<ArtifactsPage />) },
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
        // P3 中台管控：能力注册表（CRUD / resolve / dump），与管理面一致整页 ADMIN-only
        { path: 'capabilities', element: <RequireAdmin>{withSuspense(<CapabilitiesPage />)}</RequireAdmin> },
        // 能力用量看板：stats 端点为 ADMIN-only，路由门控同 /capabilities
        { path: 'activation-stats', element: <RequireAdmin>{withSuspense(<ActivationStatsPage />)}</RequireAdmin> },
        { path: 'applications', element: withSuspense(<ApplicationListPage />) },
        { path: 'projects', element: withSuspense(<ProjectsPage />) },
        // P1-2：项目详情统计。置于静态 `projects` 之后；`projects/:id` 单段动态，
        // 与 `projects/me/roles`（两段）不冲突。
        { path: 'projects/:id', element: withSuspense(<ProjectDetailPage />) },
        { path: 'applications/:id', element: withSuspense(<ApplicationDetailPage />) },
        { path: 'executor-packages', element: <RequireAdmin>{withSuspense(<ExecutorPackagesPage />)}</RequireAdmin> },
        { path: 'sops', element: <RequireAdmin>{withSuspense(<SopsPage />)}</RequireAdmin> },
        // 工作台：业务人员的自然语言入口（ADR-044 白名单内自主）；commit 只落 draft、
        // 发布/rewind 仍 ADMIN，数据面由后端主体与五道闸收窄。
        { path: 'workbench', element: withSuspense(<WorkbenchPage />) },
        {
          path: 'sops/from-video',
          element: <RequireAdmin>{withSuspense(<SopFromVideoPage />)}</RequireAdmin>,
        },
        { path: 'agent-sessions', element: <RequireAdmin>{withSuspense(<AgentSessionsPage />)}</RequireAdmin> },
        // P1-4：待办收件箱——业务人员只读"待我审批/待我处理"；后端按会话归属过滤，
        // 写动作（approve/deny/resume）仍 ADMIN，InboxPage.canWrite 隐藏按钮。
        { path: 'inbox', element: withSuspense(<InboxPage />) },
      ],
    },
  ],
  {
    future: {
      v7_relativeSplatPath: true,
    },
  }
);
