/**
 * R139 P2-2 / P3-2 —— 执行器包页的「选中作用域」与「末页钳制」。
 *
 * ── P2-2（跨页选中残留）──────────────────────────────────────────────────
 * `load` 以 `page` 为依赖，翻页会重取，但 `selectedIds` **没有任何**随页码/
 * 搜索/筛选/游标清空的路径。于是第 1 页勾选 2 个 → 翻到第 2 页：
 *   · 批量条仍显示「已选 2 个包」；
 *   · 点「批量删除 2 个」→ `rows.filter(...)` 为空 → `return`，**确认框不出现、
 *     没有任何提示** —— 按钮表现为坏掉（「按钮可点但无反馈」）；
 *   · 更糟的是作用域与提示不符：跨页勾 3 个只删本页 1 个，提示却说 3。
 * 同仓 `ExecutionsPage` 早已有这条纪律（「翻页/筛选变化后跨页选中行不再可见——
 * 清空选中防误比」）；批量删除是**破坏性操作**，比对比选择更该守。
 *
 * ── P3-2（末页删空不钳制）────────────────────────────────────────────────
 * 第 2 页只有 1 个包 → 删除成功 → `load()` 仍按 page=2 请求 → 后端返回空页 +
 * total=20 → 表格渲染「暂无包，点击「上传新包」添加第一个」，而第 1 页还有 20 个。
 * 空态文案是**事实性错误**，会把管理员引向重复上传。同纪律已在
 * `UserManagementPage` / `TaskListPage` / `ProjectsPage` 落地。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import ExecutorPackagesPage from '../pages/ExecutorPackagesPage';
import { listPackages, deletePackage } from '../api/executor-packages';
import { executorsApi } from '../api/executors';
import { Modal as confirmModal } from '../utils/modal';
import { message } from '../utils/toast';
import type { ExecutorPackage } from '../api/executor-packages';

vi.mock('../api/executor-packages', () => ({
  listPackages: vi.fn(),
  uploadPackage: vi.fn(),
  deletePackage: vi.fn(),
  pushPackage: vi.fn(),
  deprecatePackage: vi.fn(),
  activatePackage: vi.fn(),
  downloadPackage: vi.fn(),
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn() },
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

const pkg = (id: string, name = id): ExecutorPackage => ({
  id,
  name,
  version: '1.0.0',
  type: 'python',
  platform: 'linux',
  fileSize: 1024,
  checksum: 'sha256',
  changelog: '',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

/** n 条同构行（pageSize=20，故 20 条正好铺满一页）。 */
const many = (n: number, prefix = 'pkg'): ExecutorPackage[] =>
  Array.from({ length: n }, (_, i) => pkg(`${prefix}-${i + 1}`));

const pageOf = (params: unknown): number =>
  ((params ?? {}) as { page?: number }).page ?? 1;

const headerCheckbox = () =>
  document.querySelector('.ant-table-thead input[type=checkbox]') as HTMLInputElement;

const goToPage2 = () =>
  fireEvent.click(document.querySelector('.ant-pagination-item[title="2"]') as HTMLElement);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(executorsApi.list).mockResolvedValue([]);
  vi.mocked(deletePackage).mockResolvedValue(undefined as never);
});

afterEach(() => {
  cleanup();
  // 命令式 Modal / toast 是 body 单例，不随 RTL cleanup 清理（既有先例）
  confirmModal.destroyAll();
  message.destroy();
});

describe('P2-2 跨页选中：结果集变化即清空选中', () => {
  it('翻页后批量条消失（不再显示上一页的选中数量）', async () => {
    vi.mocked(listPackages).mockImplementation(async (params) => {
      const page = pageOf(params);
      return page === 1
        ? { items: many(20), total: 25 }
        : { items: many(5, 'p2'), total: 25 };
    });
    render(<ExecutorPackagesPage />);
    await screen.findByText('pkg-1');

    fireEvent.click(headerCheckbox());
    const bar = await screen.findByTestId('execPkg-batch-bar');
    expect(bar.textContent).toContain('20');

    goToPage2();
    await screen.findByText('p2-1');

    // 反证锚点：旧实现保留 20 个跨页选中 → 批量条仍在，且点删除是死操作
    expect(screen.queryByTestId('execPkg-batch-bar')).toBeNull();
  });

  it('搜索（结果集变化）后同样清空选中', async () => {
    vi.mocked(listPackages).mockResolvedValue({ items: many(3), total: 3 });
    render(<ExecutorPackagesPage />);
    await screen.findByText('pkg-1');

    fireEvent.click(headerCheckbox());
    await screen.findByTestId('execPkg-batch-bar');

    fireEvent.change(screen.getByPlaceholderText('搜索包名…'), { target: { value: 'runner' } });
    // 等防抖窗口 + 请求落地
    await act(async () => {
      await new Promise((r) => setTimeout(r, 420));
    });

    await waitFor(() => expect(screen.queryByTestId('execPkg-batch-bar')).toBeNull());
  });

  it('选中行已不在当前页时，批量删除不得静默无反应（清空选中 + 可见提示）', async () => {
    const warn = vi.spyOn(message, 'warning');
    // 首载 2 行 → 刷新后数据被别处改掉（只剩一行且不是已选中的）
    vi.mocked(listPackages)
      .mockResolvedValueOnce({ items: many(2), total: 2 })
      .mockResolvedValue({ items: [pkg('other-1', 'other')], total: 1 });
    render(<ExecutorPackagesPage />);
    await screen.findByText('pkg-1');

    fireEvent.click(headerCheckbox());
    await screen.findByTestId('execPkg-batch-bar');

    // 手动刷新（非 silent）：选中集合与当前页可见行不再一致
    fireEvent.click(screen.getByText('刷新'));
    await screen.findByText('other');

    fireEvent.click(screen.getByTestId('execPkg-batch-delete'));

    // 旧实现：targets 为空 → 直接 return（零反馈、批量条永远挂着）
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(screen.queryByTestId('execPkg-batch-bar')).toBeNull();
    expect(deletePackage).not.toHaveBeenCalled();
  });
});

describe('P3-2 末页删空后钳回有效页', () => {
  it('第 2 页删最后一条：回退第 1 页，不出现「暂无包」空态', async () => {
    let deleted = false;
    vi.mocked(deletePackage).mockImplementation(async () => {
      deleted = true;
    });
    vi.mocked(listPackages).mockImplementation(async (params) => {
      const page = pageOf(params);
      if (page === 1) return { items: many(20), total: deleted ? 20 : 21 };
      return deleted
        ? { items: [], total: 20 }
        : { items: [pkg('tail-1', 'tail')], total: 21 };
    });
    const confirmSpy = vi.spyOn(confirmModal, 'confirm');
    render(<ExecutorPackagesPage />);
    await screen.findByText('pkg-1');

    goToPage2();
    await screen.findByText('tail');

    fireEvent.click(document.querySelector('.anticon-delete')!.closest('button')!);
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    // 确认框挂到 body portal 是异步的：等它真的渲染出来再点（同 push 用例先例）
    await waitFor(() => expect(document.querySelector('.ant-modal-confirm-btns')).toBeTruthy());
    const okBtns = Array.from(
      document.querySelectorAll('.ant-modal-confirm-btns button'),
    ) as HTMLElement[];
    fireEvent.click(okBtns[okBtns.length - 1]);

    await waitFor(() => expect(deletePackage).toHaveBeenCalledWith('tail-1'));
    // 钳制判据：删除后重取的是第 1 页（旧实现留在 page=2 → 空页 + 错误空态）
    await waitFor(() =>
      expect(vi.mocked(listPackages)).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 1 }),
      ),
    );
    expect(await screen.findByText('pkg-1')).toBeTruthy();
    // 「包还在」时绝不能出现「暂无包，点击「上传新包」添加第一个」
    expect(screen.queryByText(/暂无包/)).toBeNull();
  });

  it('第 2 页批量删除全部：同样回退第 1 页', async () => {
    let deleted = false;
    vi.mocked(deletePackage).mockImplementation(async () => {
      deleted = true;
    });
    vi.mocked(listPackages).mockImplementation(async (params) => {
      const page = pageOf(params);
      if (page === 1) return { items: many(20), total: deleted ? 20 : 22 };
      return deleted
        ? { items: [], total: 20 }
        : { items: many(2, 'tail'), total: 22 };
    });
    render(<ExecutorPackagesPage />);
    await screen.findByText('pkg-1');

    goToPage2();
    await screen.findByText('tail-1');

    fireEvent.click(headerCheckbox());
    await screen.findByTestId('execPkg-batch-bar');
    fireEvent.click(screen.getByTestId('execPkg-batch-delete'));
    await waitFor(() => expect(document.body.textContent).toContain('删除 2 个执行器包'));
    const okBtns = Array.from(
      document.querySelectorAll('.ant-modal-confirm-btns button'),
    ) as HTMLElement[];
    fireEvent.click(okBtns[okBtns.length - 1]);

    await waitFor(() => expect(deletePackage).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(vi.mocked(listPackages)).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 1 }),
      ),
    );
    expect(screen.queryByText(/暂无包/)).toBeNull();
  });
});
