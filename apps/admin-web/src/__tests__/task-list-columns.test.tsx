/**
 * COLSET：任务列表列设置（显隐 + 顺序 + localStorage 信封持久化 + 重置默认）。
 *
 * 覆盖：
 *  1. 缺省核心六列：未配置时只渲染名称/状态/上次执行/下次执行/启用/操作 + 勾选列，
 *     触发方式/优先级/调度/运行时按 DEFAULT_HIDDEN_COLUMNS 收起，且不写持久化值；
 *  2. 勾选「调度」恢复显示 → 表头出现，信封隐藏集合相应剔除；取消勾选再次隐藏；
 *  3. 持久化生效：重挂载后列保持隐藏/恢复；
 *  4. 脏值防御：非法 JSON / 形状不符的存量 → 按缺省收起 / 剔除未知键处理；
 *  5. 防死面：仅剩最后一个可见列时再点其勾选不生效（模型层拒绝隐藏）。
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

/** 新信封键（与 TaskListPage useColumnPrefs 调用一致） */
const NEW_COLUMNS_KEY = 'autoflow-tasklist-columns:v1';

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

/** 读新信封的隐藏集合（无存量 → null）；隐藏集合语义无序，比较前排序 */
const storedHidden = (): string[] | null => {
  const raw = localStorage.getItem(NEW_COLUMNS_KEY);
  if (!raw) return null;
  return (JSON.parse(raw).data.hidden as string[]).slice().sort();
};

beforeEach(() => {
  cleanup();
  localStorage.removeItem(NEW_COLUMNS_KEY);
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
  localStorage.removeItem(NEW_COLUMNS_KEY);
  localStorage.removeItem(TASKLIST_COLUMNS_STORAGE_KEY);
});

describe('TaskListPage 列设置 — 缺省核心六列（P1-1 首屏治理）', () => {
  it('未配置时不写存储；勾选列 + 核心六列渲染，四个辅助列收起', async () => {
    renderPage();
    await screen.findByText('备份任务');
    expect(localStorage.getItem(NEW_COLUMNS_KEY)).toBeNull();
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

describe('TaskListPage 列设置 — 显隐过滤与持久化（COLSET）', () => {
  it('勾选「调度」恢复显示 → 表头出现，信封隐藏集合剔除 schedule；再取消勾选重新收起', async () => {
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
    expect(storedHidden()).toEqual(['priority', 'runtime', 'trigger']);
    expect(headerTexts()).not.toContain(col('runtime'));
    expect(headerTexts()).toContain(col('name'));

    // 再取消勾选 → 重新收起，隐藏集合回到缺省四列
    const scheduleCheckbox2 = (await openColumnSettings()) as HTMLInputElement;
    fireEvent.click(scheduleCheckbox2);
    await waitFor(() => {
      expect(headerTexts()).not.toContain(col('schedule'));
    });
    expect(storedHidden()).toEqual(['priority', 'runtime', 'schedule', 'trigger']);
  });

  it('持久化生效：重挂载后保持恢复显示的「调度」；取消勾选后回到缺省收起', async () => {
    // 模拟已持久化的新信封：调度被手动恢复（隐藏集合缺省四列剔除 schedule）
    localStorage.setItem(
      NEW_COLUMNS_KEY,
      JSON.stringify({
        version: 1,
        savedAt: 1,
        data: { hidden: ['trigger', 'priority', 'runtime'], order: [] },
      }),
    );
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
    expect(storedHidden()).toEqual(['priority', 'runtime', 'schedule', 'trigger']);
  });

  it('脏值防御：非法 JSON / 形状不符按缺省收起；未知列键剔除、合法键保留', async () => {
    localStorage.setItem(NEW_COLUMNS_KEY, 'not-json{{{');
    renderPage();
    await screen.findByText('备份任务');
    // 缺省收起的辅助列不可见
    expect(headerTexts()).not.toContain(col('schedule'));
    cleanup();

    localStorage.setItem(
      NEW_COLUMNS_KEY,
      JSON.stringify({ version: 1, savedAt: 1, data: { hidden: 'x', order: [] } }),
    );
    renderPage();
    await screen.findByText('备份任务');
    expect(headerTexts()).not.toContain(col('schedule'));
    cleanup();

    localStorage.setItem(
      NEW_COLUMNS_KEY,
      JSON.stringify({
        version: 1,
        savedAt: 1,
        data: { hidden: ['bogus-column', 'runtime'], order: [] },
      }),
    );
    renderPage();
    await screen.findByText('备份任务');
    // 未知键剔除；存量隐藏集以合法键为准（仅 runtime 隐藏），其余列按存量可见
    expect(headerTexts()).not.toContain(col('runtime'));
    expect(headerTexts()).toContain(col('schedule'));
    expect(headerTexts()).toContain(col('name'));
  });

  it('防死面：仅剩最后一个可见列时再点其勾选不生效（模型层拒绝隐藏）', async () => {
    localStorage.setItem(
      NEW_COLUMNS_KEY,
      JSON.stringify({
        version: 1,
        savedAt: 1,
        data: {
          hidden: ['status', 'trigger', 'priority', 'schedule', 'nextRun', 'lastRun', 'runtime', 'toggle', 'actions'],
          order: [],
        },
      }),
    );
    // 注：隐藏集合含全部非名称列 → 仅剩名称列可见。
    renderPage();
    await screen.findByText('备份任务');
    fireEvent.click(screen.getByTestId('tasklist-column-settings'));
    await waitFor(() => {
      const nameCheckbox = screen.getByRole('checkbox', { name: col('name') }) as HTMLInputElement;
      expect(nameCheckbox.checked).toBe(true);
    });
    const nameCheckbox = screen.getByRole('checkbox', { name: col('name') }) as HTMLInputElement;
    fireEvent.click(nameCheckbox);
    // 模型层拒绝隐藏最后一列：勾选态保持，名称列仍在表头
    expect(nameCheckbox.checked).toBe(true);
    expect(headerTexts()).toContain(col('name'));
  });
});
