/**
 * UI-16：ExecutorPackagesPage 首屏包列表错误态。
 *
 * 只覆盖包列表请求：失败展示页内错误块，重试重新调用 listPackages，
 * 成功后清除错误并渲染列表；成功返回空数组时才显示包列表空态。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import ExecutorPackagesPage from '../pages/ExecutorPackagesPage';
import { listPackages } from '../api/executor-packages';
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

const packageRow: ExecutorPackage = {
  id: 'pkg-1',
  name: 'python-runner',
  version: '1.0.0',
  type: 'python',
  platform: 'linux',
  fileSize: 1024,
  sha256: 'sha256',
  changelog: '',
  status: 'active',
  downloadCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.mocked(listPackages).mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ExecutorPackagesPage 首屏包列表错误态（UI-16）', () => {
  it('失败展示错误文案且不显示误导性空态，重试成功后错误块消失并恢复列表', async () => {
    vi.mocked(listPackages)
      .mockRejectedValueOnce(new Error('包服务暂时不可用'))
      .mockResolvedValueOnce({ items: [packageRow], total: 1 });

    render(<ExecutorPackagesPage />);

    expect(await screen.findByTestId('state-error')).toBeTruthy();
    expect(screen.getByText('执行器包列表加载失败')).toBeTruthy();
    expect(screen.getByText('包服务暂时不可用')).toBeTruthy();
    expect(screen.queryByText(/暂无包/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /重试/ }));

    await waitFor(() => {
      expect(listPackages).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId('state-error')).toBeNull();
    });
    expect(await screen.findByText('python-runner')).toBeTruthy();
    expect(screen.queryByText(/暂无包/)).toBeNull();
  });

  it('重试再次失败时保留最新错误态', async () => {
    vi.mocked(listPackages)
      .mockRejectedValueOnce(new Error('首次失败'))
      .mockRejectedValueOnce(new Error('重试仍失败'));

    render(<ExecutorPackagesPage />);
    expect(await screen.findByText('首次失败')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /重试/ }));

    await waitFor(() => {
      expect(listPackages).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('state-error').textContent).toContain('重试仍失败');
    });
    expect(screen.queryByText(/暂无包/)).toBeNull();
  });

  it('旧请求晚到的数据或错误不得覆盖最新请求状态', async () => {
    const resolvers: Array<{
      resolve: (value: { items: ExecutorPackage[]; total: number }) => void;
      reject: (error: Error) => void;
    }> = [];
    vi.mocked(listPackages).mockImplementation(
      () => new Promise((resolve, reject) => { resolvers.push({ resolve, reject }); }),
    );

    render(<ExecutorPackagesPage />);
    await waitFor(() => expect(listPackages).toHaveBeenCalledTimes(1));

    // 刷新触发更新的请求；其结果先到，之后旧请求的结果和错误都必须丢弃。
    fireEvent.click(screen.getByRole('button', { name: /刷新/ }));
    await waitFor(() => expect(listPackages).toHaveBeenCalledTimes(2));
    await act(async () => {
      resolvers[1].resolve({ items: [packageRow], total: 1 });
    });
    expect(await screen.findByText('python-runner')).toBeTruthy();

    await act(async () => {
      resolvers[0].resolve({ items: [], total: 0 });
    });
    expect(screen.getByText('python-runner')).toBeTruthy();
    expect(screen.queryByText(/暂无包/)).toBeNull();

    // 连续刷新再制造一组并发请求，旧请求的错误也不得污染当前成功状态。
    fireEvent.click(screen.getByRole('button', { name: /刷新/ }));
    await waitFor(() => expect(listPackages).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole('button', { name: /刷新/ }));
    await waitFor(() => expect(listPackages).toHaveBeenCalledTimes(4));
    await act(async () => {
      resolvers[3].resolve({ items: [packageRow], total: 1 });
      resolvers[2].reject(new Error('旧请求错误'));
    });
    expect(screen.getByText('python-runner')).toBeTruthy();
    expect(screen.queryByText('旧请求错误')).toBeNull();
    expect(screen.queryByTestId('state-error')).toBeNull();
  });

  it('仅在包列表请求成功返回空数组时显示暂无包空态', async () => {
    vi.mocked(listPackages).mockResolvedValue({ items: [], total: 0 });

    render(<ExecutorPackagesPage />);

    expect(await screen.findByText(/暂无包/)).toBeTruthy();
    expect(screen.queryByTestId('state-error')).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 状态列必须来自后端响应（本轮审计修复的回归守卫）
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 行内操作按钮是**纯图标**按钮（文案在 Tooltip 上），故没有可访问名——
   * 按 send 图标定位推送按钮（该按钮同时是行内唯一的 `type="primary"`）。
   */
  const pushButton = (): HTMLButtonElement => {
    const icon = document.querySelector('.anticon-send');
    expect(icon).toBeTruthy();
    return icon!.closest('button') as HTMLButtonElement;
  };

  it('active 包显示「活跃」且推送按钮可用（不得由不存在的 isLatest 推导）', async () => {
    // 反证：把 `setRows(res.items)` 改回
    // `res.items.map(p => ({ ...p, status: p.isLatest ? 'active' : 'deprecated' }))`
    // （isLatest 后端从不返回 → 恒 undefined），本例立刻转红：
    // 状态变成「已弃用」，推送按钮转为 disabled，而推送功能对**全部**包不可达。
    vi.mocked(listPackages).mockResolvedValue({ items: [packageRow], total: 1 });

    render(<ExecutorPackagesPage />);

    expect(await screen.findByText('python-runner')).toBeTruthy();
    expect(screen.getByText('活跃')).toBeTruthy();
    expect(screen.queryByText('已弃用')).toBeNull();
    expect(pushButton().disabled).toBe(false);
  });

  it('deprecated 包显示「已弃用」且推送按钮禁用', async () => {
    // 反向护栏：只断言"推送可用"会退化成"状态永远当 active"——必须同时钉住
    // 后端真的返回 deprecated 时 UI 如实反映并禁用推送。
    vi.mocked(listPackages).mockResolvedValue({
      items: [{ ...packageRow, status: 'deprecated' }],
      total: 1,
    });

    render(<ExecutorPackagesPage />);

    expect(await screen.findByText('python-runner')).toBeTruthy();
    expect(screen.getByText('已弃用')).toBeTruthy();
    expect(screen.queryByText('活跃')).toBeNull();
    expect(pushButton().disabled).toBe(true);
  });
});
