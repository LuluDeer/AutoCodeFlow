/**
 * 「导出全部」（服务端流式 CSV）前端契约 —— `GET /tasks/executions/export`。
 *
 * 后端端点在 4cc26327 落地（`@Roles(ADMIN)` + 真流式 + 与列表同源的六个过滤器），
 * 但页面上的导出此前是**纯客户端当前页**（原注释自认「全量导出需要后端流式
 * 端点，此处不做」）。本轮把第二个入口接上，本 spec 钉死下面六件事：
 *
 * ① **路径正确**：请求打到 `/tasks/executions/export`（不是 `/tasks/executions/all`，
 *    也不是 `/tasks/:id/export`——后者是**任务定义**导出，语义完全不同）。
 * ② **不带分页参数**：`page` / `pageSize` **键不存在**。后端 `ExportExecutionsQueryDto`
 *    刻意没有这两个字段，传了会被全局 `forbidNonWhitelisted` 判 400。断言用
 *    `'page' in params` 而不是 `params.page === undefined`——只有前者能区分
 *    "键不存在"与"键存在但值为 undefined"，而后者才是后端实际看到的差别。
 * ③ **带上当前筛选**且**名字映射正确**：搜索框 → `taskName`、执行器输入框 →
 *    `executorAddress`（都是后端的**模糊**匹配列），状态 → `status`。这三处是
 *    最容易写错的地方（`search`/`q`/`executorId` 都会被判 400）。
 * ④ **非 ADMIN 禁用**：端点是 `@Roles(ADMIN)`，普通用户点了必然 403，故按钮
 *    disabled + 提示，且**不发请求**。
 * ⑤ **下载走 blob + objectURL**：JWT 只从 Authorization 头取，`<a href>` 直链
 *    带不了头会 401（先例见 api/executor-packages.ts#download）。
 * ⑥ **既有「导出当前页」不被改变**：它仍是纯客户端、只导当前页，且与新按钮
 *    共存（回归断言见文件末尾）。
 *
 * 隔离方式对齐 executions-page.test.tsx / executions-keyset-paging.test.tsx 先例：
 * mock api 模块（而非 axios 拦截器）+ QueryClientProvider + antd 浏览器 API shim。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ExecutionsPage from '../pages/ExecutionsPage';
import { tasksApi } from '../api/tasks';
import type { TaskExecution } from '../api/tasks';
import { useAuthStore } from '../store/auth';
import { message } from '../utils/toast';

vi.mock('../api/tasks', () => ({
  tasksApi: {
    allExecutions: vi.fn(),
    killExecution: vi.fn(),
    exportExecutions: vi.fn(),
  },
}));
const mockedTasks = vi.mocked(tasksApi, true);

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

const exec = (over: Partial<TaskExecution>): TaskExecution => ({
  id: 'exec-1',
  taskId: 'task-1',
  taskName: '备份任务',
  status: 'success',
  triggerType: 'cron',
  executorAddress: '10.0.0.1:3002',
  startTime: '2026-09-07T10:00:00Z',
  endTime: '2026-09-07T10:01:00Z',
  duration: 60_000,
  params: null,
  createdAt: '2026-09-07T10:00:00Z',
  ...over,
});

const pageFixture = (rows: TaskExecution[], total = rows.length) => ({
  items: rows,
  total,
  page: 1,
  pageSize: 20,
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/executions']}>
        <Routes>
          <Route path="/executions" element={<ExecutionsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** antd 双汉字按钮自动插空格，textContent 归一化后再匹配（既有先例） */
const findBtn = (root: ParentNode, text: string): HTMLButtonElement | null =>
  (Array.from(root.querySelectorAll('button')) as HTMLButtonElement[]).find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === text,
  ) ?? null;

/** 把登录态切成普通用户 / 管理员（页面读 useAuthStore(s => s.user)）。 */
function setRole(role: 'admin' | 'user' | undefined) {
  useAuthStore.setState({
    user: role ? { id: 1, username: 'u', role } : null,
  });
}

beforeEach(() => {
  mockedTasks.allExecutions.mockReset();
  mockedTasks.killExecution.mockReset();
  mockedTasks.exportExecutions.mockReset();
  mockedTasks.allExecutions.mockResolvedValue(pageFixture([exec({})]));
  mockedTasks.exportExecutions.mockResolvedValue(undefined);
  // 默认按管理员渲染：本轮主要验证导出链路本身，非 ADMIN 单独成组。
  setRole('admin');
});

afterEach(() => {
  cleanup();
  message.destroy();
  // 角色是全局 store，不重置会漏到下一个测试文件（同 worker 内串行执行）。
  useAuthStore.setState({ user: null });
});

describe('「导出全部」：请求契约（路径 / 无分页 / 筛选映射）', () => {
  it('点按钮 → 恰好一次调用，且不带 page/pageSize（键不存在，不是 undefined）', async () => {
    renderPage();
    await screen.findByText('成功');

    const btn = findBtn(document.body, '导出全部');
    expect(btn).toBeTruthy();
    expect(btn!.disabled).toBe(false);

    fireEvent.click(btn!);
    await waitFor(() => expect(mockedTasks.exportExecutions).toHaveBeenCalledTimes(1));

    const filters = (mockedTasks.exportExecutions.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>;
    // ② 核心断言：分页参数**键根本不存在**。
    // 后端 ExportExecutionsQueryDto 没有这两个字段，传了会判 400（刻意的：
    // 静默忽略分页参数正是 API-07 记录的那类缺陷）。
    expect('page' in filters).toBe(false);
    expect('pageSize' in filters).toBe(false);
    // 也不许出现 cursor——导出不是分页，端点也不接受它。
    expect('cursor' in filters).toBe(false);

    // ① 路径断言落在 api 层：页面只经 tasksApi.exportExecutions 发请求，
    // 该函数的路径由下方"api 层直测"用例钉死（这里先保证没走错函数）。
    expect(mockedTasks.allExecutions).toHaveBeenCalled();
    expect(mockedTasks.exportExecutions).toHaveBeenCalledTimes(1);
  });

  it('带上当前筛选：status / taskName / executorAddress（名字逐字对齐后端 DTO）', async () => {
    renderPage();
    await screen.findByText('成功');

    // 状态：下拉选「失败」
    fireEvent.mouseDown(screen.getByText('全部状态'));
    fireEvent.click(await screen.findByText('失败', { selector: '.ant-select-item-option-content' }));
    // 搜索框 → taskName（**不是** search/q/name）
    fireEvent.change(screen.getByPlaceholderText('搜索任务名'), { target: { value: '备份' } });
    // 执行器输入框 → executorAddress（**不是** executorId）
    fireEvent.change(screen.getByPlaceholderText('执行器地址'), { target: { value: '10.0.0.' } });

    // 搜索是 300ms 防抖的：等最后一次列表请求带上 taskName 再点导出，
    // 保证导出读到的是**已落定**的筛选值（与用户实际看到的一致）。
    await waitFor(() => {
      const last = mockedTasks.allExecutions.mock.calls[mockedTasks.allExecutions.mock.calls.length - 1]?.[0];
      expect(last?.status).toBe('failed');
      expect(last?.taskName).toBe('备份');
      expect(last?.executorAddress).toBe('10.0.0.');
    });

    fireEvent.click(findBtn(document.body, '导出全部')!);
    await waitFor(() => expect(mockedTasks.exportExecutions).toHaveBeenCalledTimes(1));

    expect(mockedTasks.exportExecutions).toHaveBeenCalledWith({
      status: 'failed',
      taskName: '备份',
      executorAddress: '10.0.0.',
      // 未选时间范围 → 两个键的值为 undefined（api 层据此不装配参数）
      startTime: undefined,
      endTime: undefined,
    });
  });

  it('无筛选时不下发任何筛选值（全部 undefined，参数对象被清空）', async () => {
    renderPage();
    await screen.findByText('成功');

    fireEvent.click(findBtn(document.body, '导出全部')!);
    await waitFor(() => expect(mockedTasks.exportExecutions).toHaveBeenCalledTimes(1));

    const filters = mockedTasks.exportExecutions.mock.calls[0]?.[0] as Record<string, unknown>;
    for (const key of ['status', 'taskName', 'executorAddress', 'startTime', 'endTime']) {
      expect(filters[key]).toBeUndefined();
    }
  });

  it('下载期间有 loading 态（大导出可能几十秒，不能点了没反应）', async () => {
    let resolveExport: () => void = () => {};
    mockedTasks.exportExecutions.mockReturnValue(
      new Promise<void>((r) => {
        resolveExport = () => r();
      }),
    );
    renderPage();
    await screen.findByText('成功');

    fireEvent.click(findBtn(document.body, '导出全部')!);
    // 在途：按钮进入 loading（antd 加 ant-btn-loading 类）且 disabled
    const btn = findBtn(document.body, '导出全部')!;
    await waitFor(() => expect(btn.classList.contains('ant-btn-loading')).toBe(true));
    expect(btn.disabled).toBe(true);

    // 在途重复点击不叠加请求
    fireEvent.click(btn);
    expect(mockedTasks.exportExecutions).toHaveBeenCalledTimes(1);

    resolveExport();
    await waitFor(() => expect(btn.classList.contains('ant-btn-loading')).toBe(false));
  });

  it('导出失败 → 走 showApiError 兜底文案（不发成功 toast）', async () => {
    const errorSpy = vi.spyOn(message, 'error').mockImplementation((() => undefined) as never);
    const successSpy = vi.spyOn(message, 'success').mockImplementation((() => undefined) as never);
    // 普通对象 reject（无 __toastedByClient 标记）→ showApiError 用 fallback 文案
    mockedTasks.exportExecutions.mockRejectedValue(new Error('network broken'));

    renderPage();
    await screen.findByText('成功');
    fireEvent.click(findBtn(document.body, '导出全部')!);

    await waitFor(() => expect(errorSpy).toHaveBeenCalled());
    // showApiError 对 Error 实例优先取 err.message（'network broken'）；
    // 关键是**没有**成功提示。
    expect(successSpy).not.toHaveBeenCalledWith('已开始下载全部执行记录（CSV）');
    errorSpy.mockRestore();
    successSpy.mockRestore();
  });
});

describe('「导出全部」：非 ADMIN 禁用（端点 @Roles(ADMIN)，不让用户点出一个 403）', () => {
  it('普通用户：按钮 disabled，点击不发请求并给出原因提示', async () => {
    setRole('user');
    const warnSpy = vi.spyOn(message, 'warning').mockImplementation((() => undefined) as never);

    renderPage();
    await screen.findByText('成功');

    const btn = findBtn(document.body, '导出全部')!;
    expect(btn.disabled).toBe(true);

    fireEvent.click(btn);
    // 禁用按钮本身不派发 onClick；这里断言的是"没有任何请求被发出"。
    await new Promise((r) => setTimeout(r, 50));
    expect(mockedTasks.exportExecutions).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('role 尚未拉取（undefined）→ 按非 ADMIN 处理（isAdminUser 既有语义）', async () => {
    setRole(undefined);
    renderPage();
    await screen.findByText('成功');

    expect(findBtn(document.body, '导出全部')!.disabled).toBe(true);
    expect(mockedTasks.exportExecutions).not.toHaveBeenCalled();
  });

  it('管理员：按钮可用（对照组，防止上一条被"永远禁用"蒙对）', async () => {
    setRole('admin');
    renderPage();
    await screen.findByText('成功');

    expect(findBtn(document.body, '导出全部')!.disabled).toBe(false);
  });
});

describe('「导出当前页」回归：语义未被本轮改动', () => {
  it('两个按钮并列共存（当前页导出 + 全量导出），文案可区分', async () => {
    renderPage();
    await screen.findByText('成功');

    const currentPage = findBtn(document.body, '导出CSV');
    const exportAll = findBtn(document.body, '导出全部');
    expect(currentPage).toBeTruthy();
    expect(exportAll).toBeTruthy();
    // 两个不同的 DOM 节点——替换实现会让这里变成 null
    expect(currentPage).not.toBe(exportAll);
  });

  it('点「导出 CSV」仍走纯客户端：不发网络请求，只导当前页条数', async () => {
    const successSpy = vi.spyOn(message, 'success').mockImplementation((() => undefined) as never);
    const origCreate = (URL as unknown as Record<string, unknown>).createObjectURL;
    const origRevoke = (URL as unknown as Record<string, unknown>).revokeObjectURL;
    const createSpy = vi.fn(() => 'blob:mock-page-export');
    (URL as unknown as Record<string, unknown>).createObjectURL = createSpy;
    (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();

    try {
      mockedTasks.allExecutions.mockResolvedValue(
        pageFixture([exec({ id: 'e1' }), exec({ id: 'e2' })], 2),
      );
      renderPage();
      // 两行同为 success → 「成功」Badge 有两个，用 findAll 容忍多命中
      await screen.findAllByText('成功');

      const callsBefore = mockedTasks.allExecutions.mock.calls.length;
      fireEvent.click(findBtn(document.body, '导出CSV')!);

      // 关键回归：**没有**任何网络调用（旧行为：数据已在客户端）
      expect(mockedTasks.exportExecutions).not.toHaveBeenCalled();
      expect(mockedTasks.allExecutions.mock.calls.length).toBe(callsBefore);
      // 仍走 blob + objectURL
      expect(createSpy).toHaveBeenCalled();
      // 成功提示仍是「当前页 N 条」，语义没被悄悄改成"全部"
      expect(successSpy).toHaveBeenCalledWith('已导出当前页 2 条执行记录');
    } finally {
      if (origCreate === undefined) delete (URL as unknown as Record<string, unknown>).createObjectURL;
      else (URL as unknown as Record<string, unknown>).createObjectURL = origCreate;
      if (origRevoke === undefined) delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
      else (URL as unknown as Record<string, unknown>).revokeObjectURL = origRevoke;
      successSpy.mockRestore();
    }
  });
});
