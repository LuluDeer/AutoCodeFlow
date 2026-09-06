/**
 * W3 回归：应用写面（创建/上传/编辑/删除/快速部署）后端已全链 @Roles(ADMIN)，
 * 但路由 /applications 对普通用户保持可见（读面可见是既有姿态）。
 * 页面须做按钮级 isAdmin 禁用（对齐 settings 页先例），普通用户不再看到
 * 大量必然 403 的可用按钮，也不发起会 403 的请求。
 * 来源对齐：useAuthStore().user.role（经 /auth/profile 补齐），settings 页同源。
 *
 * 注：按钮名用 getByText + closest('button') 定位而非 getByRole({ name })——
 * antd 图标字形会混入 accessible name（如 "eye 详情"），且环境相关不稳定；
 * 断言核心是 disabled 属性与请求契约，textContent 定位语义等价。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ApplicationListPage from '../pages/ApplicationListPage';
import { applicationsApi, deploymentsApi } from '../api/applications';
import { executorsApi } from '../api/executors';
import { useAuthStore } from '../store/auth';

// 隔离 api 层：底层 client 会拉起 axios 拦截器，测试只关心调用契约
vi.mock('../api/applications', () => ({
  applicationsApi: { list: vi.fn(), delete: vi.fn(), create: vi.fn(), update: vi.fn(), upload: vi.fn() },
  deploymentsApi: { list: vi.fn(), deploy: vi.fn() },
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn() },
}));

// jsdom 缺失 antd 依赖的浏览器 API，先行补齐（对齐 settings.ai.test 先例）
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

const appFixture = {
  id: 'app-1',
  name: 'order-service',
  version: '1.0.0',
  runtime: 'node',
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  vi.mocked(applicationsApi.list).mockReset().mockResolvedValue([appFixture] as never);
  vi.mocked(deploymentsApi.list).mockReset().mockResolvedValue({ data: [], total: 0 } as never);
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
});

afterEach(() => {
  cleanup();
});

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

describe('应用列表页写按钮 isAdmin 门控（W3）', () => {
  it('管理员：创建/上传/编辑/删除/新建部署均可用', async () => {
    renderList();
    await screen.findByText('order-service');

    expect(getBtn('创建应用').disabled).toBe(false);
    expect(getBtn('上传 ZIP').disabled).toBe(false);
    expect(getBtn('编辑').disabled).toBe(false);
    expect(getBtn('删除').disabled).toBe(false);
    expect(getBtn('新建部署').disabled).toBe(false);
  });

  it('普通用户：创建/上传/编辑/删除/新建部署禁用，读面（详情/刷新/列表）保持可用', async () => {
    useAuthStore.setState({ user: { id: 2, username: 'dev', role: 'user' } });
    renderList();
    await screen.findByText('order-service'); // 读面保持可见：列表照常渲染

    expect(getBtn('创建应用').disabled).toBe(true);
    expect(getBtn('上传 ZIP').disabled).toBe(true);
    expect(getBtn('编辑').disabled).toBe(true);
    expect(getBtn('删除').disabled).toBe(true);
    expect(getBtn('新建部署').disabled).toBe(true);
    // 读面不受影响
    expect(getBtn('详情').disabled).toBe(false);
    expect(getBtn('刷新').disabled).toBe(false);
  });

  it('普通用户点击禁用的删除按钮不触发 DELETE 请求', async () => {
    useAuthStore.setState({ user: { id: 2, username: 'dev', role: 'user' } });
    renderList();
    await screen.findByText('order-service');

    fireEvent.click(getBtn('删除')); // disabled 按钮 click 无效，Popconfirm 不弹出
    expect(applicationsApi.delete).not.toHaveBeenCalled();
    expect(screen.queryByText('确认删除此应用？')).toBeNull();
  });

  it('role 缺失（profile 尚未拉取）按非 ADMIN 处理：写按钮禁用', async () => {
    useAuthStore.setState({ user: { id: 3, username: 'legacy' } });
    renderList();
    await screen.findByText('order-service');

    expect(getBtn('创建应用').disabled).toBe(true);
    expect(getBtn('删除').disabled).toBe(true);
  });

  it('普通用户打开页面即发起且仅发起读请求（不触发写面 403）', async () => {
    useAuthStore.setState({ user: { id: 2, username: 'dev', role: 'user' } });
    renderList();
    await screen.findByText('order-service');

    await waitFor(() => expect(applicationsApi.list).toHaveBeenCalledTimes(1));
    expect(deploymentsApi.list).toHaveBeenCalled();
    // 不应有任何写请求
    expect(applicationsApi.delete).not.toHaveBeenCalled();
    expect(applicationsApi.create).not.toHaveBeenCalled();
    expect(applicationsApi.update).not.toHaveBeenCalled();
    expect(applicationsApi.upload).not.toHaveBeenCalled();
    expect(deploymentsApi.deploy).not.toHaveBeenCalled();
  });
});
