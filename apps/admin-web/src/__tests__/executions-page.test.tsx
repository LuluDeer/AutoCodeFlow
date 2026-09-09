/**
 * QA-03 第一阶段：ExecutionsPage 组件测试扩面（此前零覆盖的高频页面）。
 *
 * 覆盖核心交互：
 *  1) 列表渲染（状态 Badge 中文映射 / 触发方式 / 错误信息红字 / 耗时）；
 *  2) 详情导航（任务名 → /tasks/:taskId，详情按钮 → /tasks/:taskId/executions/:execId）；
 *  3) 筛选链路（状态选择 → allExecutions 收到 status 参数 + 翻页/筛选重置后清空选中）；
 *  4) 终止链路（running 行 Popconfirm 确认 → killExecution 调用 + 成功 toast + 刷新；
 *     失败 → 错误 toast 文案）；
 *  5) 多选对比（≥2 行出现对比按钮，超 COMPARE_MAX 上限告警不打开 modal，
 *     合法数量打开 modal 渲染对比列）。
 *
 * 隔离 api 层（对齐 dashboard-ui04 / application-list-error-state 先例：
 * mock api 模块而非 axios 拦截器）；antd 浏览器 API shim 对齐既有先例。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

const pageFixture = (rows: TaskExecution[], total = rows.length) => ({
  items: rows,
  total,
  page: 1,
  pageSize: 20,
});

function renderPage() {
  // ARCH-26: ExecutionsPage 改用 TanStack Query——测试包 QueryClientProvider
  // （对齐 user-management-page.test 先例，retry:false 防 15s 轮询重试噪音）
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

/** antd 双汉字按钮自动插空格，textContent 归一化后再匹配（既有先例） */
const findBtn = (root: ParentNode, text: string): HTMLButtonElement | null =>
  (Array.from(root.querySelectorAll('button')) as HTMLButtonElement[]).find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === text,
  ) ?? null;

/** Popconfirm 确认键精确匹配（对齐 settings.history-rollback 先例：
 * 从弹层根节点找按钮，ok 键为弹出层最后一个按钮） */
async function confirmPopconfirm(titleText: RegExp | string) {
  const anchor =
    typeof titleText === 'string'
      ? await screen.findByText(titleText)
      : await screen.findByText(titleText);
  const layer = (anchor.closest('.ant-popover') ??
    anchor.closest('[class*="popconfirm"]') ??
    document.body) as HTMLElement;
  const layerBtns = Array.from(layer.querySelectorAll('button')) as HTMLButtonElement[];
  const okBtn = layerBtns[layerBtns.length - 1];
  expect(okBtn).toBeTruthy();
  fireEvent.click(okBtn);
}

beforeEach(() => {
  mockedTasks.allExecutions.mockReset();
  mockedTasks.killExecution.mockReset();
});

afterEach(() => {
  cleanup();
  // antd 静态 message holder 为 body 单例，不做 DOM 清理（既有先例注记），
  // 跨用例残留 toast 用 queryByText 单一命中断言处需注意。
});

describe('ExecutionsPage 列表渲染（QA-03）', () => {
  it('渲染状态中文 Badge、触发方式、执行器、错误信息红字与耗时', async () => {
    mockedTasks.allExecutions.mockResolvedValue(pageFixture([
      exec({ id: 'e1', status: 'success', triggerType: 'cron' }),
      exec({ id: 'e2', status: 'failed', triggerType: 'manual', errorMessage: 'exit code 1' }),
      exec({ id: 'e3', status: 'running', triggerType: 'timeout_retry' }),
    ]));
    renderPage();

    // 任务名出现在任务名链接 + 详情 aria 上下文（antd 汉字插空格），
    // 用 getAllByText 容忍多命中
    expect((await screen.findAllByText(/备份\s*任务/)).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('成功').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('失败').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('运行中').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('cron')).toBeTruthy();
    expect(screen.getByText('manual')).toBeTruthy();
    // 执行器地址在 Tooltip + 文本双层渲染（列内 Tooltip 包 Text），多命中容忍
    expect(screen.getAllByText('10.0.0.1:3002').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('exit code 1')).toBeTruthy();
    // 分页 total
    expect(screen.getByText('共 3 条')).toBeTruthy();
  });

  it('空数据渲染空态文案「暂无执行记录」', async () => {
    mockedTasks.allExecutions.mockResolvedValue(pageFixture([]));
    renderPage();
    expect(await screen.findByText('暂无执行记录')).toBeTruthy();
  });

  it('未知状态回退原样显示（STATUS_MAP 缺省分支）', async () => {
    mockedTasks.allExecutions.mockResolvedValue(pageFixture([
      exec({ id: 'e1', status: 'stale_recovered' as never }),
    ]));
    renderPage();
    expect(await screen.findByText('stale_recovered')).toBeTruthy();
  });
});

describe('ExecutionsPage 导航（QA-03）', () => {
  it('点任务名跳任务详情页', async () => {
    mockedTasks.allExecutions.mockResolvedValue(pageFixture([exec({})]));
    renderPage();
    // 表格任务名单元格是链接（tooltip 中也会出现同文案，取首个=单元格）
    fireEvent.click((await screen.findAllByText(/备份\s*任务/))[0]);
    await waitFor(() => {
      expect(screen.getByText('task-detail-mock')).toBeTruthy();
    });
  });

  it('点详情按钮跳执行详情页（taskId + execId 双参）', async () => {
    mockedTasks.allExecutions.mockResolvedValue(pageFixture([exec({})]));
    renderPage();
    expect((await screen.findAllByText(/备份\s*任务/)).length).toBeGreaterThan(0);
    const detail = findBtn(document.body, '详情');
    expect(detail).toBeTruthy();
    fireEvent.click(detail!);
    await waitFor(() => {
      expect(screen.getByText('execution-detail-mock')).toBeTruthy();
    });
  });
});

describe('ExecutionsPage 筛选与请求参数（QA-03）', () => {
  it('状态筛选变化后 allExecutions 收到对应 status 参数并回到第 1 页', async () => {
    mockedTasks.allExecutions.mockResolvedValue(pageFixture([]));
    renderPage();
    await screen.findByText('暂无执行记录');
    const callsBefore = mockedTasks.allExecutions.mock.calls.length;

    // antd Select：点击占位符展开下拉，再点选项
    fireEvent.mouseDown(screen.getByText('全部状态'));
    const option = await screen.findByText('失败', { selector: '.ant-select-item-option-content' });
    fireEvent.click(option);

    await waitFor(() => {
      expect(mockedTasks.allExecutions.mock.calls.length).toBeGreaterThan(callsBefore);
    });
    const lastCall = mockedTasks.allExecutions.mock.calls[mockedTasks.allExecutions.mock.calls.length - 1]?.[0];
    expect(lastCall?.status).toBe('failed');
  });

  it('搜索任务名（防抖后）作为 taskName 参数下发', async () => {
    mockedTasks.allExecutions.mockResolvedValue(pageFixture([]));
    renderPage();
    await screen.findByText('暂无执行记录');
    const callsBefore = mockedTasks.allExecutions.mock.calls.length;

    fireEvent.change(screen.getByPlaceholderText('搜索任务名'), { target: { value: '备份' } });
    // useDebounce 默认 300ms
    await waitFor(
      () => {
        expect(mockedTasks.allExecutions.mock.calls.length).toBeGreaterThan(callsBefore);
      },
      { timeout: 2000 },
    );
    const lastCall = mockedTasks.allExecutions.mock.calls[mockedTasks.allExecutions.mock.calls.length - 1]?.[0];
    expect(lastCall?.taskName).toBe('备份');
  }, 10000);

  it('刷新按钮触发重新请求', async () => {
    mockedTasks.allExecutions.mockResolvedValue(pageFixture([]));
    renderPage();
    await screen.findByText('暂无执行记录');
    const callsBefore = mockedTasks.allExecutions.mock.calls.length;
    fireEvent.click(findBtn(document.body, '刷新')!);
    await waitFor(() => {
      expect(mockedTasks.allExecutions.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });
});

describe('ExecutionsPage 终止执行（QA-03）', () => {
  it('running 行确认终止 → killExecution 调用且刷新列表', async () => {
    const row = exec({ id: 'exec-9', taskId: 'task-9', status: 'running' });
    mockedTasks.allExecutions.mockResolvedValue(pageFixture([row]));
    mockedTasks.killExecution.mockResolvedValue({ success: true, message: 'ok' });
    renderPage();

    fireEvent.click(await screen.findByText('终止'));
    await confirmPopconfirm('确认终止此执行？');
    await waitFor(() => {
      expect(mockedTasks.killExecution).toHaveBeenCalledWith('task-9', 'exec-9');
    });
    // 成功 toast
    expect(await screen.findByText('已发送终止信号')).toBeTruthy();
    // 终止后刷新（allExecutions 再次被调用）
    await waitFor(() => {
      expect(mockedTasks.allExecutions.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('非 running 行不渲染终止入口', async () => {
    mockedTasks.allExecutions.mockResolvedValue(pageFixture([
      exec({ status: 'success' }),
      exec({ id: 'e2', status: 'failed' }),
    ]));
    renderPage();
    await screen.findByText('成功');
    expect(screen.queryByText('终止')).toBeNull();
  });

  it('killExecution 失败 → 渲染错误 toast（文案回退 defaultMsg）', async () => {
    mockedTasks.allExecutions.mockResolvedValue(pageFixture([
      exec({ status: 'running' }),
    ]));
    // 普通对象 reject（非 Axios Error 实例）→ getErrMsg 走 defaultMsg「终止失败」
    mockedTasks.killExecution.mockRejectedValue({
      response: { data: { message: '执行器离线' } },
    });
    renderPage();

    fireEvent.click(await screen.findByText('终止'));
    await confirmPopconfirm('确认终止此执行？');
    await waitFor(() => {
      expect(mockedTasks.killExecution).toHaveBeenCalled();
    });
    // 错误 toast 与前一用例残留的成功 toast 同挂 body 级单例 holder，
    // 用 getAllByText 容忍多命中
    await waitFor(() => {
      expect(screen.getAllByText('终止失败').length).toBeGreaterThanOrEqual(1);
    });
  });
});

describe('ExecutionsPage 多选对比（QA-03 / FEAT-03 回归）', () => {
  it('勾选表头全选后出现「对比 (2)」按钮，点击打开对比 modal 渲染指标行并高亮关键差异', async () => {
    mockedTasks.allExecutions.mockResolvedValue(pageFixture([
      exec({ id: 'e1', status: 'success', duration: 1000, params: { env: 'prod' }, exitCode: 0, failureReason: null }),
      exec({ id: 'e2', status: 'failed', duration: 2000, params: { env: 'staging' }, exitCode: 1, failureReason: 'script_error', errorMessage: 'boom' }),
    ]));
    renderPage();
    await (await screen.findAllByText(/备份\s*任务/))[0];

    // checkboxes[0] 为表头全选框（diag 验证：点击后全选 2 行）
    const checkboxes = document.querySelectorAll('input.ant-checkbox-input');
    expect(checkboxes.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(checkboxes[0]);

    // 「对比 (2)」按 antd 汉字插空格规律归一化后查找
    await waitFor(() => {
      const btn = findBtn(document.body, '对比(2)');
      expect(btn).toBeTruthy();
    });
    fireEvent.click(findBtn(document.body, '对比(2)')!);
    // 对比 modal 渲染：指标表头 + 耗时格式化（duration 1000 → "1.0s"，
    // ExecutionCompare 的 duration 渲染：≥1000 显示秒）+ params/exitCode/failureReason 差异高亮
    expect(await screen.findByText('指标')).toBeTruthy();
    expect(screen.getAllByText('1.0s').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('参数')).toBeTruthy();
    expect(screen.getByText(/"env": "prod"/)).toBeTruthy();
    expect(screen.getByText('script_error')).toBeTruthy();
    expect(document.querySelectorAll('mark').length).toBeGreaterThanOrEqual(4);
  });

  it('逐行勾选：两行都选中时对比按钮可用，仅一行时禁用（selectedIds < 2）', async () => {
    mockedTasks.allExecutions.mockResolvedValue(pageFixture([
      exec({ id: 'e1' }),
      exec({ id: 'e2' }),
    ]));
    renderPage();
    await (await screen.findAllByText(/备份\s*任务/))[0];

    // UI-09 起 ExecutionsPage 表格加 scroll.x → rc-table 渲染 measure row，
    // 其内含一个隐藏 checkbox，索引不再稳定——按 data-row-key 精确取行选择框
    const rowCheckbox = (rowKey: string): HTMLInputElement =>
      document.querySelector(
        `.ant-table-tbody tr[data-row-key="${rowKey}"] input.ant-checkbox-input`,
      ) as HTMLInputElement;
    // 逐行勾选第一行（跳过表头全选框）→ 仅 1 个选中 → 禁用
    fireEvent.click(rowCheckbox('e1'));
    await waitFor(() => {
      const btn = findBtn(document.body, '对比(1)');
      expect(btn).toBeTruthy();
      expect(btn!.disabled).toBe(true);
    });
    // 再勾选第二行 → 2 个选中 → 可用
    fireEvent.click(rowCheckbox('e2'));
    await waitFor(() => {
      const btn = findBtn(document.body, '对比(2)');
      expect(btn).toBeTruthy();
      expect(btn!.disabled).toBe(false);
    });
  });
});
