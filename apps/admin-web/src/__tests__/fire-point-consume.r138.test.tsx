/**
 * R138 / A6b：控制台「提前触发并消耗下一个 cron 计划点」入口（两处触发弹窗）。
 *
 * ## 背景（`artifacts/autonomy/R138/assess-feature.md` F-1）
 * 后端 `consumeNextFirePoint` 全链路齐备（DTO/Controller/Service + 12 例专项
 * spec），产品文档 `docs/OPEN-DECISIONS.md:18` 与真机验收表 `docs/VERIFY-MATRIX.md:56`
 * 都按「**勾选**」描述，但 `admin-web/src` 此前 **0 命中** —— 只能 curl。
 *
 * ## 本文件钉的三条（任务书用例 ① ② ③，两处弹窗各有判据）
 *   ① cron 任务**勾选**后提交 ⇒ `tasksApi.trigger` 第 4 参含 `{ consumeNextFirePoint: true }`；
 *   ② cron 任务**不勾选** ⇒ 不传 true（载荷级「键不出现」的判据在
 *      `tasks.trigger-fire-point.r138.test.ts`——页面层只能看到透传值，
 *      真实 body 由 api 层逐字节把关）；
 *   ③ **非 cron** 任务弹窗**不渲染**该复选框（与后端 400 `TASK_FIRE_POINT_NOT_CRON` 对齐）。
 *
 * ## 反证（已实跑，见 artifacts/autonomy/R138/impl-firepoint.md）
 * 把两处「仅 cron 渲染」的条件临时改成恒真 ⇒ ③ 变红；
 * 把 `useTaskTrigger` / `TaskListPage` 提交时的 `{ consumeNextFirePoint }` 换成
 * `undefined` ⇒ ① 变红。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import TaskListPage from '../pages/TaskListPage';
import TaskDetailPage from '../pages/TaskDetailPage';
import { tasksApi, type Task } from '../api/tasks';
import { useAuthStore } from '../store/auth';

// 两页各自消费同一组 api 面：`list`/`get` 供查询，`trigger` 是被断言的写口。
vi.mock('../api/tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/tasks')>();
  return {
    ...actual,
    tasksApi: {
      ...actual.tasksApi,
      list: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      trigger: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      killExecution: vi.fn(),
      executions: vi.fn(),
      stats: vi.fn(),
      webhookStatus: vi.fn(),
      webhookEnable: vi.fn(),
      webhookRotate: vi.fn(),
      webhookDisable: vi.fn(),
      versions: vi.fn(),
      compareVersions: vi.fn(),
      rollbackToVersion: vi.fn(),
      batchTrigger: vi.fn(),
      batchPause: vi.fn(),
      batchResume: vi.fn(),
      batchDelete: vi.fn(),
    },
  };
});
vi.mock('../api/ai', () => ({ aiApi: { suggestSchedule: vi.fn() } }));
// 重子组件裁剪（对齐 task-detail-maintenance.test.tsx 先例）：本用例只关心弹窗里的
// A6b 复选框与提交参数，编辑器/依赖图/参数编辑器换成桩。
vi.mock('../components/GlueEditor', () => ({ default: () => <div data-testid="glue-editor" /> }));
vi.mock('../components/TaskDependencyGraph', () => ({ default: () => <div data-testid="dep-graph" /> }));
vi.mock('../components/ParamsEditor', () => ({ default: () => <div data-testid="params-editor" /> }));

// jsdom 缺失 antd 依赖的浏览器 API（对齐既有测试先例）。
const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const makeTask = (over: Partial<Task> = {}): Task =>
  ({
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
    params: {},
    createdAt: '2026-09-01T08:00:00Z',
    updatedAt: '2026-09-07T08:00:00Z',
    ...over,
  }) as Task;

function renderList(task: Task) {
  vi.mocked(tasksApi.list).mockResolvedValue({ items: [task], total: 1, page: 1, pageSize: 20 } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/tasks']}>
        <Routes>
          <Route path="/tasks" element={<TaskListPage />} />
          <Route path="/tasks/new" element={<div />} />
          <Route path="/tasks/:id" element={<div />} />
          <Route path="/tasks/:id/edit" element={<div />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderDetail(task: Task) {
  vi.mocked(tasksApi.get).mockResolvedValue(task as never);
  vi.mocked(tasksApi.executions).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 } as never);
  vi.mocked(tasksApi.stats).mockResolvedValue({ recentExecutions: [], successRate: 0, avgDuration: 0, totalRuns: 0 } as never);
  vi.mocked(tasksApi.webhookStatus).mockResolvedValue({ enabled: false, url: '' } as never);
  vi.mocked(tasksApi.versions).mockResolvedValue([] as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/tasks/task-1']}>
        <Routes>
          <Route path="/tasks/:id" element={<TaskDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** A6b 复选框（可见名 = 标签 + 说明两段文本）。 */
const firePointCheckbox = () => screen.queryByRole('checkbox', { name: /消耗下一个 cron 计划点/ });

/**
 * 弹窗 footer 按钮：按 **DOM 位置**取，不按可访问名。
 *
 * 两个坑都踩过（写死名字即假红，与功能无关）：
 *   · antd `autoInsertSpace` 会在**两个汉字**之间插空格 ⇒ 实际是「触 发」/「取 消」；
 *   · 按钮带图标（`okButtonProps.icon`）时图标 `aria-label="thunderbolt"` 也进可访问名
 *     ⇒ 「thunderbolt 触 发」。
 * 而页面里另有「批量触发」「立即触发（行内图标按钮）」等含「触发」字样的按钮，
 * 用正则放宽会撞车 ⇒ 直接锚 `.ant-modal-footer` 的主/次按钮。
 */
const modalFooterButton = (kind: 'ok' | 'cancel'): HTMLElement | null => {
  const footer = document.querySelector('.ant-modal-footer');
  const sel = kind === 'ok' ? '.ant-btn-primary' : 'button:not(.ant-btn-primary)';
  return (footer?.querySelector(sel) as HTMLElement | null) ?? null;
};
const clickTriggerOk = () => fireEvent.click(modalFooterButton('ok')!);

beforeEach(() => {
  localStorage.clear();
  cleanup();
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  vi.mocked(tasksApi.trigger).mockResolvedValue({} as never);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('任务列表页：A6b 复选框', () => {
  it('① cron 任务勾选后提交 ⇒ trigger 收到 { consumeNextFirePoint: true }', async () => {
    renderList(makeTask());
    fireEvent.click((await screen.findAllByLabelText('立即执行'))[0]!);

    const box = await waitFor(() => {
      const el = firePointCheckbox();
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.click(box);
    clickTriggerOk();

    await waitFor(() => expect(vi.mocked(tasksApi.trigger)).toHaveBeenCalled());
    const [id, params, version, options] = vi.mocked(tasksApi.trigger).mock.calls[0]!;
    expect(id).toBe('task-1');
    expect(params).toBeUndefined();
    expect(version).toBeUndefined();
    expect(options).toEqual({ consumeNextFirePoint: true });
  });

  it('② cron 任务不勾选 ⇒ 不透传 true（body 级「无该键」见 api 用例）', async () => {
    renderList(makeTask());
    fireEvent.click((await screen.findAllByLabelText('立即执行'))[0]!);
    await waitFor(() => expect(firePointCheckbox()).toBeTruthy());
    clickTriggerOk();

    await waitFor(() => expect(vi.mocked(tasksApi.trigger)).toHaveBeenCalled());
    const [, , , options] = vi.mocked(tasksApi.trigger).mock.calls[0]!;
    expect(options).toEqual({ consumeNextFirePoint: false });
  });

  it('③ 非 cron 任务 ⇒ 弹窗不渲染该复选框（隐藏而非禁用）', async () => {
    renderList(makeTask({ triggerType: 'fixed_rate', cronExpression: undefined }));
    fireEvent.click((await screen.findAllByLabelText('立即执行'))[0]!);
    // 弹窗确实开了（运行时参数说明是弹窗内的既有内容），只是没有 A6b 复选框。
    expect(await screen.findByText('运行时参数（可选）')).toBeTruthy();
    expect(firePointCheckbox()).toBeNull();
  });

  it('勾选状态不跨弹窗残留：关掉再开 ⇒ 回到未勾选', async () => {
    renderList(makeTask());
    fireEvent.click((await screen.findAllByLabelText('立即执行'))[0]!);
    await waitFor(() => expect(firePointCheckbox()).toBeTruthy());
    fireEvent.click(firePointCheckbox()!);
    expect((firePointCheckbox() as HTMLInputElement).checked).toBe(true);

    fireEvent.click(modalFooterButton('cancel')!);
    fireEvent.click(screen.getAllByLabelText('立即执行')[0]!);
    await waitFor(() => expect(firePointCheckbox()).toBeTruthy());
    expect((firePointCheckbox() as HTMLInputElement).checked).toBe(false);
  });
});

describe('任务详情页：A6b 复选框', () => {
  it('① cron 任务勾选后提交 ⇒ trigger 收到 { consumeNextFirePoint: true }', async () => {
    renderDetail(makeTask());
    fireEvent.click(await screen.findByRole('button', { name: /立即触发/ }));

    const box = await waitFor(() => {
      const el = firePointCheckbox();
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.click(box);
    clickTriggerOk();

    await waitFor(() => expect(vi.mocked(tasksApi.trigger)).toHaveBeenCalled());
    const [id, , version, options] = vi.mocked(tasksApi.trigger).mock.calls[0]!;
    expect(id).toBe('task-1');
    expect(version).toBeUndefined();
    expect(options).toEqual({ consumeNextFirePoint: true });
  });

  it('② cron 任务不勾选 ⇒ 不透传 true', async () => {
    renderDetail(makeTask());
    fireEvent.click(await screen.findByRole('button', { name: /立即触发/ }));
    await waitFor(() => expect(firePointCheckbox()).toBeTruthy());
    clickTriggerOk();

    await waitFor(() => expect(vi.mocked(tasksApi.trigger)).toHaveBeenCalled());
    const [, , , options] = vi.mocked(tasksApi.trigger).mock.calls[0]!;
    expect(options).toEqual({ consumeNextFirePoint: false });
  });

  it('③ 非 cron 任务 ⇒ 弹窗不渲染该复选框（隐藏而非禁用）', async () => {
    renderDetail(makeTask({ triggerType: 'manual', cronExpression: undefined }));
    fireEvent.click(await screen.findByRole('button', { name: /立即触发/ }));
    expect(await screen.findByText('运行时参数（可选）')).toBeTruthy();
    expect(firePointCheckbox()).toBeNull();
  });
});
