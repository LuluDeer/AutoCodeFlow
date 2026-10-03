/**
 * UX 边界回归（本轮全站打磨）：ApplicationListPage
 *  ① 真空态给「创建第一个应用」CTA（对齐 TaskListPage empty.createFirst /
 *     ExecutorListPage empty.installFirst 口径），非管理员不出现（写面 ADMIN-only）；
 *  ② 防重复提交：新建/编辑弹窗保存期间确定按钮 loading+禁用——此前主编辑
 *     弹窗缺 confirmLoading，连点确定会对 create 发两次请求。
 *
 * mock 风格对齐 application-list-error-state / application-list-quick-deploy 先例；
 * matchMedia 桩返回 prefers-reduced-motion: reduce，使弹窗 afterOpenChange
 * （version/runtime 预填）在 jsdom 里同步触发（application-list-edit-name-rule 先例）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ApplicationListPage from '../pages/ApplicationListPage';
import { applicationsApi } from '../api/applications';
import { executorsApi } from '../api/executors';
import { useAuthStore } from '../store/auth';

vi.mock('../api/applications', () => ({
  applicationsApi: { list: vi.fn(), delete: vi.fn(), create: vi.fn(), update: vi.fn(), upload: vi.fn() },
  deploymentsApi: { list: vi.fn(), deploy: vi.fn() },
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn() },
}));

// jsdom 缺失 antd 依赖的浏览器 API，先行补齐（既有先例 shim）
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
    // prefers-reduced-motion: reduce → antd/rc-motion 关闭弹窗动画，
    // afterOpenChange 在 jsdom 里同步触发（见文件头注释）
    matches: /prefers-reduced-motion: reduce/.test(q),
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** antd 双汉字按钮自动插空格，textContent 归一化后再匹配（既有先例） */
const findBtn = (root: ParentNode, text: string): HTMLButtonElement | null =>
  (Array.from(root.querySelectorAll('button')) as HTMLButtonElement[]).find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === text,
  ) ?? null;

function renderPage() {
  return render(
    <MemoryRouter>
      <ApplicationListPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } as never });
  vi.mocked(applicationsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(applicationsApi.create).mockReset();
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ApplicationListPage 真空态 CTA（UX 边界）', () => {
  it('管理员看到「创建第一个应用」→ 点击打开创建弹窗', async () => {
    renderPage();
    expect(await screen.findByText(/暂无应用/)).toBeTruthy();

    const cta = screen.getByText('创建第一个应用');
    expect(cta.closest('button')).toBeTruthy();
    fireEvent.click(cta);

    // 弹窗打开（表单出现即视为已开）
    expect(await screen.findByPlaceholderText('my-autocodeflow-app')).toBeTruthy();
  });

  it('非管理员（写面 ADMIN-only）不出现 CTA，仅文案提示', async () => {
    useAuthStore.setState({ user: { id: 2, username: 'viewer', role: 'user' } as never });
    renderPage();
    expect(await screen.findByText(/暂无应用/)).toBeTruthy();
    expect(screen.queryByText('创建第一个应用')).toBeNull();
  });
});

describe('ApplicationListPage 新建弹窗防重复提交（UX 边界）', () => {
  it('保存请求飞行中确定按钮禁用，连点只发一次 create', async () => {
    let resolveCreate!: (v: unknown) => void;
    vi.mocked(applicationsApi.create).mockImplementation(
      // resolve 参数宽化为 unknown：测试只关心「何时落定」，不关心载荷类型
      () => new Promise((res) => { resolveCreate = res as (v: unknown) => void; }),
    );

    renderPage();
    await screen.findByText(/暂无应用/);

    // 打开创建弹窗并填写必填项（jsdom 下 afterOpenChange 预填不可靠——
    // version/runtime 显式填写，聚焦被测的防重复提交本身）
    fireEvent.click(findBtn(document.body, '创建应用')!);
    const nameInput = await screen.findByPlaceholderText('my-autocodeflow-app');
    fireEvent.change(nameInput, { target: { value: 'app-x' } });
    fireEvent.change(screen.getByPlaceholderText('1.0.0'), { target: { value: '1.0.0' } });
    // 「运行时」在列表筛选区也有同名占位——把范围收进弹窗，取弹窗内第一个 Select
    // （antd v6：下拉经 mouseDown 在 .ant-select 根节点上展开）
    const modalRoot = document.body.querySelector('.ant-modal') as HTMLElement;
    const runtimeSelect = modalRoot.querySelector('.ant-select') as HTMLElement;
    fireEvent.mouseDown(runtimeSelect);
    fireEvent.click(await screen.findByText('Node.js', { selector: '.ant-select-item-option-content' }));

    // 弹窗确定键：测试环境无 ConfigProvider，antd 默认 okText 是英文 "OK"——
    // 取 footer 最后一个按钮（cancel 在前 ok 在后），与 locale 无关
    const modalOkBtn = (): HTMLButtonElement =>
      Array.from(document.body.querySelectorAll('.ant-modal-footer button')).pop() as HTMLButtonElement;
    const okBtn = modalOkBtn();
    expect(okBtn).toBeTruthy();
    fireEvent.click(okBtn);
    await waitFor(() => expect(applicationsApi.create).toHaveBeenCalledTimes(1));

    // 请求未落定：确定按钮进入 loading 态（antd v6 loading 按钮不置 disabled
    // 属性，但 handleClick 对 innerLoading 直接吞掉点击）——断言 loading 类 +
    // 连点不再触发第二次 create
    await waitFor(() => expect(modalOkBtn().className).toContain('ant-btn-loading'));
    fireEvent.click(modalOkBtn());
    expect(applicationsApi.create).toHaveBeenCalledTimes(1);

    // 落定后：saving 复位（弹窗 forceRender 卸载前 DOM 常驻，不能拿输入框消失
    // 断言关闭）——确定按钮退出 loading 即代表 handleSubmit 走完成功分支
    resolveCreate({ id: 'app-new', name: 'app-x' });
    await waitFor(() => {
      expect(modalOkBtn().className).not.toContain('ant-btn-loading');
    });
  });
});
