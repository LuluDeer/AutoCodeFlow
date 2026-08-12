import { createBrowserRouter, Navigate } from 'react-router-dom';
import NotFoundPage from './pages/NotFoundPage';
import MainLayout from './layouts/MainLayout';
import LoginPage from './pages/LoginPage';
import TaskListPage from './pages/TaskListPage';
import TaskDetailPage from './pages/TaskDetailPage';
import TaskFormPage from './pages/TaskFormPage';
import ExecutionDetailPage from './pages/ExecutionDetailPage';
import UserManagementPage from './pages/UserManagementPage';
import ExecutorListPage from './pages/ExecutorListPage';
import ExecutorInstallWizardPage from './pages/ExecutorInstallWizardPage';
import ExecutorDetailPage from './pages/ExecutorDetailPage';
import ExecutorPackagesPage from './pages/ExecutorPackagesPage';
import DashboardPage from './pages/DashboardPage';
import RegistryPage from './pages/RegistryPage';
import SettingsPage from './pages/settings/index';
import NotificationSettingsPage from './pages/NotificationSettingsPage';
import AuditLogPage from './pages/audit/index';
import ApplicationListPage from './pages/ApplicationListPage';
import ApplicationDetailPage from './pages/ApplicationDetailPage';
import ExecutionsPage from './pages/ExecutionsPage';
import { useAuthStore } from './store/auth';

const PrivateRoute = ({ children }: { children: React.ReactNode }) => {
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
    { path: '/login', element: <LoginPage /> },
    {
      path: '/',
      element: <PrivateRoute><MainLayout /></PrivateRoute>,
      children: [
        { index: true, element: <Navigate to="/dashboard" replace /> },
        { path: '*', element: <NotFoundPage /> },
        { path: 'dashboard', element: <DashboardPage /> },
        { path: 'tasks', element: <TaskListPage /> },
        { path: 'tasks/new', element: <TaskFormPage /> },
        { path: 'tasks/:id', element: <TaskDetailPage /> },
        { path: 'tasks/:id/edit', element: <TaskFormPage /> },
        { path: 'tasks/:taskId/executions/:execId', element: <ExecutionDetailPage /> },
        { path: 'executions', element: <ExecutionsPage /> },
        { path: 'executors', element: <ExecutorListPage /> },
        { path: 'executors/install', element: <ExecutorInstallWizardPage /> },
        { path: 'executors/:id', element: <ExecutorDetailPage /> },
        { path: 'users', element: <UserManagementPage /> },
        { path: 'registry', element: <RegistryPage /> },
        { path: 'settings', element: <SettingsPage /> },
        { path: 'notifications', element: <NotificationSettingsPage /> },
        { path: 'audit', element: <AuditLogPage /> },
        { path: 'applications', element: <ApplicationListPage /> },
        { path: 'applications/:id', element: <ApplicationDetailPage /> },
        { path: 'executor-packages', element: <ExecutorPackagesPage /> },
      ],
    },
  ],
  {
    future: {
      v7_relativeSplatPath: true,
    },
  }
);
