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
  executorsApi: { list: vi.fn(), picker: vi.fn() },
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
  vi.mocked(executorsApi.picker).mockReset().mockResolvedValue({ items: [], total: 0, truncated: false, limit: 2000 } as never);
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

/**
 * UX-WALK R9 走查 A 级防回归（applications@375）：新建/编辑弹窗的「版本/运行时」
 * 「Git 分支/Git Commit」原为 Space flex（无断点）+ 固定像素宽（160/140、200/200），
 * 375px 弹窗 body 311px 下 160+16+140=316、200+16+200=416 直接溢出（真实
 * Chromium 实测 .ant-modal-body scrollWidth 416 > 311，Git Commit 输入框出血）。
 * 修复：Row gutter {xs:0,sm:16} + Col xs=24 sm=12（对齐 30236f5a ExecutorPackagesPage
 * 上传弹窗先例），固定宽移除改半列填充——375 单列全宽堆叠、sm+ 双列；
 * 行挂 .ux-gutter-flush（index.css ≥576px 媒体查询）钳制 gutter 负 margin 的
 * 8px scrollable overflow（executor-packages@600 同款 A 级），机制见该节注释。
 *
 * jsdom 无布局引擎，按 ui09 系列口径断言「渲染产物」：半列行挂 .ux-gutter-flush
 * 作用域类 + Row/Col 响应式类名 + 输入不再携带固定像素宽（任一回退，
 * 375 溢出即复现）。
 */
describe('ApplicationListPage 新建弹窗双列行响应式（UX-WALK R9 防回归）', () => {
  it('版本/运行时、Git 分支/Git Commit 渲染为 ux-gutter-flush 半列行，输入无固定像素宽', async () => {
    renderPage();
    await screen.findByText(/暂无应用/);
    fireEvent.click(findBtn(document.body, '创建应用')!);
    await screen.findByPlaceholderText('my-autocodeflow-app');

    const modal = document.body.querySelector('.ant-modal') as HTMLElement;
    expect(modal).toBeTruthy();
    // 恰好两条「半列行」Row（Form.Item 自身渲染 .ant-row.ant-form-item-row，排除）
    const pairRows = (Array.from(modal.querySelectorAll('.ant-row')) as HTMLElement[])
      .filter((r) => !r.className.includes('ant-form-item-row'));
    expect(pairRows.length).toBe(2);
    for (const row of pairRows) {
      // no-bleed 作用域类：index.css ≥576px 钳制行盒（margin-inline:0 +
      // 首/末列内边距重列），字段几何不变
      expect(row.className).toContain('ux-gutter-flush');
      // 每行两个 Col，均带 xs=24（<576 单列堆叠）/ sm=12（sm+ 桌面半列）响应式类
      const cols = (Array.from(row.children) as HTMLElement[])
        .filter((c) => c.className.includes('ant-col-xs-24') && c.className.includes('ant-col-sm-12'));
      expect(cols.length).toBe(2);
    }
    // 半列行内输入不再携带固定像素宽（width:160/140/200/200 是 375 溢出根源；
    // 375 堆叠后由 Col 全宽承载，与 name/desc/gitRepo 等整行字段一致）
    for (const ph of ['1.0.0', 'main', 'HEAD']) {
      const input = modal.querySelector(`input[placeholder="${ph}"]`) as HTMLInputElement | null;
      expect(input).toBeTruthy();
      expect(input!.style.width).toBe('');
    }
  });
});
