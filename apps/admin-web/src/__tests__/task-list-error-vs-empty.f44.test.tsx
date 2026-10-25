/**
 * F-44（UIUX 审计 P2-2）回归：列表 API 失败 ≠ 空结果。
 *
 * 真机证据：`/tasks?page=1&pageSize=1000` 触发后端 400「pageSize must not be
 * greater than 100」，页面渲染「共 0 个任务」空表无任何报错——用户误判数据丢失。
 * UI-16 已把列表错误接入 StateError（错误块+重试），但页头的「共 {{count}} 个
 * 任务」/分页器「共 {{count}} 条」仍会把 total=0（data undefined 的兜底值）当
 * 事实渲染。本文件钉住：错误态下错误块在场、计数文案退场、重试可恢复。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import TaskListPage from '../pages/TaskListPage';
import ExecutionsPage from '../pages/ExecutionsPage';
import { tasksApi } from '../api/tasks';
import { executorsApi } from '../api/executors';
import { useAuthStore } from '../store/auth';

vi.mock('../api/tasks', () => ({
  tasksApi: { list: vi.fn(), listAll: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 }) },
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn().mockResolvedValue([]) },
}));

// jsdom 缺失 antd 依赖的浏览器 API（对齐既有先例）
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

const testQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

function renderWithProviders(ui: React.ReactElement): void {
  render(
    <QueryClientProvider client={testQueryClient()}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('F-44: TaskListPage 错误态区分「请求失败」与「空结果」', () => {
  it('列表 400 → StateError 在场（含重试），页头不再显示「共 0 个任务」', async () => {
    vi.mocked(tasksApi.list).mockReset().mockRejectedValue(
      Object.assign(new Error('Request failed with status code 400'), {
        response: { status: 400, data: { message: 'pageSize must not be greater than 100' } },
      }) as never,
    );
    renderWithProviders(<TaskListPage />);

    // 错误块在场（data-testid=state-error，StateError 标准块）
    await waitFor(() => expect(document.querySelector('[data-testid="state-error"]')).toBeTruthy());
    expect(screen.getByText('任务列表加载失败')).toBeTruthy();

    // 页头计数退场——「共 0 个任务」不得出现（空结果与请求失败必须可区分）
    expect(screen.queryByText('共 0 个任务')).toBeNull();
  });

  it('空结果（成功返回 0 条）仍正常显示「共 0 个任务」，错误块不出现', async () => {
    vi.mocked(tasksApi.list).mockReset().mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      totalPages: 0,
    } as never);
    renderWithProviders(<TaskListPage />);

    await waitFor(() => expect(vi.mocked(tasksApi.list)).toHaveBeenCalled());
    // 成功路径的计数照旧（只有失败才隐藏）
    await waitFor(() => expect(screen.getByText('共 0 个任务')).toBeTruthy());
    expect(document.querySelector('[data-testid="state-error"]')).toBeNull();
  });

  it('错误态点重试 → 重新发起列表请求', async () => {
    vi.mocked(tasksApi.list)
      .mockReset()
      .mockRejectedValueOnce(new Error('boom') as never)
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 } as never);
    renderWithProviders(<TaskListPage />);

    await waitFor(() => expect(document.querySelector('[data-testid="state-error"]')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /重试|Retry/ }));
    await waitFor(() => expect(vi.mocked(tasksApi.list)).toHaveBeenCalledTimes(2));
  });
});

/** ExecutionsPage 走 react-router 的 useSearchParams/useNavigate，MemoryRouter 兜底。 */
describe('F-44: ExecutionsPage 错误态隐藏「共 0 条」计数', () => {
  it('列表失败 → StateError 在场，分页区/页头不出现「共 0 条」', async () => {
    vi.mocked(tasksApi.list).mockReset().mockRejectedValue(new Error('boom') as never);
    renderWithProviders(<ExecutionsPage />);

    await waitFor(() => expect(document.querySelector('[data-testid="state-error"]')).toBeTruthy());
    expect(screen.queryByText('共 0 条')).toBeNull();
  });
});
