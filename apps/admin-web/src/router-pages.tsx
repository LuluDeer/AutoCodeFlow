import { lazy } from 'react';

// react-refresh/only-export-components：懒加载页面组件必须与路由配置（非组件
// 导出）分文件，否则该文件 HMR 边界失效（整文件 reload 而非局部热替换）。
// 本文件只导出组件；router.tsx 只导出路由配置，二者互不混居。

export const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));
export const LoginPage = lazy(() => import('./pages/LoginPage'));
export const SsoCompletePage = lazy(() => import('./pages/SsoCompletePage'));
export const TaskListPage = lazy(() => import('./pages/TaskListPage'));
export const TaskTemplatesPage = lazy(() => import('./pages/TaskTemplatesPage'));
export const TaskDetailPage = lazy(() => import('./pages/TaskDetailPage'));
export const TaskFormPage = lazy(() => import('./pages/TaskFormPage'));
export const ExecutionDetailPage = lazy(() => import('./pages/ExecutionDetailPage'));
export const UserManagementPage = lazy(() => import('./pages/UserManagementPage'));
export const ExecutorListPage = lazy(() => import('./pages/ExecutorListPage'));
export const ExecutorInstallWizardPage = lazy(() => import('./pages/ExecutorInstallWizardPage'));
export const ExecutorDetailPage = lazy(() => import('./pages/ExecutorDetailPage'));
export const ExecutorPackagesPage = lazy(() => import('./pages/ExecutorPackagesPage'));
export const DashboardPage = lazy(() => import('./pages/DashboardPage'));
export const RegistryPage = lazy(() => import('./pages/RegistryPage'));
export const SettingsPage = lazy(() => import('./pages/settings/index'));
export const NotificationSettingsPage = lazy(() => import('./pages/NotificationSettingsPage'));
export const AuditLogPage = lazy(() => import('./pages/audit/index'));
export const ApplicationListPage = lazy(() => import('./pages/ApplicationListPage'));
export const ApplicationDetailPage = lazy(() => import('./pages/ApplicationDetailPage'));
export const ExecutionsPage = lazy(() => import('./pages/ExecutionsPage'));
export const ProjectsPage = lazy(() => import('./pages/ProjectsPage'));
// P5/P6: SOP 管理（全 ADMIN-only——发布权 = 间接指令注入权）
export const SopsPage = lazy(() => import('./pages/SopsPage'));
// P2 遗留补齐: Agent 会话查看面（全 ADMIN-only——会话能改系统状态）
export const AgentSessionsPage = lazy(() => import('./pages/AgentSessionsPage'));
