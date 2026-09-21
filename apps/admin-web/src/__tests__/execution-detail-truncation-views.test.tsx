/**
 * P1-25（UX-AUDIT-2026-09-21）回归：截断告警必须描述**当前正在显示的那份日志**。
 *
 * 旧实现有两条互相叠加的静默截断路径：
 *   1. `fetchAllLogLines` 明明返回 `{ lines, truncated }`，级别过滤分支只解构
 *      `lines`、**丢弃 `truncated`**；
 *   2. 截断告警被硬门控在 `filteredLogs === null && fullLogs === null &&
 *      MARKER.test(rawLogs)`——**恰好在过滤视图被截断时它被抑制**。
 *
 * 于是用户按级别过滤后读到一份"看起来完整、实则缺尾部"的日志，而堆栈与致命
 * 错误行就在尾部——这正是"任务失败找不到原因"的现场。同理，"加载完整日志"
 * 触顶 2 万行时只弹一次瞬时 toast，fullLogs 一替换视图，持久告警反而消失。
 *
 * 本套件钉死修复后的三条语义：
 *   A. 过滤视图拉取触顶 → 过滤视图下持续显示「日志已截断」；
 *   B. 切回「全部级别」→ 截断标志随视图重置，告警消失（不能误报）；
 *   C. 「加载完整日志」触顶 → 告警**持续存在**（旧实现会把它藏掉）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { tasksApi } from '../api/tasks';
import ExecutionDetailPage from '../pages/ExecutionDetailPage';

vi.mock('../api/tasks', () => ({
  tasksApi: {
    execution: vi.fn(),
    executionLogs: vi.fn(),
    killExecution: vi.fn(),
    trigger: vi.fn(),
    analyzeExecution: vi.fn(),
    get: vi.fn(),
    executions: vi.fn(),
  },
}));

// jsdom 缺失 antd 依赖的浏览器 API（对齐既有 execution-detail-* 先例）。
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

const TRUNCATED_LOGS = [
  'line-1',
  'line-2',
  '...[truncated, total 50000 chars]...',
  'tail-line',
].join('\n');

function mockExecution(logs: string) {
  vi.mocked(tasksApi.execution).mockReset().mockResolvedValue({
    id: 'e1',
    taskId: 't1',
    taskName: 'nightly',
    status: 'failed',
    triggerType: 'manual',
    logs,
    createdAt: new Date().toISOString(),
  } as never);
  vi.mocked(tasksApi.get).mockReset().mockResolvedValue({
    id: 't1', maxRetry: 3, retryDelay: 5,
  } as never);
  vi.mocked(tasksApi.executions).mockReset().mockResolvedValue({
    items: [{ id: 'e1', retryCount: 0, status: 'failed' }], total: 1, page: 1, pageSize: 100,
  } as never);
}

/**
 * 模拟"过滤后/全量日志远超 2 万行上限"：每页 2000 行且永远 hasMore，
 * fetchAllLogLines 在第 10 页收满 20_000 行后触顶停拉（truncated=true）。
 * 行内容刻意用无级别词的纯文本，避免生成 2 万个高亮节点拖慢 jsdom。
 */
function mockLogsOverCap() {
  vi.mocked(tasksApi.executionLogs).mockImplementation(async () =>
    ({
      lines: Array.from({ length: 2000 }, (_, i) => `plain-${i}`),
      totalLines: 999_999,
      hasMore: true,
    }) as never,
  );
}

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/tasks/t1/executions/e1']}>
        <Routes>
          <Route path="/tasks/:taskId/executions/:execId" element={<ExecutionDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function getLevelSelect(): HTMLElement {
  const select = document.querySelector<HTMLElement>('.ant-select');
  if (!select) throw new Error('级别过滤 Select 未渲染');
  return select;
}

async function openLevelDropdown(): Promise<HTMLElement[]> {
  fireEvent.mouseDown(getLevelSelect());
  return vi.waitFor(() => {
    const opts = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')];
    expect(opts.length).toBe(5);
    return opts;
  });
}

async function clickLevelOption(label: string) {
  const options = await openLevelDropdown();
  const target = options.find((o) => o.textContent === label);
  if (!target) throw new Error(`未找到选项 ${label}`);
  fireEvent.click(target);
}

beforeEach(() => {
  vi.mocked(tasksApi.executionLogs).mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('P1-25: 截断告警按当前视图判定（过滤/完整视图都不得静默）', () => {
  it('A. 级别过滤拉取触顶 2 万行 → 过滤视图下持续显示「日志已截断」（旧实现此视图必被抑制）', async () => {
    mockExecution('line-1\nline-2');
    mockLogsOverCap();
    renderPage();
    await screen.findByText(/line-1/);
    // 原始载荷无截断标记 → 初始无告警
    expect(screen.queryByText(/日志已截断/)).toBeNull();

    await clickLevelOption('ERROR');

    // 过滤视图拉取触顶：告警必须出现（旧判据 filteredLogs===null 恒为 false → 永不出现）
    expect(await screen.findByText(/日志已截断/)).toBeTruthy();
    // 确实走了分页拉取且带 level 参数
    expect(vi.mocked(tasksApi.executionLogs)).toHaveBeenCalledWith(
      't1', 'e1', expect.objectContaining({ level: 'ERROR' }),
    );
  });

  it('B. 切回「全部级别」→ 截断标志随过滤视图重置，告警消失（不能把别的视图的截断挂在眼前）', async () => {
    mockExecution('line-1\nline-2');
    mockLogsOverCap();
    renderPage();
    await screen.findByText(/line-1/);

    await clickLevelOption('ERROR');
    expect(await screen.findByText(/日志已截断/)).toBeTruthy();

    await clickLevelOption('全部级别');
    // 回到原始载荷视图（无标记）→ 告警必须消失
    await vi.waitFor(() => expect(screen.queryByText(/日志已截断/)).toBeNull());
  });

  it('C. 「加载完整日志」触顶 2 万行 → 告警持续存在（旧实现被 fullLogs 替换后反而藏掉告警）', async () => {
    mockExecution(TRUNCATED_LOGS);
    mockLogsOverCap();
    renderPage();
    // 原始载荷带截断标记 → 出现告警与"加载完整日志"按钮
    const loadBtn = await screen.findByRole('button', { name: /加载完整日志/ });
    expect(screen.getAllByText(/日志已截断/).length).toBeGreaterThan(0);

    fireEvent.click(loadBtn);

    // 拉到 2 万行触顶停拉后：内容已被 fullLogs 替换，但告警必须仍在
    await vi.waitFor(() => {
      const pre = document.querySelector('pre');
      expect(pre?.textContent).toContain('plain-0');
    });
    expect(screen.getAllByText(/日志已截断/).length).toBeGreaterThan(0);
  });
});
