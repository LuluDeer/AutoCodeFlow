/**
 * P2 审计回归：应用名 100 字符上限的前端镜像。
 *
 * 后端 Create/Update ApplicationDto 对 name 均有 @MaxLength(100)（全局
 * ValidationPipe 400），此前前端 rules 只有 required + 新建字符白名单——
 * 300 字符英文名吃裸 400（弹窗内无表单回显，只剩一条泛化 toast）。
 *
 * 修复形态对照 ProjectsPage 名称字段：max 校验规则 + 输入端 maxLength 截断。
 * 本文件钉住两条防线：
 *  1) 输入端 maxLength=100（属性镜像，超长粘贴在输入端被浏览器截断）；
 *  2) 校验规则兜底（jsdom 程序化赋值不触发 maxLength 截断——恰好能驱动
 *     max 规则本身）：>100 字符提交 → 停在校验并显示提示，不发起 create。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../i18n';
import ApplicationListPage from '../pages/ApplicationListPage';
import { applicationsApi, deploymentsApi } from '../api/applications';
import { executorsApi } from '../api/executors';
import { useAuthStore } from '../store/auth';

vi.mock('../api/applications', () => ({
  applicationsApi: {
    list: vi.fn(),
    delete: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    upload: vi.fn(),
  },
  deploymentsApi: { list: vi.fn(), stats: vi.fn().mockResolvedValue([]), deploy: vi.fn() },
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn(), picker: vi.fn() },
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
    // prefers-reduced-motion: reduce → antd/rc-motion 关闭弹窗动画（对齐先例）
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

const appFixture = {
  id: 'app-1',
  name: 'demo-app',
  version: '1.0.0',
  runtime: 'node',
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  vi.mocked(applicationsApi.list).mockReset().mockResolvedValue([appFixture] as never);
  vi.mocked(applicationsApi.create).mockReset().mockResolvedValue(appFixture as never);
  vi.mocked(deploymentsApi.list).mockReset().mockResolvedValue({ data: [], total: 0 } as never);
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.picker).mockReset().mockResolvedValue({ items: [], total: 0, truncated: false, limit: 2000 } as never);
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } as never });
});

afterEach(cleanup);

const renderList = () =>
  render(
    <MemoryRouter>
      <ApplicationListPage />
    </MemoryRouter>,
  );

/**
 * forceRender 下隐藏弹窗的内容会进 DOM：弹窗标题与页头按钮可能同文案
 * （如「创建应用」）。页面级操作须排除弹窗内的匹配（edit-name-rule 先例）。
 */
const getPageBtn = (label: string) => {
  const el = screen
    .getAllByText(label)
    .map((node) => node.closest('button'))
    .find((b) => b && !b.closest('.ant-modal'));
  if (!el) throw new Error(`page button not found: ${label}`);
  return el as HTMLButtonElement;
};

describe('应用名 100 字符上限镜像（P2 审计）', () => {
  it('新建弹窗名字输入框带 maxLength=100（输入端截断防线）', async () => {
    renderList();
    await screen.findByText('demo-app');

    fireEvent.click(getPageBtn('创建应用'));
    const nameInput = (await screen.findByPlaceholderText('my-autocodeflow-app')) as HTMLInputElement;
    expect(nameInput.maxLength).toBe(100);
  });

  it('>100 字符提交 → max 校验拦下并显示提示，不发起 create', async () => {
    renderList();
    await screen.findByText('demo-app');

    fireEvent.click(getPageBtn('创建应用'));
    const nameInput = (await screen.findByPlaceholderText('my-autocodeflow-app')) as HTMLInputElement;
    // jsdom 程序化赋值不触发原生 maxLength 截断——恰好驱动 max 校验规则本身
    fireEvent.change(nameInput, { target: { value: 'a'.repeat(150) } });
    fireEvent.click(document.querySelector('.ant-modal-footer .ant-btn-primary') as HTMLButtonElement);

    await waitFor(() =>
      expect(screen.getAllByText('应用名称最长 100 个字符').length).toBeGreaterThan(0),
    );
    expect(applicationsApi.create).not.toHaveBeenCalled();
  });

  it('≤100 字符名不被 max 规则拦截（校验只报其他必填缺失，不报名字超长）', async () => {
    renderList();
    await screen.findByText('demo-app');

    fireEvent.click(getPageBtn('创建应用'));
    const nameInput = (await screen.findByPlaceholderText('my-autocodeflow-app')) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'a'.repeat(100) } });
    fireEvent.click(document.querySelector('.ant-modal-footer .ant-btn-primary') as HTMLButtonElement);

    // name 字段本身零报错（required/max/pattern 全过）；运行时未选是弹窗
    // afterOpenChange 预设未在 jsdom 触发的既有现象，与本规则无关——恰好
    // 证明校验流程走到了名字之后。
    await waitFor(() => expect(screen.getByText('请选择运行时')).toBeTruthy());
    expect(screen.queryByText('应用名称最长 100 个字符')).toBeNull();
    expect(screen.queryByText('请输入应用名称')).toBeNull();
    expect(applicationsApi.create).not.toHaveBeenCalled();
  });
});
