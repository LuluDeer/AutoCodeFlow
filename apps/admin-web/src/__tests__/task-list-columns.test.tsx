/**
 * COLSET-01：任务列表列设置（显隐过滤 + localStorage 持久化）。
 *
 * 覆盖：
 *  1. 缺省全显（零行为差异）：未配置时 11 列（勾选 1 + 数据 10）全部渲染，
 *     且不写入任何持久化值；
 *  2. 取消勾选「调度」→ 表头消失 + tasklist.columns.v1 写入隐藏键集合；
 *  3. 持久化生效：重挂载后列保持隐藏；重新勾选恢复显示且存量清空；
 *  4. 脏值防御：非法 JSON / 含未知列键的存量 → 按缺省全显 / 剔除未知键处理；
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

describe('TaskListPage 列设置 — 缺省全显（COLSET-01 零行为差异）', () => {
  it('未配置时不写存储、11 列全渲染（勾选 1 + 数据 10）', async () => {
    renderPage();
    await screen.findByText('备份任务');
    expect(localStorage.getItem(TASKLIST_COLUMNS_STORAGE_KEY)).toBeNull();
    const headers = headerTexts();
    expect(headers.length).toBe(11);
    for (const key of ['name', 'status', 'trigger', 'priority', 'schedule', 'nextRun', 'lastRun', 'runtime', 'toggle', 'actions']) {
      expect(headers).toContain(col(key));
    }
  });
});

describe('TaskListPage 列设置 — 显隐过滤与持久化（COLSET-01）', () => {
  it('取消勾选「调度」→ 表头消失，隐藏键写入 localStorage', async () => {
    renderPage();
    await screen.findByText('备份任务');
    const scheduleCheckbox = await openColumnSettings();

    fireEvent.click(scheduleCheckbox);
    await waitFor(() => {
      expect(headerTexts()).not.toContain(col('schedule'));
    });
    expect(JSON.parse(localStorage.getItem(TASKLIST_COLUMNS_STORAGE_KEY) ?? '')).toEqual(['schedule']);
    // 其余列不受影响
    expect(headerTexts()).toContain(col('name'));
    expect(headerTexts()).toContain(col('runtime'));
  });

  it('持久化生效：重挂载后列保持隐藏；重新勾选恢复显示且存量清空', async () => {
    const first = renderPage();
    await screen.findByText('备份任务');
    const scheduleCheckbox = await openColumnSettings();
    fireEvent.click(scheduleCheckbox);
    await waitFor(() => expect(headerTexts()).not.toContain(col('schedule')));
    first.unmount();

    // 重挂载：从 localStorage 恢复隐藏偏好
    renderPage();
    await screen.findByText('备份任务');
    expect(headerTexts()).not.toContain(col('schedule'));

    // 重新勾选 → 恢复显示 + 存量清空（= 缺省全显形态）
    const scheduleCheckbox2 = (await openColumnSettings()) as HTMLInputElement;
    expect(scheduleCheckbox2.checked).toBe(false);
    fireEvent.click(scheduleCheckbox2);
    await waitFor(() => expect(headerTexts()).toContain(col('schedule')));
    expect(JSON.parse(localStorage.getItem(TASKLIST_COLUMNS_STORAGE_KEY) ?? '')).toEqual([]);
  });

  it('脏值防御：非法 JSON 按缺省全显；未知列键剔除、合法键保留', async () => {
    localStorage.setItem(TASKLIST_COLUMNS_STORAGE_KEY, 'not-json{{{');
    renderPage();
    await screen.findByText('备份任务');
    expect(headerTexts()).toContain(col('schedule'));
    cleanup();

    localStorage.setItem(TASKLIST_COLUMNS_STORAGE_KEY, JSON.stringify(['bogus-column', 'runtime']));
    renderPage();
    await screen.findByText('备份任务');
    expect(headerTexts()).not.toContain(col('runtime'));
    expect(headerTexts()).toContain(col('schedule'));
  });

  it('防死面：仅剩最后一个可见列时其勾选框禁用', async () => {
    localStorage.setItem(
      TASKLIST_COLUMNS_STORAGE_KEY,
      JSON.stringify(['status', 'trigger', 'priority', 'schedule', 'nextRun', 'lastRun', 'runtime', 'toggle', 'actions']),
    );
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
