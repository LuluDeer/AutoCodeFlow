/**
 * OBS-03 前端半场回归：执行详情日志级别过滤与错误高亮。
 *
 * 后端契约（apps/admin-api/src/modules/task/task.controller.ts，
 * GET /tasks/:id/executions/:execId/logs）：level ∈ ERROR/WARN/INFO/DEBUG，
 * 过滤模式下 fromLine 为过滤后序列偏移、totalLines 为过滤后计数，
 * hasMore = fromLine + lines.length < totalLines。
 *
 * 覆盖点：
 * 1. 日志区工具行渲染级别过滤 Select（默认"全部级别"，不带 level、行为不变）；
 * 2. 选择 ERROR 后请求带 level 参数，分页循环沿用 fromLine += lines.length
 *    的既有契约（过滤后偏移），视图替换为过滤结果；
 * 3. 切回"全部级别"不发请求、恢复原始日志视图；
 * 4. ERROR/WARN 行级高亮类应用（纯 CSS 类按行前缀判定），纯文本行不包裹，
 *    分段渲染与原文逐字符保真（复制/下载内容不受影响）；
 * 5. 复制/下载反映当前过滤视图（取舍：反映"当前视图"，所见即所得）；
 * 6. utils/logLevel.ts 与后端 log-level.util.ts 推断口径一致。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { tasksApi } from '../api/tasks';
import ExecutionDetailPage from '../pages/ExecutionDetailPage';
import { levelOfLine, logLineHighlightClass } from '../utils/logLevel';

// 隔离 api 层：只关心 execution / executionLogs 两个调用契约。
// CORE-02: 详情页新增消费 get（任务元数据 maxRetry/retryDelay）与
// executionsWithStatus（重试链）——mock 需补齐，缺省会抛 TypeError。
vi.mock('../api/tasks', () => ({
  tasksApi: {
    execution: vi.fn(),
    executionLogs: vi.fn(),
    killExecution: vi.fn(),
    trigger: vi.fn(),
    analyzeExecution: vi.fn(),
    get: vi.fn(),
    executionsWithStatus: vi.fn(),
  },
}));

// jsdom 缺失 antd 依赖的浏览器 API（对齐 execution-detail-truncated-logs.test 先例）。
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

const LOGS = [
  '2026-09-06 10:00:00 [INFO] start',
  '2026-09-06 10:00:01 [ERROR] boom',
  '2026-09-06 10:00:02 [WARN] careful here',
  'plain line',
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
  // CORE-02: 详情页新增消费——任务元数据与重试链拉取（本套件不关注，
  // mock 空实现即可；executionsWithStatus 返回仅当前行的"无重试链"页）。
  vi.mocked(tasksApi.get).mockReset().mockResolvedValue({
    id: 't1', maxRetry: 3, retryDelay: 5,
  } as never);
  vi.mocked(tasksApi.executionsWithStatus).mockReset().mockResolvedValue({
    items: [{ id: 'e1', retryCount: 0, status: 'failed' }], total: 1, page: 1, pageSize: 100,
  } as never);
}

/** 页面上唯一的级别过滤 Select（antd v6：值显示在 .ant-select-content） */
function getLevelSelect(): HTMLElement {
  const select = document.querySelector<HTMLElement>('.ant-select');
  if (!select) throw new Error('级别过滤 Select 未渲染');
  return select;
}

/**
 * 打开日志区工具行上的级别过滤下拉。
 * 注意：antd v6（@rc-component/select）虚拟列表下可见选项不带 role="option"
 * （仅隐藏 a11y 镜像列表有），故按 .ant-select-item-option 类名定位。
 */
async function openLevelDropdown(): Promise<HTMLElement[]> {
  fireEvent.mouseDown(getLevelSelect());
  return vi.waitFor(() => {
    const opts = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')];
    expect(opts.length).toBe(5);
    return opts;
  });
}

/** 点击下拉中指定文案的选项 */
async function clickLevelOption(label: string) {
  const options = await openLevelDropdown();
  const target = options.find((o) => o.textContent === label);
  if (!target) throw new Error(`未找到选项 ${label}，实际: ${options.map((o) => o.textContent).join('|')}`);
  fireEvent.click(target);
}

function getPre(): HTMLPreElement {
  const pre = document.querySelector('pre');
  if (!pre) throw new Error('日志 pre 未渲染');
  return pre;
}

beforeEach(() => {
  vi.mocked(tasksApi.executionLogs).mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ExecutionDetailPage 日志级别过滤（OBS-03）', () => {
  it('工具行渲染级别过滤下拉，默认"全部级别"', async () => {
    mockExecution(LOGS);
    render(
      <MemoryRouter initialEntries={['/tasks/t1/executions/e1']}>
        <Routes>
          <Route path="/tasks/:taskId/executions/:execId" element={<ExecutionDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText(/plain line/);
    const select = getLevelSelect();
    expect(select).toBeTruthy();
    // antd v6 单选值显示在 .ant-select-content（title 属性同步 label）
    expect(select.querySelector('.ant-select-content')?.textContent).toBe('全部级别');
    // 展开可见全部值域：全部 + ERROR/WARN/INFO/DEBUG
    const options = await openLevelDropdown();
    expect(options.map((o) => o.textContent)).toEqual(['全部级别', 'ERROR', 'WARN', 'INFO', 'DEBUG']);
  });

  it('"全部级别"不发请求：初始渲染不调用分页端点', async () => {
    mockExecution(LOGS);
    render(
      <MemoryRouter initialEntries={['/tasks/t1/executions/e1']}>
        <Routes>
          <Route path="/tasks/:taskId/executions/:execId" element={<ExecutionDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText(/plain line/);
    expect(tasksApi.executionLogs).not.toHaveBeenCalled();
  });

  it('选择 ERROR：请求带 level 参数，过滤模式下 fromLine 按过滤后偏移推进', async () => {
    mockExecution(LOGS);
    vi.mocked(tasksApi.executionLogs)
      .mockResolvedValueOnce({ lines: ['2026-09-06 10:00:01 [ERROR] boom-a', 'err-2'], totalLines: 3, hasMore: true } as never)
      .mockResolvedValueOnce({ lines: ['err-3'], totalLines: 3, hasMore: false } as never);
    render(
      <MemoryRouter initialEntries={['/tasks/t1/executions/e1']}>
        <Routes>
          <Route path="/tasks/:taskId/executions/:execId" element={<ExecutionDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText(/plain line/);
    await clickLevelOption('ERROR');

    await vi.waitFor(() => {
      expect(getPre().textContent).toBe('2026-09-06 10:00:01 [ERROR] boom-a\nerr-2\nerr-3');
    });
    // 请求契约：level=ERROR；过滤模式下 fromLine 为过滤后偏移（+= lines.length）
    expect(tasksApi.executionLogs).toHaveBeenNthCalledWith(1, 't1', 'e1', { fromLine: 0, limit: 2000, level: 'ERROR' });
    expect(tasksApi.executionLogs).toHaveBeenNthCalledWith(2, 't1', 'e1', { fromLine: 2, limit: 2000, level: 'ERROR' });
  });

  it('切回"全部级别"：不发请求，恢复原始日志视图', async () => {
    mockExecution(LOGS);
    vi.mocked(tasksApi.executionLogs).mockResolvedValue({ lines: ['only-error'], totalLines: 1, hasMore: false } as never);
    render(
      <MemoryRouter initialEntries={['/tasks/t1/executions/e1']}>
        <Routes>
          <Route path="/tasks/:taskId/executions/:execId" element={<ExecutionDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText(/plain line/);
    await clickLevelOption('ERROR');
    await vi.waitFor(() => expect(getPre().textContent).toBe('only-error'));

    await clickLevelOption('全部级别');
    await vi.waitFor(() => expect(getPre().textContent).toBe(LOGS));
    // "全部"不带 level、不再发请求（选择 ERROR 时仅 1 次调用）
    expect(tasksApi.executionLogs).toHaveBeenCalledTimes(1);
  });

  it('复制/下载反映当前过滤视图（选择 ERROR 后复制与下载均为过滤结果）', async () => {
    mockExecution(LOGS);
    vi.mocked(tasksApi.executionLogs).mockResolvedValue({ lines: ['err-only-1', 'err-only-2'], totalLines: 2, hasMore: false } as never);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    render(
      <MemoryRouter initialEntries={['/tasks/t1/executions/e1']}>
        <Routes>
          <Route path="/tasks/:taskId/executions/:execId" element={<ExecutionDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText(/plain line/);
    await clickLevelOption('ERROR');
    await vi.waitFor(() => expect(getPre().textContent).toBe('err-only-1\nerr-only-2'));

    // 复制 = 当前过滤视图
    fireEvent.click(screen.getByRole('button', { name: /复制/ }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('err-only-1\nerr-only-2'));

    // 下载 = 当前过滤视图
    fireEvent.click(screen.getByRole('button', { name: /下载/ }));
    await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(await blob.text()).toBe('err-only-1\nerr-only-2');
    expect(revokeObjectURL).toHaveBeenCalled();
  });
});

describe('ExecutionDetailPage 日志行级高亮（OBS-03）', () => {
  it('ERROR 行红色、WARN 行黄色高亮，纯文本行不包裹', async () => {
    mockExecution(LOGS);
    render(
      <MemoryRouter initialEntries={['/tasks/t1/executions/e1']}>
        <Routes>
          <Route path="/tasks/:taskId/executions/:execId" element={<ExecutionDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText(/plain line/);

    const errSpan = document.querySelector('span.log-line-error');
    const warnSpan = document.querySelector('span.log-line-warn');
    expect(errSpan?.textContent).toBe('2026-09-06 10:00:01 [ERROR] boom\n');
    expect(warnSpan?.textContent).toBe('2026-09-06 10:00:02 [WARN] careful here\n');
    // 非高亮行不包裹高亮类
    expect(document.querySelectorAll('span.log-line-error').length).toBe(1);
    expect(document.querySelectorAll('span.log-line-warn').length).toBe(1);
    expect(getPre().textContent).not.toContain('span');
  });

  it('分段渲染保真：pre 文本与原始日志逐字符一致（复制/下载不受影响）', async () => {
    const tricky = [
      '',
      '2026-09-06T10:00:00.123Z error x',
      '[WARN] w1',
      '',
      'tail',
      '',
    ].join('\n');
    mockExecution(tricky);
    render(
      <MemoryRouter initialEntries={['/tasks/t1/executions/e1']}>
        <Routes>
          <Route path="/tasks/:taskId/executions/:execId" element={<ExecutionDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText(/tail/);
    expect(getPre().textContent).toBe(tricky);
  });
});

describe('logLevel 推断与后端 log-level.util.ts 口径一致（OBS-03）', () => {
  it('行首直接标注与时间戳前缀后标注均可识别，WARNING 折叠为 WARN', () => {
    expect(levelOfLine('[ERROR] msg')).toBe('ERROR');
    expect(levelOfLine('ERROR: msg')).toBe('ERROR');
    expect(levelOfLine('error msg')).toBe('ERROR');
    expect(levelOfLine('2026-09-06 12:00:00 [WARN] x')).toBe('WARN');
    expect(levelOfLine('2026-09-06T12:00:00.123Z error ...')).toBe('ERROR');
    expect(levelOfLine('[2026/09/06 12:00:00] [INFO] x')).toBe('INFO');
    expect(levelOfLine('12:00:00,123 debug ...')).toBe('DEBUG');
    expect(levelOfLine('WARNING: x')).toBe('WARN');
  });

  it('行中间级别词、非级别词、空行推断不到', () => {
    expect(levelOfLine('the error was handled')).toBeNull();
    expect(levelOfLine('ERRORS galore')).toBeNull();
    expect(levelOfLine('information overload')).toBeNull();
    expect(levelOfLine('debugger attached')).toBeNull();
    expect(levelOfLine('')).toBeNull();
    expect(levelOfLine(null)).toBeNull();
  });

  it('logLineHighlightClass 映射：ERROR→log-line-error，WARN→log-line-warn，其余为空', () => {
    expect(logLineHighlightClass('[ERROR] x')).toBe('log-line-error');
    expect(logLineHighlightClass('WARNING: y')).toBe('log-line-warn');
    expect(logLineHighlightClass('[INFO] ok')).toBe('');
    expect(logLineHighlightClass('debug z')).toBe('');
    expect(logLineHighlightClass('plain')).toBe('');
  });
});
