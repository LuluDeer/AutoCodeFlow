import { createBrowserRouter, Navigate } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import MainLayout from './layouts/MainLayout';
import LoginPage from './pages/LoginPage';
import TaskListPage from './pages/TaskListPage';
import TaskDetailPage from './pages/TaskDetailPage';
import TaskFormPage from './pages/TaskFormPage';
import ExecutionDetailPage from './pages/ExecutionDetailPage';
import UserListPage from './pages/UserListPage';
import ExecutorListPage from './pages/ExecutorListPage';
import ExecutorDetailPage from './pages/ExecutorDetailPage';
import DashboardPage from './pages/DashboardPage';
import RegistryPage from './pages/RegistryPage';
import SettingsPage from './pages/settings/index';
import NotificationSettingsPage from './pages/NotificationSettingsPage';
import AuditLogPage from './pages/audit/index';
import { useAuthStore } from './store/auth';

// BUG-04: Use auth store directly instead of reading from localStorage
// The token is kept in memory only for security (prevents XSS token theft)
const PrivateRoute = ({ children }: { children: React.ReactNode }) => {
  const token = useAuthStore((state) => state.token);
  return token ? <>{children}</> : <Navigate to="/login" replace />;
};

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: <PrivateRoute><MainLayout /></PrivateRoute>,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'tasks', element: <TaskListPage /> },
      { path: 'tasks/new', element: <TaskFormPage /> },
      { path: 'tasks/:id', element: <TaskDetailPage /> },
      { path: 'tasks/:id/edit', element: <TaskFormPage /> },
      { path: 'tasks/:taskId/executions/:execId', element: <ExecutionDetailPage /> },
      { path: 'executors', element: <ExecutorListPage /> },
      { path: 'executors/:id', element: <ExecutorDetailPage /> },
      { path: 'users', element: <UserListPage /> },
      { path: 'registry', element: <RegistryPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'notification', element: <NotificationSettingsPage /> },
      { path: 'audit', element: <AuditLogPage /> },
    ],
  },
]);
