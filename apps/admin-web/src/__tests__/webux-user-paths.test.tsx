/**
 * WEBUX 定向回归（单测 / 内存替身）：
 * - 普通用户 Inbox 不渲染 ADMIN-only 会话深链；
 * - 顶层 loadError 留下页内错误态与重试（不是一闪而过的 toast）；
 * - PrivateRoute hydration 未完成时不空白、不误跳登录；
 * - 侧栏菜单叶子与 route-registry.menuRoutes 对齐；
 * - 面包屑显示注册表/段名表的可读名称，不裸英文路径段。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n, { setLanguage } from '../i18n';
import InboxPage from '../pages/InboxPage';
import PrivateRoute from '../components/PrivateRoute';
import MainLayout from '../layouts/MainLayout';
import { loadInbox } from '../api/inbox';
import type { InboxSections } from '../api/inbox';
import { authApi } from '../api/auth';
import { useAuthStore } from '../store/auth';
import { menuRoutes } from '../routes/route-registry';

vi.mock('../api/inbox', { spy: true });
vi.mock('../api/auth', () => ({ authApi: { me: vi.fn() } }));
vi.mock('../utils/toast', () => ({
  message: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function readySections(stalled = false): InboxSections {
  const common = { status: 'ready' as const, items: [], error: null };
  return {
    deployments: { key: 'deployments', ...common },
    agentApprovals: { key: 'agentApprovals', ...common },
    agentWaiting: { key: 'agentWaiting', ...common },
    agentFailures: { key: 'agentFailures', ...common, total: 0 },
    sopClarifications: { key: 'sopClarifications', ...common, total: 0 },
    sopBlocked: { key: 'sopBlocked', ...common, total: 0 },
    stalled: { key: 'stalled', ...common },
    backlogged: { key: 'backlogged', ...common },
    queueStall: {
      key: 'queueStall',
      ...common,
      snapshot: {
        stalled,
        reason: stalled ? 'no-worker' : null,
        pendingJobs: stalled ? 2 : 0,
        degraded: false,
        degradedCounts: false,
        workersKnown: true,
      },
    },
    recentFailures: { key: 'recentFailures', ...common },
  };
}

function renderInbox() {
  return render(
    <MemoryRouter initialEntries={['/inbox']}>
      <Routes>
        <Route path="/inbox" element={<InboxPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderLayout(path = '/dashboard', role: 'admin' | 'user' = 'admin') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useAuthStore.setState({
    user: { id: role === 'admin' ? 1 : 2, username: role, role },
    refreshToken: `${role}-refresh`,
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="*" element={<MainLayout />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function menuLabels(): string[] {
  const menu = document.querySelector('.ant-menu') as HTMLElement | null;
  if (!menu) return [];
  return Array.from(menu.querySelectorAll<HTMLElement>('.ant-menu-title-content'))
    .map((node) => (node.textContent ?? '').trim())
    .filter(Boolean);
}

function openCollapsedGroups() {
  const titles = Array.from(document.querySelectorAll<HTMLElement>('.ant-menu-submenu-title'));
  for (const title of titles) {
    if (title.getAttribute('aria-expanded') !== 'true') fireEvent.click(title);
  }
}

beforeEach(async () => {
  await setLanguage('zh');
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(loadInbox).mockReset();
  vi.mocked(authApi.me).mockReset().mockRejectedValue(new Error('skip profile'));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAuthStore.getState().logout();
});

describe('WEBUX / Inbox 用户可见路径', () => {
  it('普通用户看不到 /agent-sessions 深链，管理员仍可跟进', async () => {
    useAuthStore.setState({ user: { id: 2, username: 'bob', role: 'user' } });
    vi.mocked(loadInbox).mockResolvedValue(readySections(true));
    renderInbox();

    await screen.findByTestId('inbox-section-queueStall');
    expect(document.querySelector('a[href="/agent-sessions"]')).toBeNull();

    cleanup();
    useAuthStore.setState({ user: { id: 1, username: 'admin', role: 'admin' } });
    vi.mocked(loadInbox).mockResolvedValue(readySections(true));
    renderInbox();

    await screen.findByTestId('inbox-section-queueStall');
    expect(document.querySelector('a[href="/agent-sessions"]')).not.toBeNull();
  });

  it('顶层 loadError 呈现页内 StateError 与重试', async () => {
    useAuthStore.setState({ user: { id: 2, username: 'bob', role: 'user' } });
    vi.mocked(loadInbox).mockRejectedValue(new Error('inbox top failed'));
    renderInbox();

    const errorBlock = await screen.findByTestId('state-error');
    expect(within(errorBlock).getByRole('button', { name: /重\s*试/ })).toBeTruthy();
    expect(screen.queryByTestId('page-skeleton')).toBeNull();
  });
});

describe('WEBUX / 首帧与导航', () => {
  it('PrivateRoute hydration 未完成时渲染骨架，完成后渲染受保护内容', async () => {
    useAuthStore.setState({ refreshToken: 'refresh-1', _hasHydrated: false });
    render(
      <MemoryRouter>
        <PrivateRoute>
          <div data-testid="protected-child">protected</div>
        </PrivateRoute>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('private-route-hydration-fallback')).toBeTruthy();
    expect(document.querySelector('.ant-skeleton')).not.toBeNull();

    await act(async () => {
      useAuthStore.setState({ _hasHydrated: true });
    });
    expect(screen.getByTestId('protected-child')).toBeTruthy();
    expect(screen.queryByTestId('private-route-hydration-fallback')).toBeNull();
  });

  it('侧栏叶子来自 route-registry.menuRoutes，admin-only 项按角色过滤', async () => {
    renderLayout('/dashboard', 'user');
    openCollapsedGroups();

    await waitFor(() => {
      const labels = menuLabels();
      for (const route of menuRoutes(false)) {
        expect(labels).toContain(i18n.t(route.labelKey));
      }
    });
    const userLabels = menuLabels();
    for (const route of menuRoutes(true).filter((r) => r.adminOnly)) {
      expect(userLabels).not.toContain(i18n.t(route.labelKey));
    }

    cleanup();
    renderLayout('/dashboard', 'admin');
    openCollapsedGroups();
    await waitFor(() => {
      const labels = menuLabels();
      for (const route of menuRoutes(true)) {
        expect(labels).toContain(i18n.t(route.labelKey));
      }
    });
  });

  it('面包屑显示可读名称，不显示 from-video 英文路径段', async () => {
    renderLayout('/sops/from-video', 'admin');
    const breadcrumb = await waitFor(() => {
      const node = document.querySelector('.ant-breadcrumb') as HTMLElement | null;
      expect(node).toBeTruthy();
      return node!;
    });

    expect(breadcrumb.textContent).toContain(i18n.t('nav.sops'));
    expect(breadcrumb.textContent).toContain(i18n.t('nav.fromVideo'));
    expect(breadcrumb.textContent).not.toContain('from-video');
  });
});
