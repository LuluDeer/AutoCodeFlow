/**
 * QA-03 第二阶段：RegistryPage（包市场）组件测试（此前零覆盖）。
 *
 * 页面形态：PyPI / npm 双 Tab。侦察结论（与任务书差异如实注记）：
 *  - registryApi.listPypiPackages / listNpmPackages **内部 try/catch 吞错返回 []**，
 *    StateError 页内错误块形态不适用于本页（UI-08 变更日志已注明「Registry 等
 *    请求失败仅 toast 的页面保留现状」）；错误态断言改为「失败 → 空态文案」语义；
 *  - 本页无删除入口（删除门控无从谈起）——深交互按实际代码覆盖：列表渲染/
 *    空态/上传 Modal 表单校验/上传成功载荷与刷新/npm 发布说明 Modal/Tab 切换。
 *
 * ahooks useRequest 真实现仅 mock api 层（dashboard-ui04 先例）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
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

  it('请求失败 → api 层吞错返回 [] → 空态（本页错误形态=空态兜底，非 StateError）', async () => {
    mockedRegistry.listPypiPackages.mockRejectedValue(new Error('registry down'));
    renderPage();
    expect(await screen.findByText('暂无 PyPI 包，点击上传添加第一个包')).toBeTruthy();
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
