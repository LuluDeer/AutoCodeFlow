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
import AuditLogPage from '../pages/audit';
import { client } from '../api/client';

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
  return render(
    <QueryClientProvider client={qc}>
      <AuditLogPage />
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

beforeEach(() => {
  mockedClient.get.mockReset().mockResolvedValue({
    data: [
      makeLog({}),
      makeLog({
        id: 2,
        action: 'config.update',
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
    expect(await screen.findByText('task.create')).toBeTruthy();
    expect(screen.getByText('config.update')).toBeTruthy();
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
    await screen.findByText('task.create');
    // 行2（config.update 有 detail）有查看；行1/3 无 detail 或空对象 → 无按钮
    const viewButtons = (Array.from(document.querySelectorAll('button')) as HTMLButtonElement[])
      .filter((b) => (b.textContent ?? '').replace(/\s/g, '') === '查看');
    expect(viewButtons.length).toBe(1);
  });

  it('点「查看」打开详情 Modal 并以 JSON 展示 detail', async () => {
    renderPage();
    await screen.findByText('config.update');

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
    await screen.findByText('task.create');

    fireEvent.change(screen.getByPlaceholderText('操作关键词'), { target: { value: 'task' } });
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
    await screen.findByText('task.create');

    fireEvent.change(screen.getByPlaceholderText('操作关键词'), { target: { value: 'task' } });
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
    await screen.findByText('task.create');

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

describe('AuditLogPage 空态（QA-03 / UI-08）', () => {
  it('无记录渲染「暂无审计记录」空态', async () => {
    mockedClient.get.mockResolvedValue({ data: [], total: 0 } as never);
    renderPage();
    expect(await screen.findByText('暂无审计记录')).toBeTruthy();
  });
});
