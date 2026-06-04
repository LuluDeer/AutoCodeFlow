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
import DashboardPage from './pages/DashboardPage';
import RegistryPage from './pages/RegistryPage';
import SettingsPage from './pages/settings/index';
import AuditLogPage from './pages/audit/index';

// S-06: read auth state from Zustand store (persisted under key 'autoflow-auth'),
// not from a separate 'token' key, to ensure a single source of truth.
function getPersistedToken(): string | null {
  try {
    const raw = localStorage.getItem('autoflow-auth');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: { token?: string | null } };
    return parsed?.state?.token ?? null;
  } catch {
    return null;
  }
}

const PrivateRoute = ({ children }: { children: React.ReactNode }) =>
  getPersistedToken() ? <>{children}</> : <Navigate to="/login" replace />;

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
      { path: 'users', element: <UserListPage /> },
      { path: 'registry', element: <RegistryPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'audit', element: <AuditLogPage /> },
    ],
  },
]);
