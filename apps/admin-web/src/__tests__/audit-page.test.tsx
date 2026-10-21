/**
 * QA-03 第一阶段：AuditLogPage（pages/audit）组件测试扩面（此前零覆盖）。
 *
 * 覆盖核心交互：
 *  1) 列表渲染（操作人+IP / 结果 Tag 双态 / 资源ID 截断 / 时间本地化）；
 *  2) 分页（total 文案 + 翻页触发带 page 参数的重新查询）；
 *  3) 筛选链路（关键词输入 → 搜索按钮点击 → 查询串含 action/username/
 *     resource 参数 + 重置按钮出现并清空）；
 *  4) 详情 Modal（detail 非空渲染「查看」→ Modal 展示 JSON；空 detail 不渲染按钮）；
 *  5) 空态（「暂无审计记录」+ UI-08 PageSkeleton 首屏形态）。
 *
 * 页面消费裸 client.get（/audit?qs），mock api/client 层（对齐
 * notification-silences 先例）；useQuery 页面用 QueryClientProvider 包裹。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import AuditLogPage from '../pages/audit';
import { client } from '../api/client';
import { message } from '../utils/toast';

vi.mock('../api/client', () => ({
  client: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
const mockedClient = vi.mocked(client, true);

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

const makeLog = (over: Record<string, unknown>) => ({
  id: 1,
  action: 'task.create',
  resource: 'task',
  resourceId: 'abcd1234-5678-90ab-cdef-1234567890ab',
  userId: 1,
  username: 'root',
  ip: '10.0.0.1',
  result: 'success',
  detail: undefined as Record<string, unknown> | undefined,
  createdAt: '2026-09-07T10:00:00Z',
  ...over,
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // AUDIT-03：资源ID 列改用 react-router <Link> 跳转详情页 → 渲染需 Router 上下文
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AuditLogPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const findBtn = (root: ParentNode, text: string): HTMLButtonElement | null =>
  (Array.from(root.querySelectorAll('button')) as HTMLButtonElement[]).find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === text,
  ) ?? null;

/** 读取最近一次 /audit 查询的 URL 查询串 */
function lastAuditQuery(): string {
  const calls = mockedClient.get.mock.calls.filter(([url]) => String(url).startsWith('/audit'));
  return String(calls[calls.length - 1]?.[0] ?? '');
}

/** 读取最近一次 /audit/actions（动作清单）请求的 URL */
function lastActionsQuery(): string {
  const calls = mockedClient.get.mock.calls.filter(([url]) => String(url).startsWith('/audit/actions'));
  return String(calls[calls.length - 1]?.[0] ?? '');
}

/**
 * R67-A1：定位 action 过滤器（tags 模式 Select）的根节点。
 *
 * 不能像改造前那样用 `getByPlaceholderText('操作关键词')`：antd 6 的 Select 把
 * placeholder 渲染成**浮层文本**（`.ant-select-placeholder`），input 上没有
 * placeholder 属性——而且一旦选中值，那段文本就消失了。`.ant-select-multiple`
 * 只出现在本页唯一的多选/可自由输入控件上（资源类型、执行结果都是单选），
 * 故选它做稳定锚点。
 */
function actionSelect(): HTMLElement {
  const root = document.querySelector('.ant-select-multiple') as HTMLElement | null;
  expect(root, '未找到 action 过滤器（tags 模式 Select）').toBeTruthy();
  return root!;
}

/**
 * R67-A1：往 action 过滤器里**自由输入**一个关键词。
 *
 * 该过滤器已从 Input 换成 tags 模式 Select：键入的文字要**回车**才会成为一个 tag
 * （= 一个过滤值），change 只更新搜索词。这是真实用户手势的等价物（打字 + Enter），
 * 也是"自由输入没有被下拉吃掉"的可执行证据。
 */
function typeActionKeyword(value: string) {
  const input = actionSelect().querySelector('input') as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13 });
}

/** R67-A1：点掉 action 上的 tag（tags 模式的「×」）——清草稿但不触发搜索。 */
function clearActionDraft() {
  const remove = actionSelect().querySelector('.ant-select-selection-item-remove') as HTMLElement | null;
  expect(remove, '未找到 action tag 的移除按钮').toBeTruthy();
  // antd 6 的 tag 移除走 onClick（mouseDown 不会触发移除）
  fireEvent.click(remove!);
}

beforeEach(() => {
  mockedClient.get.mockReset().mockResolvedValue({
    data: [
      makeLog({}),
      makeLog({
        id: 2,
        action: 'legacy.unknown_action',
        resource: 'config',
        username: 'dev',
        ip: '10.0.0.2',
        result: 'failure',
        detail: { before: { a: 1 }, after: { a: 2 } },
      }),
      makeLog({ id: 3, action: 'executor.delete', resource: 'executor', resourceId: undefined, detail: {} }),
    ],
    total: 3,
  } as never);
});

afterEach(() => {
  cleanup();
});

describe('AuditLogPage 列表渲染（QA-03）', () => {
  it('渲染操作人/IP、结果 Tag 双态、资源ID 截断与分页 total', async () => {
    renderPage();
    expect(await screen.findByText('创建任务')).toBeTruthy();
    expect(screen.getByText('legacy.unknown_action')).toBeTruthy();
    // 成功/失败 Tag
    expect(screen.getAllByText('成功').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('失败').length).toBeGreaterThanOrEqual(1);
    // 资源ID >8 字符截断为前 8 位+省略号（Tooltip 悬浮层同文案 → 容忍多命中）
    expect(screen.getAllByText(/abcd1234…/).length).toBeGreaterThanOrEqual(1);
    // 资源ID 缺省显示 -
    expect(screen.getAllByText('-').length).toBeGreaterThanOrEqual(1);
    // 分页 total
    expect(screen.getByText('共 3 条')).toBeTruthy();
  });

  it('detail 非空渲染「查看」按钮，空/缺省 detail 不渲染', async () => {
    renderPage();
    await screen.findByText('创建任务');
    // 行2（legacy.unknown_action 有 detail）有查看；行1/3 无 detail 或空对象 → 无按钮
    const viewButtons = (Array.from(document.querySelectorAll('button')) as HTMLButtonElement[])
      .filter((b) => (b.textContent ?? '').replace(/\s/g, '') === '查看');
    expect(viewButtons.length).toBe(1);
  });

  it('点「查看」打开详情 Modal 并以 JSON 展示 detail', async () => {
    renderPage();
    await screen.findByText('legacy.unknown_action');

    const viewButtons = (Array.from(document.querySelectorAll('button')) as HTMLButtonElement[])
      .filter((b) => (b.textContent ?? '').replace(/\s/g, '') === '查看');
    fireEvent.click(viewButtons[0]);

    // Modal 标题「详情」（页头描述等处同名风险 → findAllByText 取首个，
    // 断言 JSON 内容出现即代表 modal 打开）
    await screen.findByText(/"before"/);
    expect(screen.getAllByText('详情').length).toBeGreaterThanOrEqual(1);
  });
});

describe('AuditLogPage 筛选链路（QA-03）', () => {
  it('输入关键词+操作人后点搜索 → 查询串携带 action/username 参数并回到第 1 页', async () => {
    renderPage();
    await screen.findByText('创建任务');

    typeActionKeyword('task');
    fireEvent.change(screen.getByPlaceholderText('操作人'), { target: { value: 'root' } });
    fireEvent.click(findBtn(document.body, '搜索')!);

    await waitFor(() => {
      const qs = lastAuditQuery();
      expect(qs).toContain('action=task');
      expect(qs).toContain('username=root');
      expect(qs).toContain('page=1');
    });
  });

  it('筛选后出现「重置」按钮，点击清空条件重新查询（无筛选参数）', async () => {
    renderPage();
    await screen.findByText('创建任务');

    typeActionKeyword('task');
    fireEvent.click(findBtn(document.body, '搜索')!);
    await waitFor(() => {
      expect(lastAuditQuery()).toContain('action=task');
    });

    fireEvent.click(findBtn(document.body, '重置')!);
    await waitFor(() => {
      const qs = lastAuditQuery();
      expect(qs).not.toContain('action=');
      expect(qs).toContain('page=1');
    });
  });

  it('资源类型下拉选择后查询串携带 resource 参数', async () => {
    renderPage();
    await screen.findByText('创建任务');

    fireEvent.mouseDown(screen.getByText('资源类型'));
    const option = await screen.findByText('executor', { selector: '.ant-select-item-option-content' });
    fireEvent.click(option);
    fireEvent.click(findBtn(document.body, '搜索')!);

    await waitFor(() => {
      expect(lastAuditQuery()).toContain('resource=executor');
    });
  });
});

describe('AuditLogPage 分页（QA-03）', () => {
  it('翻页触发 page=2 的重新查询', async () => {
    // total=3、pageSize=20 只有 1 页 → fixture 换成跨页数据（beforeEach 的
    // mock 已被本用例的 mockResolvedValue 覆盖）
    mockedClient.get.mockResolvedValue({
      data: [makeLog({ id: 1, action: 'task.create' })],
      total: 21,
    } as never);
    renderPage();
    // 等 total 文案出现（此时分页器已渲染 page=2 的页码项）
    await screen.findByText('共 21 条');
    // 等一拍让分页器完成渲染（total 文案与页码项同批渲染，jsdom 偶发时序）
    await waitFor(() => {
      expect(document.body.querySelectorAll('li.ant-pagination-item').length).toBeGreaterThanOrEqual(2);
    });

    // antd v6 分页页码 li 内部是 <a> 非 button（diag 验证），点击 li 本体触发
    const page2 = document.body.querySelector('li.ant-pagination-item-2');
    expect(page2).toBeTruthy();
    fireEvent.click(page2!);
    await waitFor(() => {
      expect(lastAuditQuery()).toContain('page=2');
    });
  });
});

// ─── AUTH-05: resourceId 精确筛选（与资源类型组合）──────────────────────────
describe('AUTH-05 资源ID 筛选', () => {
  it('输入资源ID后点搜索 → 查询串携带 resourceId 参数', async () => {
    renderPage();
    await screen.findByText('创建任务');

    fireEvent.change(screen.getByPlaceholderText('资源 ID'), {
      target: { value: 'exec-abc-123' },
    });
    fireEvent.click(findBtn(document.body, '搜索')!);

    await waitFor(() => {
      expect(lastAuditQuery()).toContain('resourceId=exec-abc-123');
    });
  });

  it('资源类型 + 资源ID 组合筛选 → 查询串同时携带 resource 与 resourceId', async () => {
    renderPage();
    await screen.findByText('创建任务');

    fireEvent.mouseDown(screen.getByText('资源类型'));
    const option = await screen.findByText('executor', { selector: '.ant-select-item-option-content' });
    fireEvent.click(option);
    fireEvent.change(screen.getByPlaceholderText('资源 ID'), { target: { value: 'e-42' } });
    fireEvent.click(findBtn(document.body, '搜索')!);

    await waitFor(() => {
      const qs = lastAuditQuery();
      expect(qs).toContain('resource=executor');
      expect(qs).toContain('resourceId=e-42');
    });
  });

  it('重置后查询串不再携带 resourceId', async () => {
    renderPage();
    await screen.findByText('创建任务');

    fireEvent.change(screen.getByPlaceholderText('资源 ID'), { target: { value: 'e-42' } });
    fireEvent.click(findBtn(document.body, '搜索')!);
    await waitFor(() => {
      expect(lastAuditQuery()).toContain('resourceId=e-42');
    });

    fireEvent.click(findBtn(document.body, '重置')!);
    await waitFor(() => {
      expect(lastAuditQuery()).not.toContain('resourceId=');
    });
  });

  /**
   * AUDIT-HASFILTERS（审计 P2，2026-10-17）：「重置」按钮的可见性必须跟随
   * **已应用**的筛选（filters），而不是表单草稿（pending）。
   *
   * 缺陷现场：hasFilters 读 pending，而列表查询与 CSV 导出都用 filters。于是
   * 用户只在输入框里敲了字、还没点搜索时，「重置」按钮就出现了——暗示
   * 「当前有筛选」，但列表其实是全量；此时点导出，导出的也是全量数据。
   */
  it('AUDIT-HASFILTERS：只改输入框（未点搜索）不出现「重置」按钮', async () => {
    renderPage();
    await screen.findByText('创建任务');

    // 初始：无筛选 → 无重置按钮
    expect(findBtn(document.body, '重置')).toBeNull();

    // 只敲字（回车成 tag），不点搜索：草稿变了但筛选未应用 → 仍然不应出现
    typeActionKeyword('task');
    expect(findBtn(document.body, '重置')).toBeNull();

    // 点搜索 → 筛选真正应用 → 按钮出现
    fireEvent.click(findBtn(document.body, '搜索')!);
    await waitFor(() => {
      expect(findBtn(document.body, '重置')).toBeTruthy();
    });
  });

  it('AUDIT-HASFILTERS：应用筛选后再把草稿清空，「重置」按钮仍在（列表仍筛选中）', async () => {
    renderPage();
    await screen.findByText('创建任务');

    typeActionKeyword('task');
    fireEvent.click(findBtn(document.body, '搜索')!);
    await waitFor(() => {
      expect(lastAuditQuery()).toContain('action=task');
    });

    // 把草稿里的 tag 清掉但**不**点搜索：列表仍是筛选态，按钮必须还在
    clearActionDraft();
    expect(findBtn(document.body, '重置')).toBeTruthy();
  });
});

describe('AuditLogPage 空态（QA-03 / UI-08）', () => {
  it('无记录渲染「暂无审计记录」空态', async () => {
    mockedClient.get.mockResolvedValue({ data: [], total: 0 } as never);
    renderPage();
    expect(await screen.findByText('暂无审计记录')).toBeTruthy();
  });
});

// ─── A-12: 导出 CSV 入口（GET /audit/export 携带当前 filters，ADMIN-only）───
describe('A-12 审计 CSV 导出', () => {
  const g = globalThis as Record<string, unknown>;
  let origCreateObjectURL: unknown;
  let origRevokeObjectURL: unknown;

  beforeEach(() => {
    origCreateObjectURL = g.URL && (g.URL as Record<string, unknown>).createObjectURL;
    origRevokeObjectURL = g.URL && (g.URL as Record<string, unknown>).revokeObjectURL;
    (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => 'blob:mock-audit-export');
    (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    if (origCreateObjectURL === undefined) {
      delete (URL as unknown as Record<string, unknown>).createObjectURL;
    } else {
      (URL as unknown as Record<string, unknown>).createObjectURL = origCreateObjectURL;
    }
    if (origRevokeObjectURL === undefined) {
      delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
    } else {
      (URL as unknown as Record<string, unknown>).revokeObjectURL = origRevokeObjectURL;
    }
  });

  const lastExportQuery = (): string => {
    const calls = mockedClient.get.mock.calls.filter(([url]) =>
      String(url).startsWith('/audit/export'),
    );
    return String(calls[calls.length - 1]?.[0] ?? '');
  };

  it('点击「导出CSV」→ 请求 /audit/export 携带当前筛选参数并提示成功', async () => {
    const successSpy = vi.spyOn(message, 'success').mockImplementation((() => undefined) as never);
    renderPage();
    await screen.findByText('创建任务');

    // 应用一个筛选（action=task），导出应携带同一筛选
    typeActionKeyword('task');
    fireEvent.click(findBtn(document.body, '搜索')!);
    await waitFor(() => {
      expect(lastAuditQuery()).toContain('action=task');
    });

    mockedClient.get.mockImplementation((async (url: unknown) => {
      if (String(url).startsWith('/audit/export')) {
        return new Blob(['id,action\n1,task.create'], { type: 'text/csv' });
      }
      return { data: [makeLog({})], total: 1 };
    }) as never);

    fireEvent.click(findBtn(document.body, '导出CSV')!);

    await waitFor(() => {
      expect(lastExportQuery()).toContain('/audit/export?action=task');
    });
    // 列表请求参数（page/pageSize）不应混进导出请求
    expect(lastExportQuery()).not.toContain('page=');
    expect(successSpy).toHaveBeenCalledTimes(1);
    // blob 下载触发（objectURL 建立并回收）
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-audit-export');
    successSpy.mockRestore();
  });

  it('导出请求在无筛选时仅携带空查询串', async () => {
    const successSpy = vi.spyOn(message, 'success').mockImplementation((() => undefined) as never);
    renderPage();
    await screen.findByText('创建任务');

    mockedClient.get.mockImplementation((async (url: unknown) => {
      if (String(url).startsWith('/audit/export')) {
        return new Blob(['id\n'], { type: 'text/csv' });
      }
      return { data: [makeLog({})], total: 1 };
    }) as never);

    fireEvent.click(findBtn(document.body, '导出CSV')!);

    await waitFor(() => {
      expect(lastExportQuery()).toBe('/audit/export');
    });
    successSpy.mockRestore();
  });
});

// ─── R67-A1: action 过滤器 = 可发现下拉（GET /audit/actions 供选项）──────────
/**
 * 缺陷现场：动作已有 61 个（19 个域），而 action 过滤器是个自由文本输入框——
 * 用户必须先**知道**动作名（还得分大小写/点号写法）才能筛。"能筛、筛不到"。
 *
 * 本组钉四件事：
 *  ① 首屏向 /audit/actions 拉一次清单，并渲染成**可选**项（可发现）；
 *  ② 选中即筛（查询串带 action），不必手打动作名；
 *  ③ 下拉是**单选**语义（再选一个 = 替换），界面不撒谎（标签数 ≠ 过滤条件数）；
 *  ④ 清单失败**不阻断页面**，且自由输入这条老能力仍在（降级而非坏掉）。
 */
describe('R67-A1 动作下拉（可发现）', () => {
  /** 分别应答 /audit/actions 与 /audit（此前用例共用一个 mockResolvedValue） */
  function mockBackend(actions: string[]) {
    mockedClient.get.mockImplementation((async (url: unknown) => {
      if (String(url).startsWith('/audit/actions')) return { actions };
      return { data: [makeLog({})], total: 1 };
    }) as never);
  }

  it('首屏拉取一次 /audit/actions，并渲染成可选下拉项（未知动作显示原始 code）', async () => {
    mockBackend(['auth.login', 'legacy.unknown_action_2', 'task.create']);
    renderPage();
    await screen.findByText('创建任务');

    await waitFor(() => expect(lastActionsQuery()).toBe('/audit/actions'));

    fireEvent.mouseDown(actionSelect());
    // 断言只看**下拉项**本体：rc-select 另有一个 aria-live 的礼貌播报节点会重复
    // 第一项文案（selector 收窄后不会撞车，也与既有「资源类型」用例同款写法）。
    const option = (text: string) =>
      screen.findByText(text, { selector: '.ant-select-item-option-content' });
    // 已知动作：本地化名 + code（管理员是从文档/CSV 认 code 的）
    expect(await option('创建任务 (task.create)')).toBeTruthy();
    expect(await option('登录 (auth.login)')).toBeTruthy();
    // 未知动作：原样露出 code，不抹成"未知操作"（AUDIT-01 同款口径）
    expect(await option('legacy.unknown_action_2')).toBeTruthy();
    // 清单只拉一次（不随筛选/翻页重复取）
    expect(
      mockedClient.get.mock.calls.filter(([url]) => String(url).startsWith('/audit/actions')),
    ).toHaveLength(1);
  });

  it('从下拉里选一个动作 → 搜索后查询串携带 action（不必背动作名）', async () => {
    mockBackend(['auth.login', 'task.create']);
    renderPage();
    await screen.findByText('创建任务');

    fireEvent.mouseDown(actionSelect());
    fireEvent.click(await screen.findByText('创建任务 (task.create)'));
    fireEvent.click(findBtn(document.body, '搜索')!);

    await waitFor(() => {
      expect(lastAuditQuery()).toContain('action=task.create');
    });
  });

  it('再选一个动作 = 替换（单选语义），界面标签数与过滤条件数一致', async () => {
    mockBackend(['auth.login', 'task.create']);
    renderPage();
    await screen.findByText('创建任务');

    fireEvent.mouseDown(actionSelect());
    fireEvent.click(await screen.findByText('创建任务 (task.create)'));
    fireEvent.mouseDown(actionSelect());
    fireEvent.click(await screen.findByText('登录 (auth.login)'));

    // 只留一个 tag：绝不出现"界面 2 个标签、实际只过滤 1 个"的撒谎 UI
    expect(document.querySelectorAll('.ant-select-selection-item')).toHaveLength(1);

    fireEvent.click(findBtn(document.body, '搜索')!);
    await waitFor(() => {
      const qs = lastAuditQuery();
      expect(qs).toContain('action=auth.login');
      expect(qs).not.toContain('task.create');
    });
  });

  it('清单请求失败 → 页面照常渲染且仍可自由输入（回落而不是坏掉）', async () => {
    mockedClient.get.mockImplementation((async (url: unknown) => {
      if (String(url).startsWith('/audit/actions')) throw new Error('actions boom');
      return { data: [makeLog({})], total: 1 };
    }) as never);

    renderPage();

    // 列表照常渲染
    expect(await screen.findByText('创建任务')).toBeTruthy();
    // 没有页内错误块：那是**列表**查询失败的形态，下拉失败不该冒充它
    expect(screen.queryByText('审计日志加载失败')).toBeNull();

    // 自由输入这条既有路径仍然生效（后端是 ILIKE 子串匹配，片段即可）
    typeActionKeyword('task');
    fireEvent.click(findBtn(document.body, '搜索')!);
    await waitFor(() => {
      expect(lastAuditQuery()).toContain('action=task');
    });
  });
});

  it('R104：新落地的审计动作（config / sop）也有本地化标签，不再回退原始 code', async () => {
    mockedClient.get.mockImplementation(((url: string) => {
      if (String(url).startsWith('/audit/actions')) {
        return Promise.resolve({
          data: {
            actions: [
              'config.create',
              'config.update',
              'config.delete',
              'sop.clarification.escalated',
              'sop.timeout.unclaimed',
            ],
          },
        });
      }
      return Promise.resolve({
        data: [
          makeLog({ id: 1, action: 'config.update', resource: 'config', resourceId: 'executor.sharedToken' }),
          makeLog({ id: 2, action: 'sop.clarification.escalated', resource: 'sop_clarification' }),
        ],
        total: 2,
      });
    }) as never);

    renderPage();
    // 列表侧：动作列显示本地化名，而不是原始 code
    expect(await screen.findByText('更新配置项')).toBeTruthy();
    expect(await screen.findByText('SOP 澄清升级')).toBeTruthy();

    // 下拉侧已由上面的「未知动作显示原始 code」用例覆盖机制；这里只钉列表侧，
    // 避免同一 fixture 里既开下拉又断言列表造成选择器互相干扰。
  });
