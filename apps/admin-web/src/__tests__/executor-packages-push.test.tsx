/**
 * Executor Lifecycle Audit —— 执行器包页回归守卫：
 *
 *  P2-7 包类型选项必须与后端 enum 对齐（node|python|universal）：
 *       java/shell 会被全局 ValidationPipe 以 400 拒绝；
 *  P2-8 「推送到全部在线调度机」：勾选全部时请求体只带在线 id（离线机不推），
 *       0 台在线时开始按钮禁用（旧实现仍会推给整个离线机群）；
 *  P3-12 推送弹窗里执行器列表加载失败 ≠ 机群为空：必须显式报错+重试，
 *       不得渲染「暂无在线调度机」。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import ExecutorPackagesPage from '../pages/ExecutorPackagesPage';
import {
  listPackages,
  pushPackage,
} from '../api/executor-packages';
import { executorsApi } from '../api/executors';
import type { ExecutorPackage } from '../api/executor-packages';
import type { Executor } from '../api/executors';

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

const mkExecutor = (over: Partial<Executor>): Executor => ({
  id: 'ex-1',
  appName: 'node-alpha',
  address: '10.0.0.1:3002',
  status: 'online',
  cpuUsage: 0,
  memUsage: 0,
  runningTaskCount: 0,
  lastHeartbeat: new Date().toISOString(),
  ...over,
});

/** 行内推送按钮：表格里唯一的纯图标 send 按钮（弹窗 footer 的同名图标带文字）。 */
function openPushModal() {
  const btn = Array.from(document.querySelectorAll('.anticon-send'))
    .map((icon) => icon.closest('button'))
    .find((b): b is HTMLButtonElement => !!b && (b.textContent ?? '').trim() === '');
  expect(btn).toBeTruthy();
  fireEvent.click(btn!);
}

const startPushButton = (): HTMLButtonElement =>
  Array.from(document.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === '开始推送',
  ) as HTMLButtonElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listPackages).mockResolvedValue({ items: [packageRow], total: 1 });
  vi.mocked(pushPackage).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

describe('P2-7 包类型筛选选项与后端 enum 对齐', () => {
  it('类型筛选只提供 node/python/universal，不提供会被后端 400 拒绝的 java/shell', async () => {
    // 反证：把 java/shell 加回 PACKAGE_TYPES（修复前两处 Select 都有），
    // 本用例立即转红。
    render(<ExecutorPackagesPage />);
    expect(await screen.findByText('python-runner')).toBeTruthy();

    // 打开工具栏「类型」筛选下拉。「类型」同时是表格列标题，故按占位符
    // 元素自身的 class 定位（antd v6 为 .ant-select-placeholder），
    // mousedown 直接打在占位符上（既有 executor-list 测试的先例）。
    const typePlaceholder = screen
      .getAllByText('类型')
      .find((el) => (el as HTMLElement).classList?.contains('ant-select-placeholder'));
    expect(typePlaceholder).toBeTruthy();
    fireEvent.mouseDown(typePlaceholder!);

    // 下拉选项挂在 body portal
    await screen.findByText('Node.js');
    // D-P2-02b：包类型列也走 runtimeLabel（表格行 Tag 与下拉选项均渲染 Python），用 AllBy 容忍双命中。
    expect(screen.getAllByText('Python').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Universal')).toBeTruthy();
    expect(screen.queryByText('Java')).toBeNull();
    expect(screen.queryByText('Shell')).toBeNull();
  });
});

describe('P2-8 推送到全部在线调度机', () => {
  it('机群含离线机时，「全部在线」只把在线 id 发给后端', async () => {
    // 反证：改回 `const ids = pushAll ? undefined : selectedExecutors`
    // （空名单 = 后端旧语义推全部行含离线机），toHaveBeenCalledWith
    // 精确匹配 ['ex-on'] 立即失败。
    vi.mocked(executorsApi.list).mockResolvedValue([
      mkExecutor({ id: 'ex-on', appName: 'online-node', status: 'online' }),
      mkExecutor({ id: 'ex-off', appName: 'offline-node', address: '10.0.0.2:3002', status: 'offline' }),
    ]);
    render(<ExecutorPackagesPage />);
    expect(await screen.findByText('python-runner')).toBeTruthy();

    openPushModal();

    // 计数只算在线机
    expect(await screen.findByText(/共\s*1\s*台在线/)).toBeTruthy();
    fireEvent.click(startPushButton());

    await waitFor(() => {
      expect(pushPackage).toHaveBeenCalledWith('pkg-1', ['ex-on']);
    });
    const sentIds = vi.mocked(pushPackage).mock.calls[0][1];
    expect(sentIds).not.toContain('ex-off');
  });

  it('0 台在线时显示警告且「开始推送」禁用（不会对离线机群发起推送）', async () => {
    // 反证：删掉 disabled 条件（修复前默认勾选 + 0 台仍可点），
    // 本用例第二段转红。
    vi.mocked(executorsApi.list).mockResolvedValue([
      mkExecutor({ id: 'ex-off', status: 'offline' }),
    ]);
    render(<ExecutorPackagesPage />);
    expect(await screen.findByText('python-runner')).toBeTruthy();

    openPushModal();

    expect(await screen.findByText('暂无在线调度机')).toBeTruthy();
    expect(startPushButton().disabled).toBe(true);
    fireEvent.click(startPushButton());
    expect(pushPackage).not.toHaveBeenCalled();
  });
});

describe('P3-12 推送弹窗执行器列表加载失败', () => {
  it('加载失败显示错误+重试，绝不伪装成「暂无在线调度机」；重试成功后恢复', async () => {
    // 反证：改回 catch { setExecutors([]) }，弹窗会渲染「暂无在线调度机」
    // 且没有任何重试入口——本用例第一段立即转红。
    // 注意：页面挂载时会为「机队版本漂移摘要」调用一次 executorsApi.list
    // （补充 P2：ExecutorPackagesPage useEffect 拉机队版本分布）。因此调用序列是：
    //   mount → resolve（机队版本摘要，失败静默）
    //   openPushModal → reject（推送弹窗执行器列表加载失败，本用例要测的）
    //   点重试 → resolve（恢复）
    // 旧契约只 mock 了「openPushModal 才调 list」，挂载那次多出来后，reject 被
    // 机队摘要那次消费掉、openPushModal 反而 resolve 了——errAlert 永远不出现。
    vi.mocked(executorsApi.list)
      .mockResolvedValueOnce([mkExecutor({ id: 'ex-on', status: 'online' })])
      .mockRejectedValueOnce(new Error('网络失败'))
      .mockResolvedValueOnce([mkExecutor({ id: 'ex-on', status: 'online' })]);
    render(<ExecutorPackagesPage />);
    expect(await screen.findByText('python-runner')).toBeTruthy();

    openPushModal();

    const errAlert = await screen.findByText(/执行器列表加载失败/);
    expect(errAlert).toBeTruthy();
    // 关键：失败是"未知"，不是"空机群"
    expect(screen.queryByText('暂无在线调度机')).toBeNull();
    // 未知机群状态下禁止推送
    expect(startPushButton().disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '重试加载' }));
    // 挂载那次机队版本摘要 + openPushModal 那次 + 本次重试 = 3 次
    await waitFor(() => expect(executorsApi.list).toHaveBeenCalledTimes(3));
    expect(await screen.findByText(/共\s*1\s*台在线/)).toBeTruthy();
    expect(screen.queryByText(/执行器列表加载失败/)).toBeNull();
    expect(startPushButton().disabled).toBe(false);
  });
});


describe('遗留 P1-10：push 响应 per-executor 明细（status/commandId/error）', () => {
  it('逐台渲染：queued 显示命令 ID、error 显示失败原因与执行器地址', async () => {
    vi.mocked(executorsApi.list).mockResolvedValue([
      mkExecutor({ id: 'ex-on', appName: 'online-node', status: 'online' }),
    ]);
    // 后端新形状：每台带 status（queued/success/error）+ 可选 commandId/error
    vi.mocked(pushPackage).mockResolvedValue([
      { executorId: 'ex-on', address: '10.0.0.1:3002', success: true, status: 'success' },
      { executorId: 'ex-on', address: '10.0.0.2:3002', success: true, status: 'queued', commandId: 'cmd-abc' },
      { executorId: 'ex-on', address: '10.0.0.3:3002', success: false, status: 'error', error: 'package checksum mismatch' },
    ]);
    render(<ExecutorPackagesPage />);
    expect(await screen.findByText('python-runner')).toBeTruthy();

    openPushModal();
    expect(await screen.findByText(/共\s*1\s*台在线/)).toBeTruthy();
    fireEvent.click(startPushButton());

    // queued 行：命令 ID 可见
    await waitFor(() => expect(screen.getByText(/命令 ID：cmd-abc/)).toBeTruthy());
    // error 行：失败原因与失败执行器地址可见
    await waitFor(() => expect(screen.getAllByText(/package checksum mismatch/).length).toBeGreaterThanOrEqual(1));
    expect(screen.getByText('10.0.0.3:3002')).toBeTruthy();
  });
});
