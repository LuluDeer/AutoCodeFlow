/**
 * COLSET-01 / P1-1：任务列表列设置（显隐过滤 + localStorage 持久化）。
 *
 * 覆盖：
 *  1. 缺省核心六列：未配置时只渲染名称/状态/上次执行/下次执行/启用/操作 + 勾选列，
 *     触发方式/优先级/调度/运行时按 DEFAULT_HIDDEN_COLUMNS 收起，且不写持久化值；
 *  2. 勾选「调度」恢复显示 → 表头出现，隐藏键集合相应剔除；取消勾选再次隐藏；
 *  3. 持久化生效：重挂载后列保持隐藏/恢复；
 *  4. 脏值防御：非法 JSON / 含未知列键的存量 → 按缺省收起 / 剔除未知键处理；
 *  5. 防死面：仅剩最后一个可见列时其勾选框禁用。
 *
 * 口径对齐 task-list-deep：mock api 层、QueryClientProvider + MemoryRouter；
 * 断言表头走 i18n 唯一事实源（i18n.t('taskList.col.*')）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaskListPage from '../pages/TaskListPage';
import { tasksApi, type Task } from '../api/tasks';
import i18n from '../i18n';
import { TASKLIST_COLUMNS_STORAGE_KEY } from '../utils/taskColumns';

vi.mock('../api/tasks', async () => {
  const actual = await vi.importActual<typeof import('../api/tasks')>('../api/tasks');
  return {
    summarizeBatch: actual.summarizeBatch,
    tasksApi: {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      trigger: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      batchTrigger: vi.fn(),
      batchPause: vi.fn(),
      batchResume: vi.fn(),
      batchDelete: vi.fn(),
    },
  };
});
const mockedTasks = vi.mocked(tasksApi, true);

// jsdom 缺失 antd 依赖的浏览器 API（task-list-deep 同款 shim）
const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const makeTask = (over: Partial<Task> = {}): Task => ({
  id: 'task-1',
  name: '备份任务',
  runtime: 'python',
  entrypoint: 'src/main.py',
  status: 'active',
  triggerType: 'cron',
  cronExpression: '0 2 * * *',
  maxRetry: 3,
  timeout: 300,
  priority: 2,
  createdAt: '2026-09-01T08:00:00Z',
  updatedAt: '2026-09-07T08:00:00Z',
  ...over,
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/tasks']}>
        <TaskListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 当前渲染的表头文案序列（勾选列无文案，首项为空串） */
const headerTexts = (): string[] =>
  Array.from(document.querySelectorAll('.ant-table thead th')).map(
    (th) => th.textContent ?? '',
  );

/** 列键 → i18n 键段（与 TaskListPage 的 COLUMN_LABEL_KEY 对齐：toggle→enabled） */
const COL_I18N_SEGMENT: Record<string, string> = {
  name: 'name', status: 'status', trigger: 'trigger', priority: 'priority',
  schedule: 'schedule', nextRun: 'nextRun', lastRun: 'lastRun',
  runtime: 'runtime', toggle: 'enabled', actions: 'actions',
};

const col = (key: string): string => i18n.t(`taskList.col.${COL_I18N_SEGMENT[key]}`) as string;

/** 打开列设置 Popover */
async function openColumnSettings() {
  fireEvent.click(screen.getByTestId('tasklist-column-settings'));
  return waitFor(() => {
    const cb = screen.getByRole('checkbox', { name: col('schedule') }) as HTMLInputElement;
    expect(cb).toBeTruthy();
    return cb;
  });
}

beforeEach(() => {
  cleanup();
  localStorage.removeItem(TASKLIST_COLUMNS_STORAGE_KEY);
  vi.clearAllMocks();
  mockedTasks.list.mockResolvedValue({
    items: [makeTask()],
    total: 1,
    page: 1,
    pageSize: 20,
  });
});

afterEach(() => {
  cleanup();
  localStorage.removeItem(TASKLIST_COLUMNS_STORAGE_KEY);
});

describe('TaskListPage 列设置 — 缺省核心六列（P1-1 首屏治理）', () => {
  it('未配置时不写存储；勾选列 + 核心六列渲染，四个辅助列收起', async () => {
    renderPage();
    await screen.findByText('备份任务');
    expect(localStorage.getItem(TASKLIST_COLUMNS_STORAGE_KEY)).toBeNull();
    const headers = headerTexts();
    expect(headers.length).toBe(7); // 勾选 1 + 核心数据 6
    for (const key of ['name', 'status', 'lastRun', 'nextRun', 'toggle', 'actions']) {
      expect(headers).toContain(col(key));
    }
    for (const key of ['trigger', 'priority', 'schedule', 'runtime']) {
      expect(headers).not.toContain(col(key));
    }
  });
});

describe('TaskListPage 列设置 — 显隐过滤与持久化（COLSET-01）', () => {
  it('勾选「调度」恢复显示 → 表头出现，隐藏键集合剔除 schedule；再取消勾选重新收起', async () => {
    renderPage();
    await screen.findByText('备份任务');
    expect(headerTexts()).not.toContain(col('schedule'));
    const scheduleCheckbox = await openColumnSettings();
    expect(scheduleCheckbox.checked).toBe(false);

    fireEvent.click(scheduleCheckbox);
    await waitFor(() => {
      expect(headerTexts()).toContain(col('schedule'));
    });
    // 缺省收起的其余三列仍隐藏；隐藏集合 = DEFAULT_HIDDEN_COLUMNS 剔除 schedule
    expect(JSON.parse(localStorage.getItem(TASKLIST_COLUMNS_STORAGE_KEY) ?? '')).toEqual(['trigger', 'priority', 'runtime']);
    expect(headerTexts()).not.toContain(col('runtime'));
    expect(headerTexts()).toContain(col('name'));

    // 再取消勾选 → 重新收起，隐藏集合回到缺省四列
    const scheduleCheckbox2 = (await openColumnSettings()) as HTMLInputElement;
    fireEvent.click(scheduleCheckbox2);
    await waitFor(() => {
      expect(headerTexts()).not.toContain(col('schedule'));
    });
    expect(JSON.parse(localStorage.getItem(TASKLIST_COLUMNS_STORAGE_KEY) ?? '')).toEqual(['trigger', 'priority', 'schedule', 'runtime']);
  });

  it('持久化生效：重挂载后保持恢复显示的「调度」；取消勾选后回到缺省收起', async () => {
    // 模拟已持久化的偏好：调度被手动恢复（隐藏集合缺省四列剔除 schedule）
    localStorage.setItem(TASKLIST_COLUMNS_STORAGE_KEY, JSON.stringify(['trigger', 'priority', 'runtime']));
    const first = renderPage();
    await screen.findByText('备份任务');
    expect(headerTexts()).toContain(col('schedule'));
    first.unmount();

    // 重挂载：从 localStorage 恢复偏好，调度仍可见
    renderPage();
    await screen.findByText('备份任务');
    expect(headerTexts()).toContain(col('schedule'));

    // 取消勾选 → 重新收起，隐藏集合回到缺省四列
    const scheduleCheckbox2 = (await openColumnSettings()) as HTMLInputElement;
    expect(scheduleCheckbox2.checked).toBe(true);
    fireEvent.click(scheduleCheckbox2);
    await waitFor(() => expect(headerTexts()).not.toContain(col('schedule')));
    expect(JSON.parse(localStorage.getItem(TASKLIST_COLUMNS_STORAGE_KEY) ?? '')).toEqual(['trigger', 'priority', 'schedule', 'runtime']);
  });

  it('脏值防御：非法 JSON 按缺省收起；未知列键剔除、合法键保留', async () => {
    localStorage.setItem(TASKLIST_COLUMNS_STORAGE_KEY, 'not-json{{{');
    renderPage();
    await screen.findByText('备份任务');
    // 缺省收起的辅助列不可见
    expect(headerTexts()).not.toContain(col('schedule'));
    cleanup();

    localStorage.setItem(TASKLIST_COLUMNS_STORAGE_KEY, JSON.stringify(['bogus-column', 'runtime']));
    renderPage();
    await screen.findByText('备份任务');
    // 未知键剔除；存量隐藏集以合法键为准（仅 runtime 隐藏），其余列按存量可见
    expect(headerTexts()).not.toContain(col('runtime'));
    expect(headerTexts()).toContain(col('schedule'));
    expect(headerTexts()).toContain(col('name'));
  });

  it('防死面：仅剩最后一个可见列时其勾选框禁用', async () => {
    localStorage.setItem(
      TASKLIST_COLUMNS_STORAGE_KEY,
      JSON.stringify(['status', 'trigger', 'priority', 'schedule', 'nextRun', 'lastRun', 'runtime', 'toggle', 'actions']),
    );
    // 注：隐藏集合含全部非名称列 → 仅剩名称列可见，其勾选框禁用。
    renderPage();
    await screen.findByText('备份任务');
    fireEvent.click(screen.getByTestId('tasklist-column-settings'));
    await waitFor(() => {
      const nameCheckbox = screen.getByRole('checkbox', { name: col('name') }) as HTMLInputElement;
      expect(nameCheckbox.checked).toBe(true);
      expect(nameCheckbox.disabled).toBe(true);
    });
    // 仍可恢复其他列（非唯一列不受禁用约束）
    const runtimeCheckbox = screen.getByRole('checkbox', { name: col('runtime') }) as HTMLInputElement;
    expect(runtimeCheckbox.disabled).toBe(false);
  });
});
