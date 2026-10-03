/**
 * AUTH-02 后续：ProjectsPage 渲染回归（列表/我的角色徽标/成员抽屉门控/错误态）。
 * R3 追加：服务端分页（信封 mock）+ URL-SYNC-01（深链初始源/状态回写/默认值不写入）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, RouterProvider, createMemoryRouter } from 'react-router-dom';
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
    listPaged: vi.fn(),
    getMembers: vi.fn(),
    addMember: vi.fn(),
    updateMember: vi.fn(),
    removeMember: vi.fn(),
    listMyRoles: vi.fn(),
  },
}));
vi.mock('../api/users', () => ({
  usersApi: { list: vi.fn(), listAll: vi.fn() },
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

/** 后端分页信封（paginate() 形状；list/items 双键是 R-21 遗留）。 */
function makePage(
  rows: ProjectViewRow[],
  opts: { total?: number; page?: number; pageSize?: number } = {},
) {
  const { total = rows.length, page = 1, pageSize = 20 } = opts;
  return {
    list: rows,
    items: rows,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

const renderPage = (initialEntry = '/projects') =>
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ProjectsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );

beforeEach(() => {
  authState.user = null;
  const rows = [
    makeProject(),
    makeProject({
      id: 'aaaa0000-0000-4000-8000-000000000002',
      name: 'Alpha',
      description: null,
      myRole: 'editor',
    }),
  ];
  vi.mocked(projectsApi.listPaged)
    .mockReset()
    .mockResolvedValue(makePage(rows));
  vi.mocked(projectsApi.getMembers).mockReset().mockResolvedValue([
    {
      id: 'm1',
      projectId: 'aaaa0000-0000-4000-8000-000000000002',
      userId: 7,
      role: 'editor',
      createdAt: '2026-09-02T00:00:00.000Z',
    },
  ]);
  vi.mocked(usersApi.listAll).mockReset().mockResolvedValue([
    { id: 7, username: 'alice', email: 'a@x', role: 'user', createdAt: '', updatedAt: '' },
  ]);
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
    vi.mocked(projectsApi.listPaged).mockReset().mockRejectedValue(new Error('boom'));
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
      <MemoryRouter initialEntries={['/projects']}>
        <QueryClientProvider client={queryClient}>
          <ProjectsPage />
        </QueryClientProvider>
      </MemoryRouter>,
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

// ─── UX 边界回归（本轮全站打磨）：候选用户拉取失败不再静默成空下拉 ──────────
describe('ProjectsPage 候选用户拉取失败（UX 边界）', () => {
  it('ADMIN 打开成员抽屉、listAll 拒绝 → 原位 StateError + 重试；重试成功后可选拉回', async () => {
    authState.user = { id: 1, role: 'admin' };
    vi.mocked(usersApi.listAll)
      .mockRejectedValueOnce(new Error('用户目录暂不可用'))
      .mockResolvedValueOnce([
        { id: 7, username: 'alice', email: 'a@x', role: 'user', createdAt: '', updatedAt: '' },
      ]);
    renderPage();
    const memberButtons = await screen.findAllByRole('button', { name: /成员/ });
    fireEvent.click(memberButtons[0]);

    // 失败 → 页内错误块（标题 + 重试），而非"没有可选用户"的假象
    expect(await screen.findByTestId('state-error')).toBeTruthy();
    expect(screen.getByText('候选用户列表加载失败')).toBeTruthy();

    fireEvent.click(screen.getByText('重试'));
    await waitFor(() => {
      expect(usersApi.listAll).toHaveBeenCalledTimes(2);
    });
    // 重试成功 → 错误块消失，下拉里出现候选用户
    await waitFor(() => {
      expect(screen.queryByTestId('state-error')).toBeNull();
    });
    // antd Select 选项仅在展开时渲染——打开下拉验证候选用户已拉回
    fireEvent.mouseDown(screen.getByText('选择要添加的用户'));
    expect(await screen.findByText('#7 alice', { selector: '.ant-select-item-option-content' })).toBeTruthy();
  });
});

// ─── R3：服务端分页 + URL-SYNC-01（对齐 UserManagementPage/AgentSessionsPage 先例）───
describe('ProjectsPage 服务端分页（R3）', () => {
  /** 独立 router 渲染：可断言 createMemoryRouter 的最终 URL 状态。 */
  function renderWithRouter(initialEntry = '/projects') {
    const router = createMemoryRouter(
      [{ path: '/projects', element: <ProjectsPage /> }],
      { initialEntries: [initialEntry] },
    );
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    return router;
  }

  it('翻页触发新请求（page=2 进入 listPaged），URL 回写 page、默认值不写入', async () => {
    vi.mocked(projectsApi.listPaged).mockReset().mockResolvedValue(
      // total=25、pageSize=20 → 两页，分页器才渲染第 2 页按钮
      makePage([makeProject()], { total: 25 }),
    );
    const router = renderWithRouter();
    expect(await screen.findByText('Default')).toBeTruthy();

    // 默认值（page=1/pageSize=20）不写入 URL，保持 URL 干净
    expect(router.state.location.search).toBe('');

    // antd 分页器第 2 页按钮；total=3/pageSize=20 → 两页
    // （对齐 app-deployment-race 先例：antd v6 分页项用 selector 点击）
    fireEvent.click(
      document.querySelector('.ant-pagination-item[title="2"]') as HTMLElement,
    );
    await waitFor(() =>
      expect(projectsApi.listPaged).toHaveBeenLastCalledWith(2, 20, expect.anything()),
    );
    // 状态→URL 回写：非默认 page 落 URL
    await waitFor(() => expect(router.state.location.search).toBe('?page=2'));
  });

  it('深链 ?page=2 以 URL 为初始源（非法深链 ?page=abc 回落默认 1 并洗净 URL）', async () => {
    renderWithRouter('/projects?page=2');
    await screen.findByText('Default');
    await waitFor(() =>
      expect(projectsApi.listPaged).toHaveBeenLastCalledWith(2, 20, expect.anything()),
    );
    cleanup();

    // abc 非整数、999 超 100 上限 → 双双回落默认 1/20；回落后默认值不留在 URL
    renderWithRouter('/projects?page=abc&pageSize=999');
    await screen.findByText('Default');
    await waitFor(() =>
      expect(projectsApi.listPaged).toHaveBeenLastCalledWith(1, 20, expect.anything()),
    );
  });

  it('深链 ?page=abc：URL 被回写洗净（默认值不写入，与 AgentSessionsPage 同口径）', async () => {
    const router = renderWithRouter('/projects?page=abc');
    await screen.findByText('Default');
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });
});
