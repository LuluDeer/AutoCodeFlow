/**
 * R6 门控基建组件测试：RequireAdmin（round5 引入，round6 起覆盖 /notifications）。
 * 契约：role 未知 → 加载态（不闪现 403、不渲染 children）；
 * role 非 admin → 403 提示页；role=admin → 放行 children。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import RequireAdmin from '../components/RequireAdmin';
import { useAuthStore } from '../store/auth';

const renderGated = () =>
  render(
    <MemoryRouter>
      <RequireAdmin>
        <div>admin-only-content</div>
      </RequireAdmin>
    </MemoryRouter>,
  );

beforeEach(() => {
  useAuthStore.setState({ user: null });
});

afterEach(() => {
  cleanup();
});

describe('RequireAdmin', () => {
  it('role 尚未拉取（user 为空）：显示加载态，既不渲染 children 也不显示 403', () => {
    renderGated();
    expect(screen.queryByText('admin-only-content')).toBeNull();
    expect(screen.queryByText('403')).toBeNull();
  });

  it('普通用户（role=user）：渲染 403 提示页，不渲染 children', () => {
    useAuthStore.setState({ user: { id: 2, username: 'dev', role: 'user' } });
    renderGated();
    expect(screen.getByText('403')).toBeTruthy();
    expect(screen.getByText(/仅管理员可见/)).toBeTruthy();
    expect(screen.queryByText('admin-only-content')).toBeNull();
  });

  it('管理员（role=admin）：直接渲染 children', () => {
    useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
    renderGated();
    expect(screen.getByText('admin-only-content')).toBeTruthy();
    expect(screen.queryByText('403')).toBeNull();
  });
});
