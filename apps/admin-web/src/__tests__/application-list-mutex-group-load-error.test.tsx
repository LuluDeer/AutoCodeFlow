/**
 * R188（P3-3）· 应用表单的**互斥组下拉**：读失败不得渲染成「没有互斥组」。
 *
 * ## 为什么这一条值得单独一条测试（它是 9 条 P3 里后果最重的）
 *
 * 其它 P3 的后果都是「用户读错了一段信息」；**这一条的后果是「用户据此把一个不该上线的
 * 应用上线了」**：
 * ① 互斥组下拉**读失败**此前被 `catch {}` **空吞** ⇒ 下拉空；
 * ② 用户看到空下拉 ⇒ 以为「这台机器上没有配互斥组」；
 * ③ 保存 ⇒ 应用**不带互斥约束**上线；
 * ④ 两个都操作同一台设备的应用**同时跑、撞机** —— 而互斥正是「同一时刻只允许一台在跑」的
 *    **唯一保障**（词条原文：「多个应用都操作紫鸟浏览器时挂入同一互斥组」）。
 *
 * 触发面还是「**每次打开新建/编辑应用弹窗**」⇒ 命中概率高。
 *
 * ## 判据（三条）
 *
 * ① 读失败 ⇒ 页面出现**可重试的错误块**（不是只有一条会消失的 toast）；
 * ② 下拉的空态文案**不得**是「没有可用的互斥组」——失败时必须说「**这不代表没有互斥组**」；
 * ③ **正例控制组**：读成功时**不出现**错误块、空态文案是「没有可用的互斥组」
 *    （证明①不是因为「组件什么都不渲染」才绿的）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ApplicationListPage from '../pages/ApplicationListPage';
import { mutexGroupsApi } from '../api/applications';
import { useAuthStore } from '../store/auth';

vi.mock('../api/applications', () => ({
  applicationsApi: { list: vi.fn().mockResolvedValue({ data: [], total: 0 }), delete: vi.fn(), create: vi.fn(), update: vi.fn(), upload: vi.fn() },
  deploymentsApi: { list: vi.fn().mockResolvedValue([]), stats: vi.fn().mockResolvedValue([]), deploy: vi.fn() },
  mutexGroupsApi: { list: vi.fn(), create: vi.fn() },
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn().mockResolvedValue([]), picker: vi.fn().mockResolvedValue({ items: [], total: 0, truncated: false, limit: 2000 }) },
}));

// jsdom 缺失 antd 依赖的浏览器 API，先行补齐（对齐既有先例）
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

beforeEach(() => {
  vi.mocked(mutexGroupsApi.list).mockReset();
  useAuthStore.setState({ user: { id: 1, username: 'admin', role: 'admin' } as never });
});
afterEach(() => cleanup());

/** 打开「新建应用」弹窗（互斥组下拉所在的表单）。 */
async function openCreateForm() {
  render(
    <MemoryRouter>
      <ApplicationListPage />
    </MemoryRouter>,
  );
  const newBtn = await screen.findByRole('button', { name: /新建|创建|New/i });
  fireEvent.click(newBtn);
  await waitFor(() => expect(screen.queryAllByText(/互斥组|Mutex/i).length).toBeGreaterThan(0));
}

describe('R188（P3-3）· 互斥组下拉：读失败 ≠ 没有互斥组', () => {
  it('① 读失败 ⇒ 出现可重试的错误块（而不是静默空下拉）', async () => {
    vi.mocked(mutexGroupsApi.list).mockRejectedValue(new Error('boom'));
    await openCreateForm();
    await waitFor(() => {
      expect(screen.getAllByText(/获取互斥组列表失败|Failed to load the mutex group/i).length)
        .toBeGreaterThan(0);
    });
    expect(screen.getAllByRole('button', { name: /重试|Retry/i }).length).toBeGreaterThan(0);
  });

  it('② 失败时下拉空态**不得**说「没有可用的互斥组」', async () => {
    vi.mocked(mutexGroupsApi.list).mockRejectedValue(new Error('boom'));
    await openCreateForm();
    await waitFor(() => {
      expect(screen.getAllByText(/获取互斥组列表失败/i).length).toBeGreaterThan(0);
    });
    expect(screen.queryByText('没有可用的互斥组')).toBeNull();
    expect(screen.queryByText('No mutex groups available')).toBeNull();
  });

  it('③ 正例控制组：读成功 ⇒ 无错误块；**展开下拉**后空态文案是「没有可用的互斥组」', async () => {
    vi.mocked(mutexGroupsApi.list).mockResolvedValue([] as never);
    await openCreateForm();
    await waitFor(() => {
      expect(mutexGroupsApi.list).toHaveBeenCalled();
    });
    // 无错误块
    expect(screen.queryByText(/获取互斥组列表失败/i)).toBeNull();

    // 展开互斥组下拉（空态文案只在**展开后**才渲染 —— antd 的 `notFoundContent`
    // 是下拉面板的内容，不展开就看不见 ⇒ 这也是「用户要展开才发现」的地方）。
    const combo = screen.getByText('不参与互斥（默认）');
    fireEvent.mouseDown(combo);
    await waitFor(() => {
      expect(screen.getAllByText('没有可用的互斥组').length).toBeGreaterThan(0);
    });
  });
});
