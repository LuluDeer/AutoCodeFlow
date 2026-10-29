/**
 * W4（遗留 E5）：执行记录页的时间预设必须在「点击/展开时」求值，不能是渲染期。
 *
 * 缺陷：旧实现 `const timePresets = [{ value: [dayjs().subtract(1,'hour'), dayjs()] }]`
 * 在渲染期算。而本页 SSE live 时轮询关闭（queries.ts 的 sseFallbackRefetchInterval），
 * 长时间挂机期间页面**不会重渲染**——预设窗口冻结在几小时前，点「最近 1 小时」
 * 查的是几小时前的窗口，且选中回显也是旧窗口，用户毫无提示。
 *
 * 判据（fake timers）：t=0 渲染 → 时间推进 5h → 展开面板点「最近 1 小时」→
 * onChange 送出的区间下界 ≈ now(t=5h) - 1h（而不是 t=0 - 1h）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import dayjs from 'dayjs';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ExecutionsPage from '../pages/ExecutionsPage';
import { tasksApi } from '../api/tasks';
import type { TaskExecution } from '../api/tasks';

vi.mock('../api/tasks', () => ({
  tasksApi: {
    allExecutions: vi.fn(),
    killExecution: vi.fn(),
  },
}));
const mockedTasks = vi.mocked(tasksApi, true);

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

const exec = (over: Partial<TaskExecution>): TaskExecution => ({
  id: 'exec-1',
  taskId: 'task-1',
  taskName: '备份任务',
  status: 'success',
  triggerType: 'cron',
  executorAddress: '10.0.0.1:3002',
  startTime: '2026-09-07T10:00:00Z',
  endTime: '2026-09-07T10:01:00Z',
  duration: 60_000,
  params: null,
  createdAt: '2026-09-07T10:00:00Z',
  ...over,
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/executions']}>
        <Routes>
          <Route path="/executions" element={<ExecutionsPage />} />
          <Route path="/tasks/:taskId" element={<div>task-detail-mock</div>} />
          <Route path="/tasks/:taskId/executions/:execId" element={<div>execution-detail-mock</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openTimePanel() {
  const picker = document.querySelector('.ant-picker') as HTMLElement;
  expect(picker).toBeTruthy();
  fireEvent.click(picker);
  await waitFor(() => {
    expect(document.querySelector('.ant-picker-dropdown')).toBeTruthy();
  });
}

async function clickPreset(label: string) {
  await waitFor(() => {
    const items = [...document.querySelectorAll<HTMLElement>('.ant-picker-presets li')];
    expect(items.map((i) => i.textContent)).toContain(label);
  });
  const items = [...document.querySelectorAll<HTMLElement>('.ant-picker-presets li')];
  fireEvent.click(items.find((i) => i.textContent === label)!);
}

beforeEach(() => {
  // shouldAdvanceTime：RTL 的 waitFor 依赖真实时钟推进，纯 fake timers 会把它卡死
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  mockedTasks.allExecutions.mockReset().mockResolvedValue({
    items: [exec({})],
    total: 1,
    page: 1,
    pageSize: 20,
  });
  mockedTasks.killExecution.mockReset().mockResolvedValue({ ok: true } as never);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('W4 时间预设「点击时求值」', () => {
  it('页面挂机 5h 后点「最近 1 小时」→ 区间下界 ≈ 当前时刻-1h（不是渲染时刻-1h）', async () => {
    renderPage();
    await screen.findByText('备份任务');
    mockedTasks.allExecutions.mockClear();

    // 挂机 5 小时：SSE live 时页面不会重渲染，预设不得停留在 t=0
    vi.setSystemTime(new Date('2026-01-01T05:00:00Z'));

    await openTimePanel();
    await clickPreset('最近 1 小时');

    await waitFor(() => expect(mockedTasks.allExecutions.mock.calls.length).toBeGreaterThan(0));
    const calls = mockedTasks.allExecutions.mock.calls;
    const lastCall = calls[calls.length - 1]?.[0] as {
      startTime?: string;
      endTime?: string;
    };
    expect(lastCall?.startTime).toBeTruthy();
    // 期望下界 = now(5h) - 1h；渲染期求值会得到 now(0) - 1h（差 5h，必然红）
    expect(
      Math.abs(dayjs('2026-01-01T04:00:00Z').diff(dayjs(lastCall!.startTime), 'millisecond')),
    ).toBeLessThanOrEqual(2000);
    // 跨度精确 1h（两端同一锚点求值）
    expect(dayjs(lastCall!.endTime).diff(dayjs(lastCall!.startTime), 'hour')).toBe(1);
  });
});
