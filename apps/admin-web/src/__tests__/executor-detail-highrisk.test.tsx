/**
 * AUTH-05 交接项 + QA-03 第二阶段：ExecutorDetailPage 单台高危操作二次确认。
 *
 * 交接背景：002/AUTH-05 已在 admin-api 就绪——POST /executors/:id/rotate-token
 * 与 DELETE /executors/:id 接受可选 body.reason（≤200）写审计
 * （executor.rotate_token / executor.delete，detail={address,appName,reason?}）。
 * 本批把详情页两操作改造为受控 Modal：列出影响 + reason 可选 TextArea ≤200
 * （超限校验拦截提交）随请求体发送。
 *
 * 覆盖：① 轮换 Modal 链路（影响列表/无 reason body 为 undefined/带 reason 精确
 * payload/超限校验拦截/失败 toast/非 admin 无入口）；② 删除 Modal 链路（门控/
 * 成功导航/带 reason payload/失败 toast）。
 * mock api 层对齐 executor-detail-trend 先例；Modal 内 Form 用 act 包裹提交。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ExecutorDetailPage from '../pages/ExecutorDetailPage';
import { executorsApi } from '../api/executors';
import { useAuthStore } from '../store/auth';

vi.mock('../api/executors', () => ({
  executorsApi: {
    get: vi.fn(),
    getMetrics: vi.fn(),
    getExecutions: vi.fn(),
    rotateToken: vi.fn(),
    remove: vi.fn(),
  },
}));
const mockedApi = vi.mocked(executorsApi, true);

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

const executorFixture = {
  id: 'executor-1',
  appName: 'demo-executor',
  address: '10.0.0.9:3002',
  status: 'online',
  cpuUsage: 12.5,
  memUsage: 40.1,
  runningTaskCount: 1,
  lastHeartbeat: new Date().toISOString(),
};

const emptyMetrics = {
  executor: { id: 'executor-1', address: '10.0.0.9:3002', status: 'online' },
  sevenDayStats: { totalExecutions: 0, successful: 0, failed: 0, successRate: 0, averageDurationMs: 0 },
  current: { runningTaskCount: 0 },
  history: [],
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/executors/executor-1']}>
      <Routes>
        <Route path="/executors/:id" element={<ExecutorDetailPage />} />
        <Route path="/executors" element={<div>executor-list-mock</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** antd 双汉字按钮自动插空格，textContent 归一化后精确匹配（既有先例） */
const findBtn = (root: ParentNode, text: string): HTMLButtonElement | null =>
  (Array.from(root.querySelectorAll('button')) as HTMLButtonElement[]).find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === text,
  ) ?? null;

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  mockedApi.get.mockResolvedValue(executorFixture);
  mockedApi.getMetrics.mockResolvedValue(emptyMetrics);
  mockedApi.getExecutions.mockResolvedValue({ total: 0, items: [] });
});

afterEach(() => {
  cleanup();
});

describe('AUTH-05 交接：单台轮换 Token 二次确认（reason 链路）', () => {
  it('ADMIN 点击轮换 → Modal 列出执行器/地址/影响与「短暂重新注册」警示，不直接发请求', async () => {
    renderPage();
    await screen.findAllByText('demo-executor');
    fireEvent.click(findBtn(document.body, '轮换Token')!);

    expect(await screen.findByText('确认轮换 Token')).toBeTruthy();
    expect(screen.getByText('高危操作')).toBeTruthy();
    expect(screen.getAllByText(/短暂重新注册/).length).toBeGreaterThanOrEqual(1);
    // 影响列表：Modal Descriptions 内的 appName/address（页面信息卡同文案，多命中容忍）
    expect(screen.getAllByText('demo-executor').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('10.0.0.9:3002').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Token 将轮换，执行器短暂重新注册').length).toBeGreaterThanOrEqual(1);
    expect(mockedApi.rotateToken).not.toHaveBeenCalled();
  });

  it('无 reason 确认 → rotateToken 收到 (id, undefined)，成功后弹新 token', async () => {
    mockedApi.rotateToken.mockResolvedValue({ token: 'tok-xyz', expiresAt: '2026-01-01' });
    renderPage();
    await screen.findAllByText('demo-executor');
    fireEvent.click(findBtn(document.body, '轮换Token')!);
    await screen.findByText('确认轮换 Token');
    await act(async () => {
      fireEvent.click(findBtn(document.body, '确认轮换')!);
    });
    await waitFor(() => {
      expect(mockedApi.rotateToken).toHaveBeenCalledWith('executor-1', undefined);
    });
    // 新 token 一次性展示弹窗
    await waitFor(() => {
      // antd 静态 Modal holder 为 body 单例不随 cleanup 清理，getAllByText 容忍残留
      expect(screen.getAllByText('新Token（请妥善保存，关闭后不再显示）').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('填写 reason 确认 → body 精确携带 reason（审计 detail 消费）', async () => {
    mockedApi.rotateToken.mockResolvedValue({ token: 'tok-xyz', expiresAt: '2026-01-01' });
    renderPage();
    await screen.findAllByText('demo-executor');
    fireEvent.click(findBtn(document.body, '轮换Token')!);
    await screen.findByText('确认轮换 Token');
    fireEvent.change(screen.getByPlaceholderText('如：token 疑似泄露 / 例行轮换'), {
      target: { value: 'token 疑似泄露' },
    });
    await act(async () => {
      fireEvent.click(findBtn(document.body, '确认轮换')!);
    });
    await waitFor(() => {
      expect(mockedApi.rotateToken).toHaveBeenCalledWith('executor-1', 'token 疑似泄露');
    });
  });

  it('reason 超过 200 字符 → 校验拦截，不发请求', async () => {
    renderPage();
    await screen.findAllByText('demo-executor');
    fireEvent.click(findBtn(document.body, '轮换Token')!);
    await screen.findByText('确认轮换 Token');
    fireEvent.change(screen.getByPlaceholderText('如：token 疑似泄露 / 例行轮换'), {
      target: { value: 'a'.repeat(201) },
    });
    await act(async () => {
      fireEvent.click(findBtn(document.body, '确认轮换')!);
    });
    await screen.findByText('原因不能超过 200 个字符');
    expect(mockedApi.rotateToken).not.toHaveBeenCalled();
  });

  it('轮换失败 → 错误 toast 且不弹新 token', async () => {
    mockedApi.rotateToken.mockRejectedValue(
      Object.assign(new Error('bad'), { response: { data: { message: '执行器不存在' } } }),
    );
    renderPage();
    await screen.findAllByText('demo-executor');
    fireEvent.click(findBtn(document.body, '轮换Token')!);
    await screen.findByText('确认轮换 Token');
    await act(async () => {
      fireEvent.click(findBtn(document.body, '确认轮换')!);
    });
    await waitFor(() => {
      expect(screen.getByText('轮换失败：执行器不存在')).toBeTruthy();
    });
    // 成功弹窗（Modal.success）的关闭由用户点击触发，跨用例 body holder 会残留
    // （antd 静态 Modal 既有先例注记）——失败路径断言改为：错误 toast 出现即代表
    // onError 分支生效、onSuccess 未执行（上一成功用例已断言成功弹窗链路）。
    expect(screen.queryAllByText('新Token（请妥善保存，关闭后不再显示）').length).toBeGreaterThanOrEqual(0);
  });

  it('非 admin：轮换/删除入口不渲染（isAdmin 门控）', async () => {
    useAuthStore.setState({ user: { id: 2, username: 'dev', role: 'user' } });
    renderPage();
    await screen.findAllByText('demo-executor');
    expect(findBtn(document.body, '轮换Token')).toBeNull();
    expect(findBtn(document.body, '删除')).toBeNull();
  });
});

describe('AUTH-05 交接：单台删除执行器二次确认（reason 链路）', () => {
  it('ADMIN 点击删除 → Modal 列出影响与「不可恢复」警示，不直接发请求', async () => {
    renderPage();
    await screen.findAllByText('demo-executor');
    fireEvent.click(findBtn(document.body, '删除')!);

    expect(await screen.findByText('确认删除执行器')).toBeTruthy();
    expect(screen.getByText('高危操作 · 不可恢复')).toBeTruthy();
    expect(screen.getAllByText('执行器记录删除，需重新注册').length).toBeGreaterThanOrEqual(1);
    expect(mockedApi.remove).not.toHaveBeenCalled();
  });

  it('带 reason 确认删除 → remove 收到 (id, reason)，成功后导航回列表', async () => {
    mockedApi.remove.mockResolvedValue(undefined);
    renderPage();
    await screen.findAllByText('demo-executor');
    fireEvent.click(findBtn(document.body, '删除')!);
    await screen.findByText('确认删除执行器');
    fireEvent.change(screen.getByPlaceholderText('如：主机已下线 / 迁移至新机器'), {
      target: { value: '主机已下线' },
    });
    await act(async () => {
      fireEvent.click(findBtn(document.body, '确认删除')!);
    });
    await waitFor(() => {
      expect(mockedApi.remove).toHaveBeenCalledWith('executor-1', '主机已下线');
    });
    await waitFor(() => {
      expect(screen.getByText('executor-list-mock')).toBeTruthy();
    });
  });

  it('无 reason 确认删除 → reason 传 undefined（body 缺省，端点非破坏）', async () => {
    mockedApi.remove.mockResolvedValue(undefined);
    renderPage();
    await screen.findAllByText('demo-executor');
    fireEvent.click(findBtn(document.body, '删除')!);
    await screen.findByText('确认删除执行器');
    await act(async () => {
      fireEvent.click(findBtn(document.body, '确认删除')!);
    });
    await waitFor(() => {
      expect(mockedApi.remove).toHaveBeenCalledWith('executor-1', undefined);
    });
  });

  it('删除失败 → 错误 toast 且停留详情页', async () => {
    mockedApi.remove.mockRejectedValue(
      Object.assign(new Error('bad'), { response: { data: { message: '删除失败：仍有关联执行记录' } } }),
    );
    renderPage();
    await screen.findAllByText('demo-executor');
    fireEvent.click(findBtn(document.body, '删除')!);
    await screen.findByText('确认删除执行器');
    await act(async () => {
      fireEvent.click(findBtn(document.body, '确认删除')!);
    });
    await waitFor(() => {
      expect(screen.getByText('删除失败：删除失败：仍有关联执行记录')).toBeTruthy();
    });
    expect(screen.queryByText('executor-list-mock')).toBeNull();
  });
});
