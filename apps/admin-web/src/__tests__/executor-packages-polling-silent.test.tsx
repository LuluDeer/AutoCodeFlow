/**
 * ExecutorPackagesPage · 30s 后台轮询必须 silent（实施轮 #14，审计发现）。
 *
 * 现状（修前）：`setInterval` 直接调 `load()`，而 `load()` 无条件
 * `setLoading(true)`。后果：用户在读行/勾选/准备推送时，每 30s 整张表切成
 * 加载态闪一下；轮询失败还会弹 message.error（连续失败 = 持续噪音），并把
 * 页面推进错误态（`setLoadError`）——一次后台抖动就把用户正在看的数据换成
 * 错误块。
 *
 * 判据（两条，都能反证）：
 *   ① 轮询期间请求**挂起**时，表格不得出现加载态（.ant-spin）——修前必现；
 *   ② 轮询失败时页面保留旧数据、不出现错误块——修前会被 setLoadError 打掉。
 *
 * 顺带钉住「失焦暂停」：document.visibilityState !== 'visible' 时这一拍跳过。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
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

const row: ExecutorPackage = {
  id: 'pkg-1',
  name: 'python-runner',
  version: '1.0.0',
  type: 'python',
  platform: 'linux',
  fileSize: 1024,
  checksum: 'sha256',
  changelog: '',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const page = { items: [row], total: 1, page: 1, pageSize: 10 };

const mockedList = vi.mocked(listPackages);

describe('ExecutorPackagesPage · 30s 轮询 silent', () => {
  beforeEach(() => {
    // shouldAdvanceTime：假定时器自动推进真实时间——interval 能被 advanceTimersByTime
    // 精确触发，同时 antd/Testing Library 的 waitFor 仍能正常完成（纯 fake 会让
    // waitFor 永远等不到，实测 30s 超时）。
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedList.mockReset();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('轮询请求挂起时表格不进入加载态（修前 setLoading(true) 必现 .ant-spin）', async () => {
    mockedList.mockResolvedValueOnce(page);
    render(<ExecutorPackagesPage />);
    await waitFor(() => expect(screen.getAllByText('python-runner').length).toBeGreaterThan(0));

    // 第二次（轮询）请求保持挂起，模拟慢后端
    let release: (v: typeof page) => void = () => {};
    mockedList.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve as (v: typeof page) => void;
      }),
    );

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    // antd 的 Spin 走 CSSMotion（有过渡帧）：给它两帧再断言，否则「刚 setLoading(true)
    // 但 DOM 还没画出来」会被误判成「没有加载态」（实测反证明会漏红）。
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    expect(mockedList).toHaveBeenCalledTimes(2);
    // silent：加载态不出现（修前此处会有 .ant-spin 且表格变灰）
    expect(document.querySelector('.ant-spin-spinning')).toBeNull();

    await act(async () => {
      release(page);
    });
    expect(screen.getAllByText('python-runner').length).toBeGreaterThan(0);
  });

  it('轮询失败不弹错、不把页面推进错误态（旧数据保留）', async () => {
    mockedList.mockResolvedValueOnce(page);
    render(<ExecutorPackagesPage />);
    await waitFor(() => expect(screen.getAllByText('python-runner').length).toBeGreaterThan(0));

    mockedList.mockRejectedValueOnce(new Error('network down'));
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });

    // 旧数据仍在，且**不得**出现页内错误块（修前 setLoadError 会把它插到列表上方，
    // 并在持续失败时反复弹 toast）。判据取可见文案，不取内部 state。
    expect(screen.getAllByText('python-runner').length).toBeGreaterThan(0);
    expect(screen.queryByText('执行器包列表加载失败')).toBeNull();
    expect(document.querySelector('.ant-spin-spinning')).toBeNull();
  });

  it('失焦（visibilityState=hidden）时这一拍跳过轮询', async () => {
    mockedList.mockResolvedValueOnce(page);
    render(<ExecutorPackagesPage />);
    await waitFor(() => expect(screen.getAllByText('python-runner').length).toBeGreaterThan(0));

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(mockedList).toHaveBeenCalledTimes(1);
  });
});
