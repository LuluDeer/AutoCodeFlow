/**
 * QA-03 第一阶段：UserManagementPage 组件测试扩面（此前零覆盖）。
 *
 * 覆盖核心交互：
 *  1) 列表渲染（角色 Tag 中文映射 / 禁用状态 Tag / 邮箱缺省占位）；
 *  2) 搜索走后端 search 参数（关键词透传 + 命中过滤 + 无匹配文案）；
 *  3) 新建用户（表单校验失败路径：弱密码被拦 + 成功路径：payload 精确）；
 *  4) 编辑用户（预填 + update 调用）；
 *  5) 删除（Popconfirm 确认 → remove(id)，对齐 settings.history-rollback 先例）；
 *  6) 重置密码（确认不一致 →「两次密码不一致」校验；成功 → update password）；
 *  7) mutation 失败 → 错误 toast。
 *
 * useQuery/useMutation 页面：QueryClientProvider 包裹（对齐 settings.ai 先例），
 * api 层 mock（usersApi）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import UserManagementPage from '../pages/UserManagementPage';
import { usersApi } from '../api/users';
import type { User } from '../api/users';

vi.mock('../api/users', () => ({
  usersApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
}));
const mockedUsers = vi.mocked(usersApi, true);

// jsdom 缺失 antd 依赖的浏览器 API（既有先例 shim）
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

const makeUser = (over: Partial<User> & { isActive?: boolean }): User & { isActive?: boolean } => ({
  id: 1,
  username: 'alice',
  email: 'alice@example.com',
  role: 'admin',
  createdAt: '2026-09-01T08:00:00Z',
  updatedAt: '2026-09-01T08:00:00Z',
  ...over,
});

const usersFixture = [
  makeUser({ id: 1, username: 'alice', role: 'admin', isActive: true }),
  makeUser({ id: 2, username: 'bob', email: 'bob@corp.io', role: 'user', isActive: true }),
  makeUser({ id: 3, username: 'carol', email: '', role: 'user', isActive: false }),
];

function renderPage(initialEntry = '/users') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    // URL-SYNC-01：页面读/写 useSearchParams——包 MemoryRouter 提供路由上下文
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <UserManagementPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const findBtn = (root: ParentNode, text: string): HTMLButtonElement | null =>
  (Array.from(root.querySelectorAll('button')) as HTMLButtonElement[]).find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === text,
  ) ?? null;

/** Popconfirm 确认键精确匹配（对齐 settings.history-rollback 先例） */
async function confirmPopconfirm(titleText: string) {
  const anchor = await screen.findByText(titleText);
  const layer = (anchor.closest('.ant-popover') ??
    anchor.closest('[class*="popconfirm"]') ??
    document.body) as HTMLElement;
  const layerBtns = Array.from(layer.querySelectorAll('button')) as HTMLButtonElement[];
  const okBtn = layerBtns[layerBtns.length - 1];
  expect(okBtn).toBeTruthy();
  fireEvent.click(okBtn);
}

beforeEach(() => {
  mockedUsers.list.mockReset().mockResolvedValue({ list: usersFixture, total: 3, page: 1, pageSize: 20 });
  mockedUsers.create.mockReset();
  mockedUsers.update.mockReset();
  mockedUsers.remove.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('UserManagementPage 列表渲染（QA-03）', () => {
  it('渲染角色 Tag 中文、禁用状态 Tag、邮箱缺省占位与分页 total', async () => {
    renderPage();
    expect(await screen.findByText('alice')).toBeTruthy();
    expect(screen.getByText('管理员')).toBeTruthy();
    expect(screen.getAllByText('普通用户').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('已禁用')).toBeTruthy();
    expect(screen.getAllByText('正常').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('bob@corp.io')).toBeTruthy();
    expect(screen.getByText('共 3 条')).toBeTruthy();
  });

  it('搜索走后端 search 参数：关键词透传、命中过滤、无匹配文案', async () => {
    // USER-SEARCH-01：搜索改为后端过滤（username/email ILIKE）——原先在前端
    // filter 当页数据，用户数超过一页时结果不完整。mock 按第 4 个参数
    // （search）模拟服务端行为，断言页面透传关键词且不再本地过滤。
    mockedUsers.list.mockImplementation((_page, _pageSize, _signal, search) => {
      const filtered = search
        ? usersFixture.filter((u) =>
            u.username.toLowerCase().includes(search.toLowerCase()) ||
            (u.email ?? '').toLowerCase().includes(search.toLowerCase()))
        : usersFixture;
      return Promise.resolve({ list: filtered, total: filtered.length, page: 1, pageSize: 20 });
    });
    renderPage();
    await screen.findByText('alice');
    fireEvent.change(screen.getByPlaceholderText('搜索用户名或邮箱'), {
      target: { value: 'bob' },
    });
    // 关键词经防抖透传给后端 list，且页码重置为 1
    await waitFor(() => {
      expect(mockedUsers.list).toHaveBeenCalledWith(1, 20, expect.anything(), 'bob');
    });
    await waitFor(() => {
      expect(screen.queryByText('alice')).toBeNull();
      expect(screen.getByText('bob')).toBeTruthy();
    });
    fireEvent.change(screen.getByPlaceholderText('搜索用户名或邮箱'), {
      target: { value: 'zzz' },
    });
    await waitFor(() => {
      expect(screen.getByText('没有匹配的用户')).toBeTruthy();
    });
  });
});

describe('UserManagementPage 新建用户（QA-03）', () => {
  it('弱密码被表单校验拦截：不调用 usersApi.create，显示规则提示', async () => {
    renderPage();
    await screen.findByText('alice');
    fireEvent.click(screen.getByText('新建用户'));

    fireEvent.change(screen.getByPlaceholderText('请输入用户名'), { target: { value: 'dave' } });
    fireEvent.change(screen.getByPlaceholderText('请输入密码'), { target: { value: 'weak' } });
    // UI-15：handleCreateSubmit 已补 .catch（isFormValidationError 分支静默，
    // 由 Form 红字呈现）——不再产生 unhandled rejection，无需 process 级监听兜底。
    fireEvent.click(findBtn(document.body, '创建')!);

    await screen.findByText('密码至少8个字符');
    expect(mockedUsers.create).not.toHaveBeenCalled();
  });

  it('合法提交：create 收到 username/password/email/role payload 并提示成功', async () => {
    mockedUsers.create.mockResolvedValue(makeUser({}) as never);
    renderPage();
    await screen.findByText('alice');
    fireEvent.click(screen.getByText('新建用户'));

    fireEvent.change(screen.getByPlaceholderText('请输入用户名'), { target: { value: 'dave' } });
    fireEvent.change(screen.getByPlaceholderText('请输入密码'), { target: { value: 'Str0ng!Pass' } });
    // P1-4：新建态后端 @IsEmail() 必填——表单同步补必填规则，合法邮箱随 payload 上送
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'dave@corp.io' } });
    fireEvent.click(findBtn(document.body, '创建')!);

    await waitFor(() => {
      expect(mockedUsers.create).toHaveBeenCalledTimes(1);
    });
    const dto = mockedUsers.create.mock.calls[0][0];
    expect(dto.username).toBe('dave');
    expect(dto.password).toBe('Str0ng!Pass');
    expect(dto.email).toBe('dave@corp.io');
    expect(dto.role).toBe('user'); // Select 初始值
    expect(await screen.findByText('用户创建成功')).toBeTruthy();
  });

  it('create 失败 → 错误 toast（defaultMsg「创建失败」）', async () => {
    mockedUsers.create.mockRejectedValue(new Error('用户名已存在'));
    renderPage();
    await screen.findByText('alice');
    fireEvent.click(screen.getByText('新建用户'));

    fireEvent.change(screen.getByPlaceholderText('请输入用户名'), { target: { value: 'dave' } });
    fireEvent.change(screen.getByPlaceholderText('请输入密码'), { target: { value: 'Str0ng!Pass' } });
    // P1-4：新建态邮箱必填，先填合法邮箱才能到达后端失败路径
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'dave@corp.io' } });
    fireEvent.click(findBtn(document.body, '创建')!);

    await waitFor(() => {
      expect(mockedUsers.create).toHaveBeenCalled();
    });
    // getErrMsg 提取 Error.message
    await screen.findByText('用户名已存在');
  });

  it('P1-4：新建态邮箱必填+格式校验（对应后端 @IsEmail()）：空/非法都被拦截，不调用 create', async () => {
    renderPage();
    await screen.findByText('alice');
    fireEvent.click(screen.getByText('新建用户'));

    fireEvent.change(screen.getByPlaceholderText('请输入用户名'), { target: { value: 'dave' } });
    fireEvent.change(screen.getByPlaceholderText('请输入密码'), { target: { value: 'Str0ng!Pass' } });
    // 邮箱留空 → required 规则拦截（此前新建态零校验，400 只弹原始后端 toast）
    fireEvent.click(findBtn(document.body, '创建')!);
    await screen.findByText('请输入邮箱');
    expect(mockedUsers.create).not.toHaveBeenCalled();

    // 邮箱非法 → type: 'email' 规则拦截
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'not-an-email' } });
    fireEvent.click(findBtn(document.body, '创建')!);
    await screen.findByText('请输入有效邮箱');
    expect(mockedUsers.create).not.toHaveBeenCalled();
  });
});

describe('UserManagementPage 编辑用户（QA-03）', () => {
  it('编辑预填表单且不显示密码字段，保存调用 update(id, dto)', async () => {
    mockedUsers.update.mockResolvedValue(makeUser({}) as never);
    renderPage();
    await screen.findByText('alice');

    const row = screen.getByText('alice').closest('tr') as HTMLElement;
    fireEvent.click(findBtn(row, '编辑')!);

    // 预填
    expect((screen.getByPlaceholderText('请输入用户名') as HTMLInputElement).value).toBe('alice');
    // 编辑态无密码输入
    expect(screen.queryByPlaceholderText('请输入密码')).toBeNull();

    fireEvent.click(findBtn(document.body, '保存')!);
    await waitFor(() => {
      expect(mockedUsers.update).toHaveBeenCalledWith(1, expect.objectContaining({ username: 'alice' }));
    });
    expect(await screen.findByText('更新成功')).toBeTruthy();
  });
});

describe('UserManagementPage 删除用户（QA-03）', () => {
  it('Popconfirm 确认后调用 remove(id) 并提示成功', async () => {
    mockedUsers.remove.mockResolvedValue({ deleted: true } as never);
    renderPage();
    await screen.findByText('alice');

    const row = screen.getByText('bob').closest('tr') as HTMLElement;
    fireEvent.click(findBtn(row, '删除')!);
    await confirmPopconfirm('确认删除');
    await waitFor(() => {
      expect(mockedUsers.remove).toHaveBeenCalledWith(2);
    });
    expect(await screen.findByText('用户已删除')).toBeTruthy();
  });
});

describe('UserManagementPage 重置密码（QA-03）', () => {
  it('两次密码不一致 → 校验拦截，不调用 update', async () => {
    renderPage();
    await screen.findByText('alice');

    const row = screen.getByText('alice').closest('tr') as HTMLElement;
    fireEvent.click(findBtn(row, '重置密码')!);
    // Modal 标题为「重置密码 — alice」；输入框出现即视为 modal 已开
    // （标题文案与行内按钮同名，findByText 会多命中）
    await screen.findByPlaceholderText('请输入新密码');

    fireEvent.change(screen.getByPlaceholderText('请输入新密码'), { target: { value: 'NewPass1!' } });
    fireEvent.change(screen.getByPlaceholderText('再次输入新密码'), { target: { value: 'NewPass2!' } });
    // UI-15：handleResetPwdSubmit 已补 .catch（isFormValidationError 静默）
    fireEvent.click(findBtn(document.body, '确认重置')!);

    await screen.findByText('两次密码不一致');
    expect(mockedUsers.update).not.toHaveBeenCalled();
  });

  it('一致 → update(id, { password }) 成功提示「密码已重置」', async () => {
    mockedUsers.update.mockResolvedValue(makeUser({}) as never);
    renderPage();
    await screen.findByText('alice');

    const row = screen.getByText('alice').closest('tr') as HTMLElement;
    fireEvent.click(findBtn(row, '重置密码')!);
    await screen.findByPlaceholderText('请输入新密码');

    fireEvent.change(screen.getByPlaceholderText('请输入新密码'), { target: { value: 'NewPass1!' } });
    fireEvent.change(screen.getByPlaceholderText('再次输入新密码'), { target: { value: 'NewPass1!' } });
    fireEvent.click(findBtn(document.body, '确认重置')!);

    await waitFor(() => {
      expect(mockedUsers.update).toHaveBeenCalledWith(1, { password: 'NewPass1!' });
    });
    expect(await screen.findByText('密码已重置')).toBeTruthy();
  });
});

// ─── UX 边界回归（本轮全站打磨）───────────────────────────────────────────
describe('UserManagementPage 空页钳制与 URL 同步（UX 边界）', () => {
  it('删除某页最后一条 → page 状态回退上一页，list 以 page-1 重新拉取', async () => {
    // 41 个用户、pageSize 20 → 第 3 页只有 1 条；删除后第 3 页消失，
    // 若不回退页码，受控分页仍按 page=3 拉取 → 空表空页。
    const pool = Array.from({ length: 20 }, (_, i) => makeUser({ id: i + 10, username: `user${i}` }));
    mockedUsers.list.mockImplementation((page) =>
      Promise.resolve(
        page === 3
          ? { list: [makeUser({ id: 99, username: 'zoe' })], total: 41, page: 3, pageSize: 20 }
          : { list: pool, total: 41, page: page ?? 1, pageSize: 20 },
      ),
    );
    mockedUsers.remove.mockResolvedValue({ deleted: true } as never);
    renderPage('/users?page=3');
    await screen.findByText('zoe');

    const row = screen.getByText('zoe').closest('tr') as HTMLElement;
    fireEvent.click(findBtn(row, '删除')!);
    await confirmPopconfirm('确认删除');
    await waitFor(() => expect(mockedUsers.remove).toHaveBeenCalledWith(99));

    await waitFor(() => {
      expect(mockedUsers.list).toHaveBeenCalledWith(2, 20, expect.anything(), undefined);
    });
  });

  it('URL-SYNC-01：page/q 深链初始化 list 参数（刷新/分享不丢状态）', async () => {
    renderPage('/users?page=2&q=bob');
    await waitFor(() => {
      expect(mockedUsers.list).toHaveBeenCalledWith(2, 20, expect.anything(), 'bob');
    });
  });
});
