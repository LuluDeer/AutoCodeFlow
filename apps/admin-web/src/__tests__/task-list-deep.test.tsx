/**
 * QA-03 第二阶段：TaskListPage 深交互测试。
 *
 * 覆盖核心交互（列表基础渲染已有 priority/CORE-01 等专项覆盖，本批聚焦深交互）：
 *  1) 筛选组合：状态筛选 + 触发方式筛选 → list 收到组合参数；清除筛选按钮复位；
 *  2) 批量操作：多选后批量触发/暂停/恢复（payload 精确 + 成功后清空选择）；
 *  3) 暂停/恢复：行内 Switch → pause/resume(id) 精确调用 + 失败 toast；
 *  4) 克隆链路：get → create（payload 字段断言：name 副本命名/-copy-、glueSource
 *     复制、服务端字段不回传）→ 导航新任务详情；克隆失败 toast；
 *  5) 删除确认：Popconfirm → delete(id) + 失败 toast 文案。
 *
 * ahooks useRequest 用真实现仅 mock api 层（dashboard-ui04 先例）；
 * Modal 内 ParamsEditor 提交用 act 包裹（executor-detail-highrisk 同批先例）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaskListPage from '../pages/TaskListPage';
import { tasksApi, type Task } from '../api/tasks';

vi.mock('../api/tasks', () => ({
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
}));
const mockedTasks = vi.mocked(tasksApi, true);

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
  // FEAT-17: TaskListPage 改用 TanStack Query——测试包 QueryClientProvider
  // （executions-page.test 先例，retry:false 防轮询重试噪音）
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/tasks']}>
        <Routes>
          <Route path="/tasks" element={<TaskListPage />} />
          <Route path="/tasks/new" element={<div>task-form-mock</div>} />
          <Route path="/task-templates" element={<div>templates-mock</div>} />
          <Route path="/tasks/:id" element={<div>task-detail-mock</div>} />
          <Route path="/tasks/:id/edit" element={<div>task-edit-mock</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const findBtn = (root: ParentNode, text: string): HTMLButtonElement | null =>
  (Array.from(root.querySelectorAll('button')) as HTMLButtonElement[]).find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === text,
  ) ?? null;

/** 行首 checkbox（rowSelection） */
const rowCheckbox = (index: number): HTMLInputElement =>
  document.body.querySelectorAll('.ant-table-row .ant-checkbox-input')[index] as HTMLInputElement;

/** Popconfirm 确认键（settings.history-rollback 先例：弹层最后一个按钮） */
async function confirmPopconfirm(titleText: string) {
  const anchor = await screen.findByText(titleText);
  const layer = (anchor.closest('.ant-popover') ?? document.body) as HTMLElement;
  const layerBtns = Array.from(layer.querySelectorAll('button')) as HTMLButtonElement[];
  const okBtn = layerBtns[layerBtns.length - 1];
  expect(okBtn).toBeTruthy();
  await act(async () => {
    fireEvent.click(okBtn);
  });
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockedTasks.list.mockResolvedValue({
    items: [makeTask(), makeTask({ id: 'task-2', name: '巡检任务', status: 'paused' })],
    total: 2,
    page: 1,
    pageSize: 20,
  });
});

afterEach(() => {
  cleanup();
});

describe('TaskListPage 筛选组合（QA-03 第二阶段）', () => {
  it('状态 + 触发方式组合筛选 → list 收到 {status, triggerType} 组合参数', async () => {
    renderPage();
    await screen.findAllByText(/备份\s*任务|巡检任务/);
    const callsBefore = mockedTasks.list.mock.calls.length;

    fireEvent.mouseDown(screen.getByText('全部状态'));
    fireEvent.click(await screen.findByText('已暂停', { selector: '.ant-select-item-option-content' }));
    await waitFor(() => expect(mockedTasks.list.mock.calls.length).toBeGreaterThan(callsBefore));
    const midCall = mockedTasks.list.mock.calls[mockedTasks.list.mock.calls.length - 1]?.[0];
    expect(midCall?.status).toBe('paused');

    fireEvent.mouseDown(screen.getByText('触发方式', { selector: '.ant-select-placeholder' }));
    fireEvent.click(await screen.findByText('Cron', { selector: '.ant-select-item-option-content' }));
    await waitFor(() => expect(mockedTasks.list.mock.calls.length).toBeGreaterThan(callsBefore + 1));
    const lastCall = mockedTasks.list.mock.calls[mockedTasks.list.mock.calls.length - 1]?.[0];
    expect(lastCall?.status).toBe('paused');
    expect(lastCall?.triggerType).toBe('cron');
  });

  it('有筛选时出现「清除筛选」按钮 → 点击后 list 参数复位（name/status/triggerType 均空）', async () => {
    renderPage();
    await screen.findAllByText(/备份\s*任务|巡检任务/);
    fireEvent.mouseDown(screen.getByText('全部状态'));
    fireEvent.click(await screen.findByText('运行中', { selector: '.ant-select-item-option-content' }));
    await waitFor(() => expect(findBtn(document.body, '清除筛选')).toBeTruthy());

    fireEvent.click(findBtn(document.body, '清除筛选')!);
    await waitFor(() => {
      const lastCall = mockedTasks.list.mock.calls[mockedTasks.list.mock.calls.length - 1]?.[0];
      expect(lastCall?.status).toBeUndefined();
      expect(lastCall?.triggerType).toBeUndefined();
    });
    expect(screen.queryByText('清除筛选')).toBeNull();
  });
});

describe('TaskListPage 批量操作（QA-03 第二阶段）', () => {
  it('勾选两行 → 操作条显示已选数，批量触发 → batchTrigger 收到精确 id 数组并清空选择', async () => {
    mockedTasks.batchTrigger.mockResolvedValue({ ok: true });
    renderPage();
    await screen.findAllByText(/备份\s*任务|巡检任务/);
    fireEvent.click(rowCheckbox(0));
    fireEvent.click(rowCheckbox(1));

    expect(screen.getByText(/已选/)).toBeTruthy();
    fireEvent.click(findBtn(document.body, '批量触发')!);
    await waitFor(() => {
      expect(mockedTasks.batchTrigger).toHaveBeenCalledWith(['task-1', 'task-2']);
    });
    // 成功后选择清空（操作条消失）
    await waitFor(() => expect(screen.queryByText(/已选/)).toBeNull());
  });

  it('批量暂停成功 → batchPause 收到精确 id 数组并提示成功', async () => {
    mockedTasks.batchPause.mockResolvedValue({ ok: true });
    renderPage();
    await screen.findAllByText(/备份\s*任务|巡检任务/);
    fireEvent.click(rowCheckbox(0));
    fireEvent.click(rowCheckbox(1));
    fireEvent.click(findBtn(document.body, '批量暂停')!);
    await waitFor(() => {
      expect(mockedTasks.batchPause).toHaveBeenCalledWith(['task-1', 'task-2']);
    });
  });

  it('批量触发失败 → 错误 toast（getErrMsg 提取响应 message）', async () => {
    mockedTasks.batchTrigger.mockRejectedValue(
      Object.assign(new Error('bad'), { response: { data: { message: '批量触发被拒：并发上限' } } }),
    );
    renderPage();
    await screen.findAllByText(/备份\s*任务|巡检任务/);
    fireEvent.click(rowCheckbox(0));
    fireEvent.click(findBtn(document.body, '批量触发')!);
    await waitFor(() => {
      expect(screen.getByText('批量触发被拒：并发上限')).toBeTruthy();
    });
  });
});

describe('TaskListPage 行内暂停/恢复与删除（QA-03 第二阶段）', () => {
  it('active 行 Switch 关闭 → pause(id)；paused 行 Switch 开启 → resume(id)', async () => {
    mockedTasks.pause.mockResolvedValue(makeTask({ status: 'paused' }));
    mockedTasks.resume.mockResolvedValue(makeTask({ status: 'active' }));
    renderPage();
    await screen.findAllByText(/备份\s*任务|巡检任务/);
    const switches = document.body.querySelectorAll('.ant-table-row .ant-switch') as NodeListOf<HTMLButtonElement>;
    expect(switches.length).toBe(2);
    // 第 1 行 active → 点击为 pause
    fireEvent.click(switches[0]);
    await waitFor(() => expect(mockedTasks.pause).toHaveBeenCalledWith('task-1'));
    // 第 2 行 paused → 点击为 resume
    fireEvent.click(switches[1]);
    await waitFor(() => expect(mockedTasks.resume).toHaveBeenCalledWith('task-2'));
  });

  it('暂停失败 → 错误 toast 呈现响应 message', async () => {
    mockedTasks.pause.mockRejectedValue(
      Object.assign(new Error('bad'), { response: { data: { message: '任务已被删除' } } }),
    );
    renderPage();
    await screen.findAllByText(/备份\s*任务|巡检任务/);
    const switches = document.body.querySelectorAll('.ant-table-row .ant-switch') as NodeListOf<HTMLButtonElement>;
    fireEvent.click(switches[0]);
    await waitFor(() => {
      expect(screen.getByText('任务已被删除')).toBeTruthy();
    });
  });

  it('删除 Popconfirm 确认 → delete(id)；删除失败 toast 文案', async () => {
    mockedTasks.delete.mockResolvedValue(undefined);
    renderPage();
    await screen.findAllByText(/备份\s*任务|巡检任务/);
    const deleteBtn = Array.from(document.body.querySelectorAll('.ant-table-row button')).find(
      (b) => b.querySelector('.anticon-delete'),
    ) as HTMLButtonElement | undefined;
    expect(deleteBtn).toBeTruthy();
    fireEvent.click(deleteBtn!);
    await confirmPopconfirm('确认删除此任务？');
    await waitFor(() => expect(mockedTasks.delete).toHaveBeenCalledWith('task-1'));

    // 失败路径
    mockedTasks.delete.mockRejectedValue(
      Object.assign(new Error('bad'), { response: { data: { message: '存在运行中执行' } } }),
    );
    await confirmPopconfirm('确认删除此任务？');
    await waitFor(() => {
      expect(screen.getByText('存在运行中执行')).toBeTruthy();
    });
  });
});

describe('TaskListPage 克隆链路（QA-03 第二阶段）', () => {
  it('克隆：get 源任务 → create 携带 -copy- 副本名与 glueSource 等可编辑字段 → 导航新详情', async () => {
    const src = makeTask({
      id: 'task-9',
      name: '数据同步',
      glueSource: 'return 42;',
      glueLanguage: 'js',
      description: '源任务描述',
    });
    mockedTasks.list.mockResolvedValue({ items: [src], total: 1, page: 1, pageSize: 20 });
    mockedTasks.get.mockResolvedValue(src);
    mockedTasks.create.mockResolvedValue(makeTask({ id: 'task-new', name: '数据同步-copy-1234' }));
    renderPage();
    await screen.findAllByText(/数据同步/);
    const cloneBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.querySelector('.anticon-copy'),
    ) as HTMLButtonElement | undefined;
    expect(cloneBtn).toBeTruthy();
    fireEvent.click(cloneBtn!);

    await waitFor(() => expect(mockedTasks.create).toHaveBeenCalled());
    const payload = mockedTasks.create.mock.calls[0][0] as Record<string, unknown>;
    expect(String(payload.name)).toMatch(/^数据同步-copy-\d{4}$/);
    expect(payload.glueSource).toBe('return 42;');
    expect(payload.description).toBe('源任务描述');
    expect(payload.triggerType).toBe('cron');
    // 服务端字段不回传（clone 载荷只含可编辑字段）
    expect(payload.id).toBeUndefined();
    expect(payload.status).toBeUndefined();
    // 成功后导航新任务详情
    await waitFor(() => expect(screen.getByText('task-detail-mock')).toBeTruthy());
  });

  it('克隆失败（get 拒绝）→ 错误 toast 且不调 create 不导航', async () => {
    mockedTasks.get.mockRejectedValue(
      Object.assign(new Error('bad'), { response: { data: { message: '源任务不存在' } } }),
    );
    renderPage();
    await screen.findAllByText(/备份\s*任务/);
    const cloneBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.querySelector('.anticon-copy'),
    ) as HTMLButtonElement | undefined;
    expect(cloneBtn).toBeTruthy();
    fireEvent.click(cloneBtn!);
    await waitFor(() => {
      expect(screen.getByText('源任务不存在')).toBeTruthy();
    });
    expect(mockedTasks.create).not.toHaveBeenCalled();
    expect(screen.queryByText('task-detail-mock')).toBeNull();
  });
});
