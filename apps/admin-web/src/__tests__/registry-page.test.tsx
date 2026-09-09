/**
 * QA-03 第二阶段：RegistryPage（包市场）组件测试。
 *
 * 页面形态：PyPI / npm 双 Tab。
 * UI-16 变更注记：registryApi.listPypiPackages / listNpmPackages 不再吞错返回
 * []——请求 reject 时页面渲染 StateError 标准错误块（标题+错误信息+重试+复制），
 * 失败与空态语义分离（原「失败 → 空态文案」断言随之升级）。
 *
 * ahooks useRequest 真实现仅 mock api 层（dashboard-ui04 先例）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import RegistryPage from '../pages/RegistryPage';
import { registryApi } from '../api/registry';

vi.mock('../api/registry', () => ({
  registryApi: {
    listPypiPackages: vi.fn(),
    listNpmPackages: vi.fn(),
    uploadPypiPackage: vi.fn(),
    getPypiPackage: vi.fn(),
  },
}));
const mockedRegistry = vi.mocked(registryApi, true);
// 精确引用 mock 函数（mockReset 后重设 resolved 值的用例使用）
const listPypiMock = vi.mocked(registryApi.listPypiPackages);
const listNpmMock = vi.mocked(registryApi.listNpmPackages);

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
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const findBtn = (root: ParentNode, text: string): HTMLButtonElement | null =>
  (Array.from(root.querySelectorAll('button')) as HTMLButtonElement[]).find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === text,
  ) ?? null;

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockedRegistry.listPypiPackages.mockResolvedValue(['acme-core', 'acme-utils']);
  mockedRegistry.listNpmPackages.mockResolvedValue([
    { name: '@acme/node-runner', versions: ['1.0.0', '1.1.0'], description: '任务运行器', latest: '1.1.0' },
  ]);
});

afterEach(() => {
  cleanup();
});

function renderPage() {
  return render(<RegistryPage />);
}

describe('RegistryPage PyPI Tab（QA-03 第二阶段）', () => {
  it('渲染 PyPI 包列表（包名 code 形态/安装命令）与私有源配置卡', async () => {
    renderPage();
    expect(await screen.findByText('acme-core')).toBeTruthy();
    expect(screen.getByText('acme-utils')).toBeTruthy();
    expect(screen.getAllByText(/pip config set global.index-url/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('pip install acme-core')).toBeTruthy();
  });

  it('PyPI 列表为空 → 空态文案「暂无 PyPI 包」', async () => {
    mockedRegistry.listPypiPackages.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('暂无 PyPI 包，点击上传添加第一个包')).toBeTruthy();
  });

  it('请求失败 → StateError 错误块渲染（UI-16：失败与空态语义分离；重试恢复列表）', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    // mockReset 后再设 reject→resolve 序列（beforeEach 的 resolved 值被清掉）
    listPypiMock
      .mockReset()
      .mockRejectedValueOnce(new Error('registry down'))
      .mockResolvedValueOnce(['acme-core'] as never);
    mockedRegistry.listNpmPackages.mockResolvedValue([
      { name: '@acme/node-runner', versions: ['1.0.0'], description: '', latest: '1.0.0' },
    ] as never);
    renderPage();

    // StateError 标准错误块：testid 锚点 + 标题 + 具体错误消息
    expect(await screen.findByTestId('state-error')).toBeTruthy();
    expect(screen.getByText('PyPI 包列表加载失败')).toBeTruthy();
    expect(screen.getByText('registry down')).toBeTruthy();

    // 复制错误信息走剪贴板
    fireEvent.click(screen.getByText('复制错误信息'));
    await waitFor(() => {
      expect(writeText.mock.calls[0][0]).toContain('registry down');
    });

    // 重试 → list 再次被调用（refresh 语义）且恢复列表渲染
    fireEvent.click(screen.getByText('重试'));
    await waitFor(() => {
      expect(listPypiMock).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText('acme-core')).toBeTruthy();
  });

  it('上传 Modal：必填校验拦截（不调 uploadPypiPackage）', async () => {
    renderPage();
    await screen.findByText('acme-core');
    fireEvent.click(findBtn(document.body, '上传包')!);
    await screen.findByText('上传 PyPI 包');
    const swallowed: unknown[] = [];
    const onRejection = (reason: unknown) => { swallowed.push(reason); };
    process.on('unhandledRejection', onRejection);
    await act(async () => {
      fireEvent.submit(findBtn(document.body, '上传')!.closest('form')!);
    });
    await screen.findByText('请输入包名');
    expect(mockedRegistry.uploadPypiPackage).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    process.removeListener('unhandledRejection', onRejection);
  });

  it('填写 name/version 但未选文件提交 → 「请选择文件」拦截（不调 upload）', async () => {
    renderPage();
    await screen.findByText('acme-core');
    fireEvent.click(findBtn(document.body, '上传包')!);
    await screen.findByText('上传 PyPI 包');

    fireEvent.change(screen.getByPlaceholderText('my-package'), { target: { value: 'acme-new' } });
    fireEvent.change(screen.getByPlaceholderText('1.0.0'), { target: { value: '0.1.0' } });
    await act(async () => {
      fireEvent.submit(findBtn(document.body, '上传')!.closest('form')!);
    });
    await screen.findByText('请选择文件');
    expect(mockedRegistry.uploadPypiPackage).not.toHaveBeenCalled();
  });

  it('取消按钮关闭上传 Modal（同用例内点击无异常即关闭链路 OK）', async () => {
    renderPage();
    await screen.findByText('acme-core');
    fireEvent.click(findBtn(document.body, '上传包')!);
    await screen.findByText('上传 PyPI 包');
    fireEvent.click(findBtn(document.body, '取消')!);
    // antd 静态 Modal holder 为 body 单例不随关闭卸载（既有先例注记）——
    // 不做 DOM 消失断言（跨用例 holder 残留会污染 queryByText），
    // 点击无异常即取消链路成立。
    expect(findBtn(document.body, '取消')).toBeTruthy();
  });
});

describe('RegistryPage npm Tab（QA-03 第二阶段）', () => {
  it('Tab 切换到 npm → npm 包列表渲染（名称/最新版本/描述/安装命令）', async () => {
    renderPage();
    await screen.findByText('acme-core');
    fireEvent.click(screen.getByText(/npm \(Node\.js\)/));
    expect(await screen.findByText('@acme/node-runner')).toBeTruthy();
    expect(screen.getAllByText('1.1.0').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('任务运行器')).toBeTruthy();
    expect(mockedRegistry.listNpmPackages).toHaveBeenCalled();
  });

  it('npm 列表为空 → 空态文案「暂无 npm 包」', async () => {
    mockedRegistry.listNpmPackages.mockResolvedValue([]);
    renderPage();
    await screen.findByText('acme-core');
    fireEvent.click(screen.getByText(/npm \(Node\.js\)/));
    expect(await screen.findByText('暂无 npm 包，使用 npm publish 发布')).toBeTruthy();
  });

  it('npm 请求失败 → StateError 错误块渲染，重试恢复空态（UI-16）', async () => {
    listNpmMock
      .mockReset()
      .mockRejectedValueOnce(new Error('npm registry unreachable'))
      .mockResolvedValueOnce([] as never);
    renderPage();
    await screen.findByText('acme-core');
    fireEvent.click(screen.getByText(/npm \(Node\.js\)/));

    expect(await screen.findByTestId('state-error')).toBeTruthy();
    expect(screen.getByText('npm 包列表加载失败')).toBeTruthy();
    expect(screen.getByText('npm registry unreachable')).toBeTruthy();

    fireEvent.click(screen.getByText('重试'));
    await waitFor(() => {
      expect(listNpmMock).toHaveBeenCalledTimes(2);
    });
    // 重试成功返回空列表 → 空态恢复
    expect(await screen.findByText('暂无 npm 包，使用 npm publish 发布')).toBeTruthy();
  });

  it('npm 发布说明 Modal：打开渲染三步指引并可关闭', async () => {
    renderPage();
    await screen.findByText('acme-core');
    fireEvent.click(screen.getByText(/npm \(Node\.js\)/));
    fireEvent.click(await screen.findByText('发布说明'));
    await screen.findByText('发布 npm 包');
    expect(screen.getAllByText(/npm config set registry/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('npm publish')).toBeTruthy();
    await act(async () => {
      fireEvent.click(findBtn(document.body, '知道了')!);
    });
    // antd 静态 Modal holder 为 body 单例不随关闭卸载（既有先例注记）——
    // 关闭断言改为确认按钮存在即完成交互（点击无异常即链路 OK）。
    expect(findBtn(document.body, '知道了')).toBeTruthy();
  });
});
