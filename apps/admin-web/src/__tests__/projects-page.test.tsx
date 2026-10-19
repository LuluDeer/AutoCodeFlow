/**
 * AUTH-02 后续：ProjectsPage 渲染回归（列表/我的角色徽标/成员抽屉门控/错误态）。
 * R3 追加：服务端分页（信封 mock）+ URL-SYNC-01（深链初始源/状态回写/默认值不写入）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, RouterProvider, createMemoryRouter } from 'react-router-dom';
// 仅用于 afterEach 的 destroyAll（清掉命令式 Modal.confirm 的 body 级 holder）
import { Modal } from 'antd';
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
    // PROJECT-CRUD-01：新建/编辑/删除入口（后端 POST/PATCH/DELETE /projects）
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    // PROJECT-IMPACT-01：删除影响面预览（删除前先报数）
    removalImpact: vi.fn(),
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
  // 删除确认框走 `Modal.confirm`（命令式）：它挂到 body 上的独立 holder，
  // **不在 React 根里**，`cleanup()` 清不掉。而且它的关闭带 zoom 动画，
  // jsdom 里动画不会自然结束，节点会残留——下一个用例的查询就会读到
  // **上一个**用例的弹框（表现为文案是别人家的、按钮取不到）。
  // 故这里既 destroyAll 又强制摘掉残留节点（双重保险，见 makeDeleteDialog）。
  Modal.destroyAll();
  document.querySelectorAll('.ant-modal-wrap, .ant-modal-root').forEach((n) => n.remove());
});

/** antd 会给两个中文字符之间插空格（「删除」→「删 除」），断言前先归一。 */
const norm = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, '');

/** 气泡的确定键（Popconfirm 的按钮容器是 .ant-popconfirm-buttons）。 */
function popOkButton(): HTMLButtonElement {
  return Array.from(
    document.querySelectorAll('.ant-popconfirm-buttons button'),
  ).pop() as HTMLButtonElement;
}

/**
 * 取删除**详情**弹窗（`<Modal>` 组件形态，非命令式 Modal.confirm）。
 *
 * 三个坑都要绕开：
 *  ① 页面里还有一个 `forceRender` 的「新建/编辑」Modal（确定键是「保存」），
 *    它**永远在 DOM 里**，不能用 `findByRole('dialog')` 无差别取；
 *  ② 详情弹窗是 `<Modal>` 组件 → 类名 `.ant-modal`（**没有** `-confirm` 后缀），
 *    按钮在 `.ant-modal-footer`；
 *  ③ 它的标题是「删除项目「X」的影响」——按标题里的『的影响』精确定位，
 *    避免和新建/编辑弹窗混淆。
 */
async function findDeleteDialog(): Promise<HTMLElement> {
  return waitFor(() => {
    const all = Array.from(document.querySelectorAll('.ant-modal')).filter((m) =>
      (m.textContent ?? '').includes('的影响'),
    );
    expect(all.length).toBeGreaterThan(0);
    return all[all.length - 1] as HTMLElement;
  });
}

/** 详情弹窗的「确认删除」按钮（组件形态的按钮容器是 .ant-modal-footer）。 */
function deleteDialogOk(dialog: HTMLElement): HTMLButtonElement {
  const btns = Array.from(
    dialog.querySelectorAll('.ant-modal-footer button'),
  ) as HTMLButtonElement[];
  expect(btns.length).toBe(2);
  return btns[btns.length - 1];
}

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

// ─── PROJECT-CRUD-01：新建 / 编辑 / 删除入口（生产反馈「没看到可以新增或别的操作」）───
//
// 后端 POST/PATCH/DELETE /projects 一直是 ADMIN-only 可用状态，但前端全站没有
// 入口——页面只有每行的「成员」。本组用例锁住三件事：
//  ① 入口存在且**按角色门控**（普通用户看不到/点不动，与成员写面同一道闸）；
//  ② 默认项目恒不可改名/删除（后端 404 PROJECT_DEFAULT_IMMUTABLE），界面提前置灰；
//  ③ 请求真的发出去了（参数形状与后端 DTO 对齐），不是只渲染了按钮。
describe('ProjectsPage 项目增删改（PROJECT-CRUD-01）', () => {
  /** 弹窗确定键：antd v6 的 okText 在无 ConfigProvider 时是英文 OK，取 footer 末个按钮。 */
  const modalOkBtn = (): HTMLButtonElement =>
    Array.from(document.body.querySelectorAll('.ant-modal-footer button')).pop() as HTMLButtonElement;

  it('ADMIN：页头「新建项目」打开弹窗，保存发出 create（name/description 归一）', async () => {
    authState.user = { id: 1, role: 'admin' };
    vi.mocked(projectsApi.create).mockReset().mockResolvedValue({
      id: 'p-new', name: '数据平台组', description: null,
      createdAt: '', updatedAt: '',
    } as never);
    renderPage();

    expect(await screen.findByText('Default')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /新建项目/ }));
    expect(await screen.findByText('新建项目', { selector: '.ant-modal-title' })).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('例如：数据平台组'), {
      target: { value: '  数据平台组  ' },
    });
    fireEvent.change(
      screen.getByPlaceholderText('这个项目用来归集哪些任务与应用（可选）'),
      { target: { value: ' 画像宽表  ' } },
    );
    fireEvent.click(modalOkBtn());

    await waitFor(() => expect(projectsApi.create).toHaveBeenCalledTimes(1));
    // 前后空白被 trim（后端 name 唯一索引是逐字节比较，'  X  ' 与 'X' 是两行）
    expect(projectsApi.create).toHaveBeenCalledWith({
      name: '数据平台组',
      description: '画像宽表',
    });
  });

  it('ADMIN：行内「编辑」回填既有值，保存发出 update（带 id）', async () => {
    authState.user = { id: 1, role: 'admin' };
    vi.mocked(projectsApi.update).mockReset().mockResolvedValue({} as never);
    renderPage();
    await screen.findByText('Alpha');

    // 行序为 [Default, Alpha]；Default 的编辑按钮**置灰**（后端拒绝改名），
    // 故取可用的那个。这里顺带把「默认项目行置灰」钉住。
    const editButtons = (await screen.findAllByRole('button', { name: /编辑/ })) as HTMLButtonElement[];
    expect(editButtons[0].disabled).toBe(true);
    expect(editButtons[1].disabled).toBe(false);
    fireEvent.click(editButtons[1]);
    expect(await screen.findByText('编辑项目', { selector: '.ant-modal-title' })).toBeTruthy();

    const nameInput = screen.getByPlaceholderText('例如：数据平台组') as HTMLInputElement;
    // 回填：弹窗打开即带出该行名称（否则「编辑」会静默清空名字）
    await waitFor(() => expect(nameInput.value).toBe('Alpha'));

    fireEvent.change(nameInput, { target: { value: 'Alpha 改' } });
    fireEvent.click(modalOkBtn());
    await waitFor(() => expect(projectsApi.update).toHaveBeenCalledTimes(1));
    expect(projectsApi.update).toHaveBeenCalledWith(
      'aaaa0000-0000-4000-8000-000000000002',
      expect.objectContaining({ name: 'Alpha 改' }),
    );
  });

  /**
   * PROJECT-IMPACT-01 · 方案 B-lite：气泡即时出现 + 影响面在气泡内长出，
   * 非空项目再展开 Modal 详情。
   *
   * 为什么不是「先拉数据再弹 Modal」：那样点击到弹窗之间有一个网络往返，
   * 期间界面**零反馈**，用户以为按钮坏了会再点一次。本组用例钉的就是
   * 「首帧就有反馈」和「数字到位后才允许确认」。
   */
  it('ADMIN 非空项目：气泡即时出现→气泡内报数→「查看影响并删除」展开 Modal→确认才发 remove', async () => {
    authState.user = { id: 1, role: 'admin' };
    // 影响面延迟返回，以便观察「加载中」这一帧
    let resolveImpact: (v: unknown) => void = () => {};
    vi.mocked(projectsApi.removalImpact).mockReset().mockReturnValue(
      new Promise((res) => {
        resolveImpact = res;
      }) as never,
    );
    vi.mocked(projectsApi.remove).mockReset().mockResolvedValue({ deleted: true } as never);
    renderPage();
    await screen.findByText('Default');

    const deleteButtons = (await screen.findAllByRole('button', { name: /删除/ })) as HTMLButtonElement[];
    // 第一行是默认项目（Default 在前）——置灰，且不会触发影响面拉取
    expect(deleteButtons[0].disabled).toBe(true);
    expect(deleteButtons[1].disabled).toBe(false);
    expect(projectsApi.removalImpact).not.toHaveBeenCalled();

    fireEvent.click(deleteButtons[1]);

    // ① 气泡**同步**出现（不等网络）：标题已经在了
    expect(await screen.findByText('确认删除项目「Alpha」？')).toBeTruthy();
    // ② 影响面请求已发出，气泡里是加载态
    await waitFor(() =>
      expect(projectsApi.removalImpact).toHaveBeenCalledWith('aaaa0000-0000-4000-8000-000000000002'),
    );
    expect(document.body.textContent).toContain('正在统计影响…');
    // ③ 数据没回来时确定键**禁用**——不知道后果就不许确认，这正是本功能的意义
    expect(popOkButton().disabled).toBe(true);

    // ④ 数据到位：数字就地替换加载态，确定键可用且文案诚实（不是「删除」）
    resolveImpact({ projectName: 'Alpha', taskCount: 12, activeTaskCount: 7, memberCount: 3, deletable: true });
    await waitFor(() => expect(document.body.textContent).not.toContain('正在统计影响…'));
    expect(document.body.textContent).toContain('12 个任务（7 个仍在启用）');
    expect(document.body.textContent).toContain('3 条成员关系');
    const ok = popOkButton();
    expect(ok.disabled).toBe(false);
    expect(norm(ok.textContent)).toContain('查看影响并删除');
    // 此时**还没**删——气泡的确定键只负责展开详情
    expect(projectsApi.remove).not.toHaveBeenCalled();

    // ⑤ 展开 Modal：完整句子 + 逐条后果
    fireEvent.click(ok);
    const dialog = await findDeleteDialog();
    expect(dialog.textContent).toContain('删除项目「Alpha」的影响');
    expect(dialog.textContent).toContain('12 个任务将失去项目归属');
    expect(projectsApi.remove).not.toHaveBeenCalled();

    // ⑥ 在 Modal 里最终确认才真正删除
    fireEvent.click(deleteDialogOk(dialog));
    await waitFor(() => expect(projectsApi.remove).toHaveBeenCalledTimes(1));
    expect(projectsApi.remove).toHaveBeenCalledWith('aaaa0000-0000-4000-8000-000000000002');
  });

  it('ADMIN 空项目：气泡自己说清（无任务无成员），一步删完，不弹第二个窗', async () => {
    authState.user = { id: 1, role: 'admin' };
    vi.mocked(projectsApi.removalImpact).mockReset().mockResolvedValue({
      projectName: 'Alpha', taskCount: 0, activeTaskCount: 0, memberCount: 0, deletable: true,
    } as never);
    vi.mocked(projectsApi.remove).mockReset().mockResolvedValue({ deleted: true } as never);
    renderPage();
    await screen.findByText('Default');

    fireEvent.click((await screen.findAllByRole('button', { name: /删除/ }))[1]);
    expect(await screen.findByText('确认删除项目「Alpha」？')).toBeTruthy();
    await waitFor(() => expect(document.body.textContent).toContain('该项目下没有任务或成员'));

    // 空项目的确定键就是「删除」——这一下真的删，没有第二道窗
    const ok = popOkButton();
    expect(norm(ok.textContent)).toContain('删除');
    expect(norm(ok.textContent)).not.toContain('查看影响');
    fireEvent.click(ok);
    await waitFor(() => expect(projectsApi.remove).toHaveBeenCalledTimes(1));
    // 没有展开详情弹窗（详情 Modal 的标题含「的影响」）
    expect(document.body.textContent).not.toContain('的影响');
  });

  it('影响面拉取失败不阻断删除：气泡降级为「未能获取」，仍可完成删除', async () => {
    authState.user = { id: 1, role: 'admin' };
    vi.mocked(projectsApi.removalImpact).mockReset().mockRejectedValue(new Error('boom'));
    vi.mocked(projectsApi.remove).mockReset().mockResolvedValue({ deleted: true } as never);
    renderPage();
    await screen.findByText('Default');

    fireEvent.click((await screen.findAllByRole('button', { name: /删除/ }))[1]);
    await waitFor(() => expect(document.body.textContent).toContain('影响面未能获取'));
    // 没编数字
    expect(document.body.textContent).not.toContain('个任务将失去项目归属');

    // 失败时确定键可用（预览是增强不是闸门），且走「一步删完」分支
    const ok = popOkButton();
    expect(ok.disabled).toBe(false);
    fireEvent.click(ok);
    await waitFor(() => expect(projectsApi.remove).toHaveBeenCalledTimes(1));
  });

  it('普通用户：新建按钮禁用、行内编辑/删除禁用（写面 ADMIN-only 的前端同姿态）', async () => {
    authState.user = { id: 2, role: 'user' };
    renderPage();
    await screen.findByText('Alpha');

    expect((screen.getByRole('button', { name: /新建项目/ }) as HTMLButtonElement).disabled).toBe(true);
    for (const btn of (await screen.findAllByRole('button', { name: /编辑/ })) as HTMLButtonElement[]) {
      expect(btn.disabled).toBe(true);
    }
    for (const btn of (await screen.findAllByRole('button', { name: /删除/ })) as HTMLButtonElement[]) {
      expect(btn.disabled).toBe(true);
    }
  });
});
