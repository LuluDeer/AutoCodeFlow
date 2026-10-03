/**
 * 执行器管理 UI 审计修复——安装包页专项（B-2 / B-3 / B-4 / B-9 / B-12）。
 *
 *  B-2 删除失败必须有反馈：onOk try/catch + showApiError，rethrow 让确认框
 *      保持打开（此前失败零反馈且弹窗直接关闭）。
 *  B-3 弃用/激活行级 pending：第一击后按钮进入 loading，重复点击不再连发
 *      请求（与 downloadingId/pushing 纪律一致）。
 *  B-4 包名搜索 300ms 防抖：键入不逐字符触发全量请求（复用 useDebounce）。
 *  B-9 uploading 是后端真实枚举：状态 Tag、状态筛选可筛、弃用/激活禁用
 *      （后端对 uploading 翻转会 400）。
 *  B-12 上传大小校验（对齐后端 FileInterceptor 500MB）+ 上传进度回调。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import ExecutorPackagesPage from '../pages/ExecutorPackagesPage';
import {
  listPackages, uploadPackage, deletePackage, deprecatePackage, activatePackage,
} from '../api/executor-packages';
import { executorsApi } from '../api/executors';
import type { ExecutorPackage } from '../api/executor-packages';
import { Modal as confirmModal } from '../utils/modal';
import { message } from '../utils/toast';

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

/** antd 双汉字按钮自动插空格，textContent 归一化后精确匹配（既有先例） */
const findBtn = (root: ParentNode, text: string): HTMLButtonElement | null =>
  (Array.from(root.querySelectorAll('button')) as HTMLButtonElement[]).find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === text,
  ) ?? null;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listPackages).mockResolvedValue({ items: [packageRow], total: 1 });
  vi.mocked(executorsApi.list).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  // antd 静态 Modal/message holder 为 body 单例，不随 RTL cleanup 清理——
  // 显式销毁，避免确认框/toast 跨用例残留（既有 executor-detail-highrisk 先例）
  confirmModal.destroyAll();
  message.destroy();
});

describe('B-2 删除包失败反馈', () => {
  it('删除失败：showApiError 归一提示 + onOk rethrow（antd 保持确认框打开）', async () => {
    // 反证：改回 `onOk: async () => { await deletePackage(id); load(); }`
    // （无 catch），失败零反馈、rethrow 消失——本用例两处断言立即转红。
    vi.mocked(deletePackage).mockRejectedValue(new Error('boom'));
    const confirmSpy = vi.spyOn(confirmModal, 'confirm');
    const errorSpy = vi.spyOn(message, 'error');
    render(<ExecutorPackagesPage />);
    expect(await screen.findByText('python-runner')).toBeTruthy();

    fireEvent.click(document.querySelector('.anticon-delete')!.closest('button')!);
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());

    // 直接驱动 onOk（executor-ui07「Modal.confirm 走 onOk」先例）：rethrow 是
    // antd「onOk promise reject → 弹窗保持打开」的契约
    const onOk = confirmSpy.mock.calls[0][0].onOk!;
    let rejection: unknown = null;
    await act(async () => {
      try { await onOk(); } catch (e) { rejection = e; }
    });
    expect(rejection).toBeInstanceOf(Error);
    expect(errorSpy).toHaveBeenCalledWith('boom');
  });

  it('删除成功：调用 deletePackage 并刷新列表，onOk 正常收敛不抛错', async () => {
    vi.mocked(deletePackage).mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(confirmModal, 'confirm');
    render(<ExecutorPackagesPage />);
    expect(await screen.findByText('python-runner')).toBeTruthy();

    fireEvent.click(document.querySelector('.anticon-delete')!.closest('button')!);
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());

    const onOk = confirmSpy.mock.calls[0][0].onOk!;
    await expect(onOk()).resolves.toBeUndefined();
    expect(deletePackage).toHaveBeenCalledWith('pkg-1');
    expect(listPackages).toHaveBeenCalledTimes(2); // 挂载首载 + 删除后 load()
  });
});

describe('B-3 弃用/激活行级 pending', () => {
  it('快速重复点击只发一次弃用请求（行级 loading 防双击竞态）', async () => {
    let resolveDep: (v: ExecutorPackage) => void = () => {};
    vi.mocked(deprecatePackage).mockReturnValue(new Promise<ExecutorPackage>((r) => { resolveDep = r; }));
    render(<ExecutorPackagesPage />);
    expect(await screen.findByText('python-runner')).toBeTruthy();

    const stopBtn = document.querySelector('.anticon-stop')!.closest('button') as HTMLButtonElement;
    fireEvent.click(stopBtn);
    // 第一击后按钮进入行级 loading（在途），重复点击被吞
    await waitFor(() => expect(stopBtn.classList.contains('ant-btn-loading')).toBe(true));
    fireEvent.click(stopBtn);
    expect(deprecatePackage).toHaveBeenCalledTimes(1);

    resolveDep({ ...packageRow });
    await waitFor(() => expect(stopBtn.classList.contains('ant-btn-loading')).toBe(false));
  });
});

describe('B-4 包名搜索防抖', () => {
  it('键入不逐字符发请求：300ms 防抖后一次携带最新关键字', async () => {
    render(<ExecutorPackagesPage />);
    await waitFor(() => expect(listPackages).toHaveBeenCalledTimes(1));

    const searchInput = screen.getByPlaceholderText('搜索包名…');
    fireEvent.change(searchInput, { target: { value: 'a' } });
    // 防抖窗口内不立即发请求
    expect(listPackages).toHaveBeenCalledTimes(1);
    await act(async () => { await new Promise((r) => setTimeout(r, 420)); });
    await waitFor(() => expect(listPackages).toHaveBeenCalledTimes(2));
    expect(vi.mocked(listPackages).mock.calls[1][0]).toMatchObject({ name: 'a', page: 1 });

    fireEvent.change(searchInput, { target: { value: 'ab' } });
    expect(listPackages).toHaveBeenCalledTimes(2);
    await act(async () => { await new Promise((r) => setTimeout(r, 420)); });
    await waitFor(() => expect(listPackages).toHaveBeenCalledTimes(3));
    expect(vi.mocked(listPackages).mock.calls[2][0]).toMatchObject({ name: 'ab' });
  });
});

describe('B-9 uploading 状态（后端真实枚举）', () => {
  it('uploading 包：Tag「上传中」+ 弃用/激活按钮禁用（后端会 400）', async () => {
    vi.mocked(listPackages).mockResolvedValue({ items: [{ ...packageRow, status: 'uploading' }], total: 1 });
    render(<ExecutorPackagesPage />);
    expect(await screen.findByText('上传中')).toBeTruthy();

    const toggleBtn = document.querySelector('.anticon-check-circle')!.closest('button') as HTMLButtonElement;
    expect(toggleBtn.disabled).toBe(true);
    // 禁用即零请求
    fireEvent.click(toggleBtn);
    expect(deprecatePackage).not.toHaveBeenCalled();
    expect(activatePackage).not.toHaveBeenCalled();
  });

  it('状态筛选下拉提供「上传中」选项（与后端枚举同步）', async () => {
    render(<ExecutorPackagesPage />);
    expect(await screen.findByText('python-runner')).toBeTruthy();

    // 「状态」同时是表格列标题，按占位符 class 定位下拉（既有先例）
    const statusPlaceholder = screen
      .getAllByText('状态')
      .find((el) => (el as HTMLElement).classList?.contains('ant-select-placeholder'));
    expect(statusPlaceholder).toBeTruthy();
    fireEvent.mouseDown(statusPlaceholder!);
    await waitFor(() => {
      expect(document.querySelector('.ant-select-dropdown')?.textContent ?? '').toContain('上传中');
    });
  });
});

describe('B-12 上传大小校验与进度', () => {
  it('超限文件（>500MB）上传前被拒并提示，不发起请求、不进文件列表', async () => {
    const errorSpy = vi.spyOn(message, 'error');
    render(<ExecutorPackagesPage />);
    expect(await screen.findByText('python-runner')).toBeTruthy();

    fireEvent.click(screen.getByText('上传新包'));
    // 以弹窗标题锚定当前弹窗——jsdom 下关闭动画不结束，前一用例的隐藏
    // .ant-modal 包裹可能残留，document.querySelector 首个匹配不可靠
    const modal = (await screen.findByText('上传执行器包')).closest('.ant-modal')!;
    const input = modal.querySelector('input[type="file"]') as HTMLInputElement;
    const big = new File(['x'], 'big.zip', { type: 'application/zip' });
    Object.defineProperty(big, 'size', { value: 501 * 1024 * 1024 });
    await act(async () => { fireEvent.change(input, { target: { files: [big] } }); });

    // i18n 错误提示（上限值与后端 FileInterceptor limits 一致）
    await waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('文件超过大小上限（500 MB）'));
    });
    expect(uploadPackage).not.toHaveBeenCalled();
    // LIST_IGNORE：文件被剔除，不出现在上传列表
    expect(screen.queryByText('big.zip')).toBeNull();
  });

  it('合法文件提交：uploadPackage 收到 onUploadProgress 回调（进度条数据源）', async () => {
    vi.mocked(uploadPackage).mockResolvedValue({ ...packageRow });
    render(<ExecutorPackagesPage />);
    expect(await screen.findByText('python-runner')).toBeTruthy();

    fireEvent.click(screen.getByText('上传新包'));
    const modal = (await screen.findByText('上传执行器包')).closest('.ant-modal')!;
    const input = modal.querySelector('input[type="file"]') as HTMLInputElement;
    const ok = new File(['x'], 'pkg.zip', { type: 'application/zip' });
    await act(async () => { fireEvent.change(input, { target: { files: [ok] } }); });
    // 名称/版本输入按占位符定位（表单自带示例 placeholder）
    fireEvent.change(screen.getByPlaceholderText('python-runner'), { target: { value: 'runner' } });
    fireEvent.change(screen.getByPlaceholderText('1.0.0'), { target: { value: '2.0.0' } });
    await act(async () => { fireEvent.click(findBtn(modal, '确认上传')!); });

    await waitFor(() => expect(uploadPackage).toHaveBeenCalled());
    const progressCb = vi.mocked(uploadPackage).mock.calls[0][1];
    expect(typeof progressCb).toBe('function');
  });
});
