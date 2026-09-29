/**
 * 回归：存量应用（zip 上传通道历来不限名字字符，实测存在含 U+2011 不断行
 * 连字符等非 ASCII 字符的名字）在编辑弹窗里保存任意字段时，被**禁用的**
 * 名字输入框的字符白名单规则拦死——该字段编辑态本就 disabled 不可变
 * （handleSubmit 亦 delete 掉 name 再提交），对其套新建白名单等于把这类
 * 存量应用的每一次编辑保存都变成死锁，用户无从修复。
 *
 * 修复：字符白名单只在新建时校验。本测试用 U+2011 名字走完整编辑保存流，
 * 钉住「update 正常发出且不带 name」的契约。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ApplicationListPage from '../pages/ApplicationListPage';
import { applicationsApi, deploymentsApi } from '../api/applications';
import { executorsApi } from '../api/executors';
import { useAuthStore } from '../store/auth';

vi.mock('../api/applications', () => ({
  applicationsApi: {
    list: vi.fn(),
    delete: vi.fn(),
    create: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
    upload: vi.fn(),
  },
  deploymentsApi: { list: vi.fn(), deploy: vi.fn() },
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
    // prefers-reduced-motion: reduce → antd/rc-motion 关闭弹窗动画，
    // afterOpenChange（编辑态名字回填）在 jsdom 里同步触发——jsdom 无真实
    // transitionend 事件，动画等待会让表单回填永不发生。
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

// U+2011 NON-BREAKING HYPHEN：用户实测存量应用名（zip 上传带入）
const legacyName = 'tiktok\u2011es\u2011shop\u2011settlement\u2011screenshot';
const appFixture = {
  id: 'app-1',
  name: legacyName,
  version: '1.0.0',
  runtime: 'node',
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  vi.mocked(applicationsApi.list).mockReset().mockResolvedValue([appFixture] as never);
  vi.mocked(applicationsApi.update).mockReset().mockResolvedValue(appFixture as never);
  vi.mocked(deploymentsApi.list).mockReset().mockResolvedValue({ data: [], total: 0 } as never);
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } as never });
});

afterEach(() => cleanup());

const renderList = () =>
  render(
    <MemoryRouter>
      <ApplicationListPage />
    </MemoryRouter>,
  );

/** 按可见文本找 button（span 文本 → 最近 button 祖先） */
const getBtn = (label: string) => {
  const el = screen.getByText(label);
  return el.closest('button') as HTMLButtonElement;
};

/**
 * forceRender 下隐藏弹窗的内容会进 DOM：弹窗标题与页头按钮可能同文案
 * （如「创建应用」）。页面级操作须排除弹窗内的匹配。
 */
const getPageBtn = (label: string) => {
  const el = screen
    .getAllByText(label)
    .map((node) => node.closest('button'))
    .find((b) => b && !b.closest('.ant-modal'));
  if (!el) throw new Error(`page button not found: ${label}`);
  return el as HTMLButtonElement;
};

describe('存量应用编辑保存不被禁用名字字段的白名单拦死', () => {
  it('名字含 U+2011 连字符的存量应用：编辑弹窗保存 → update 正常发出且不带 name', async () => {
    renderList();
    await screen.findByText(legacyName);

    fireEvent.click(getBtn('编辑'));

    // 编辑态名字字段被回填且禁用（依赖 afterOpenChange 的回填时序）
    const nameInput = (await screen.findByDisplayValue(legacyName)) as HTMLInputElement;
    expect(nameInput.disabled).toBe(true);

    fireEvent.click(document.querySelector('.ant-modal-footer .ant-btn-primary') as HTMLButtonElement);

    await waitFor(() => expect(applicationsApi.update).toHaveBeenCalledTimes(1));
    const [calledId, payload] = vi.mocked(applicationsApi.update).mock.calls[0];
    expect(calledId).toBe('app-1');
    expect(payload).toBeTruthy();
    // 名字是不可变标识：update 载荷不得携带 name（白名单也不再对其校验）
    expect((payload as Record<string, unknown>).name).toBeUndefined();
  });

  it('新建弹窗仍保留字符白名单（防回归走另一极端）', async () => {
    renderList();
    await screen.findByText(legacyName);

    fireEvent.click(getPageBtn('创建应用'));
    const nameInput = (await screen.findByPlaceholderText('my-autocodeflow-app')) as HTMLInputElement;
    expect(nameInput.disabled).toBe(false);

    // 填入非法字符后提交 → 停在校验，不发起 create
    fireEvent.change(nameInput, { target: { value: 'bad name!' } });
    fireEvent.click(document.querySelector('.ant-modal-footer .ant-btn-primary') as HTMLButtonElement);

    await waitFor(() => expect(screen.getAllByText('只允许字母、数字、下划线和连字符').length).toBeGreaterThan(0));
    expect(applicationsApi.create).not.toHaveBeenCalled();
  });
});
