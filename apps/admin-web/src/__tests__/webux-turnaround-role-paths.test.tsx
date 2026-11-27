/**
 * WEBUX-TURNAROUND：角色可见性与 403 返回路径。
 * 验收级别：单测 / 内存替身（不触网）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { paletteRoutes, shellMenuRoutes, homePathForRole } from '../routes/route-registry';
import RequireAdmin from '../components/RequireAdmin';
import { RoleHomeRedirect } from '../layouts/RoleHomeRedirect';
import { useAuthStore } from '../store/auth';
import { setLanguage } from '../i18n';

function Probe() {
  const location = useLocation();
  return <div data-testid="route-probe">{location.pathname}</div>;
}

beforeEach(async () => {
  await setLanguage('zh');
  useAuthStore.setState({ token: null, user: null, profileError: null });
});

afterEach(async () => {
  cleanup();
  await setLanguage('zh');
});

describe('角色死路修复', () => {
  it('USER 命令面板可达集合 ⊆ 侧栏集合，且不含 ADMIN 页', () => {
    const palette = paletteRoutes(false).map((route) => route.path);
    const shell = shellMenuRoutes(false).map((route) => route.path);
    for (const path of palette) expect(shell).toContain(path);
    expect(palette).not.toContain('/users');
    expect(palette).not.toContain('/audit');
    expect(palette).not.toContain('/sops');
    expect(palette).not.toContain('/projects');
    expect(palette).toContain('/workbench');
    expect(palette).toContain('/inbox');
  });

  it('ADMIN 面板仍可达显式 shellVisible:[] 的深链，但侧栏不显示', () => {
    const palette = paletteRoutes(true).map((route) => route.path);
    const shell = shellMenuRoutes(true).map((route) => route.path);
    expect(palette).toContain('/sops/from-video');
    expect(shell).not.toContain('/sops/from-video');
    expect(shell).toContain('/users');
  });

  it('403 返回按角色跳：USER 去 /workbench，ADMIN 去 /dashboard', () => {
    useAuthStore.setState({
      user: { id: 2, username: 'dev', role: 'user' },
      profileError: null,
    });
    const userView = render(
      <MemoryRouter initialEntries={['/users']}>
        <RequireAdmin><div>protected</div></RequireAdmin>
        <Probe />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: '返回我的首页' }));
    expect(screen.getByTestId('route-probe').textContent).toBe(homePathForRole('user'));
    userView.unmount();

    useAuthStore.setState({
      user: { id: 1, username: 'root', role: 'admin' },
      profileError: null,
    });
    render(
      <MemoryRouter initialEntries={['/users']}>
        <RequireAdmin><div>protected</div></RequireAdmin>
        <Probe />
      </MemoryRouter>,
    );
    expect(screen.queryByText('返回我的首页')).toBeNull();
  });

  it('role 未确定且有 token 时，RoleHomeRedirect 停在骨架屏而不首帧跳 /workbench', () => {
    useAuthStore.setState({
      token: 'token-fixture',
      user: { id: 1, username: 'admin', email: 'a@example.com' },
      profileError: null,
    });
    render(
      <MemoryRouter initialEntries={['/']}>
        <RoleHomeRedirect />
        <Probe />
      </MemoryRouter>,
    );
    expect(document.querySelector('.ant-skeleton')).not.toBeNull();
    expect(screen.getByTestId('route-probe').textContent).toBe('/');
  });
});
