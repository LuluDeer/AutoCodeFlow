/**
 * AUTH-02 后续：ProjectsPage 渲染回归（列表/我的角色徽标/成员抽屉门控/错误态）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ProjectsPage from '../pages/ProjectsPage';
import { projectsApi, type ProjectViewRow } from '../api/projects';
import { usersApi } from '../api/users';

// 与后端读面过滤一致的可控主体：user 为 null 视作普通用户。
const authState: { user: { id: number; role?: string } | null } = { user: null };
vi.mock('../store/auth', () => ({
  isAdminUser: (u: { role?: string } | null | undefined) => u?.role === 'admin',
  useAuthStore: (sel: (s: unknown) => unknown) => sel(authState),
}));

vi.mock('../api/projects', () => ({
  projectsApi: {
    list: vi.fn(),
    getMembers: vi.fn(),
    addMember: vi.fn(),
    updateMember: vi.fn(),
    removeMember: vi.fn(),
    listMyRoles: vi.fn(),
  },
}));
vi.mock('../api/users', () => ({
  usersApi: { list: vi.fn() },
}));

// jsdom 缺失 antd 依赖的浏览器 API（对齐 task-templates-page.test 先例）。
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
    matches: false,
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function makeProject(overrides: Partial<ProjectViewRow> = {}): ProjectViewRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    name: 'Default',
    description: '未分配资源的归属项目',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    myRole: null,
    ...overrides,
  };
}

const renderPage = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ProjectsPage />
    </QueryClientProvider>,
  );

beforeEach(() => {
  authState.user = null;
  vi.mocked(projectsApi.list).mockReset().mockResolvedValue([
    makeProject(),
    makeProject({
      id: 'aaaa0000-0000-4000-8000-000000000002',
      name: 'Alpha',
      description: null,
      myRole: 'editor',
    }),
  ]);
  vi.mocked(projectsApi.getMembers).mockReset().mockResolvedValue([
    {
      id: 'm1',
      projectId: 'aaaa0000-0000-4000-8000-000000000002',
      userId: 7,
      role: 'editor',
      createdAt: '2026-09-02T00:00:00.000Z',
    },
  ]);
  vi.mocked(usersApi.list).mockReset().mockResolvedValue({
    list: [{ id: 7, username: 'alice', email: 'a@x', role: 'user', createdAt: '', updatedAt: '' }],
    total: 1,
    page: 1,
    pageSize: 200,
  });
});

afterEach(() => {
  cleanup();
});

describe('ProjectsPage（AUTH-02 后续）', () => {
  it('渲染项目列表与「我的角色」徽标（成员 editor / 非成员 —）', async () => {
    renderPage();
    expect(await screen.findByText('Default')).toBeTruthy();
    expect(screen.getByText('Alpha')).toBeTruthy();
    // viewer 行 myRole=null → 占位破折号；Alpha 行 → 编辑者
    expect(screen.getByText('编辑者')).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
  });

  it('普通用户打开成员抽屉：只读（无添加成员表单）', async () => {
    renderPage();
    const memberButtons = await screen.findAllByRole('button', { name: /成员/ });
    fireEvent.click(memberButtons[0]);

    expect(await screen.findByText('7')).toBeTruthy();
    // 图标 aria 会并入可访问名，用正则匹配「添加成员」提交按钮
    expect(screen.queryByRole('button', { name: /添加成员/ })).toBeNull();
  });

  it('ADMIN 打开成员抽屉：渲染添加成员表单', async () => {
    authState.user = { id: 1, role: 'admin' };
    renderPage();
    const memberButtons = await screen.findAllByRole('button', { name: /成员/ });
    fireEvent.click(memberButtons[0]);

    expect(await screen.findByRole('button', { name: /添加成员/ })).toBeTruthy();
  });

  it('列表加载失败 → StateError 页内错误块（带重试）', async () => {
    vi.mocked(projectsApi.list).mockReset().mockRejectedValue(new Error('boom'));
    renderPage();

    // UI-16 约定：StateError 标题 + 重试按钮
    expect(await screen.findByText('加载失败')).toBeTruthy();
    expect(screen.getByRole('button', { name: /重试/ })).toBeTruthy();
  });

  it('NETOPT-F P3: 成员移除成功后失效 members(id) + list（行为测试锁）', async () => {
    // 行为测试锁：把 invalidate() 的失效键放宽成 ['projects']（v5 前缀语义会
    // 连带 members/candidate-users 级联刷新）或删掉任一 invalidate，本用例
    // 立即变红。NETOPT-D P3 判定"成员变化影响 myRole"只有这里锁住。
    authState.user = { id: 1, role: 'admin' };
    vi.mocked(projectsApi.removeMember).mockReset().mockResolvedValue(undefined as never);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ProjectsPage />
      </QueryClientProvider>,
    );
    const memberButtons = await screen.findAllByRole('button', { name: /成员/ });
    fireEvent.click(memberButtons[0]);
    await screen.findByText('7');
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    fireEvent.click(await screen.findByRole('button', { name: /移除/ }));
    await waitFor(() => expect(projectsApi.removeMember).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          queryKey: ['projects', 'members', '00000000-0000-0000-0000-000000000001'],
        }),
      ),
    );
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['projects', 'list'] }),
    );
  });
});
