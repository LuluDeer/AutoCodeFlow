/**
 * UI-05 回归：执行详情页信息架构（Tab 化 + 日志查看器升级 + 失败定位卡片）。
 *
 * 覆盖点（对应开发计划 §6.2 UI-05 验收）：
 * 1. Tab 化：默认 Tab=执行日志；四个 Tab（日志/时间线·报告/重试链/参数与产物）
 *    可切换；?tab= searchParams 记忆（初始渲染读参、切换写参 replace）。
 * 2. 失败定位卡片：failed/timeout 时日志 Tab 顶部渲染——failureReason 映射
 *    建议动作（BUG-10 十二类）、任务 runbook 有值时展示、「AI 分析」跳时间线
 *    Tab；success 时不渲染。
 * 3. 搜索高亮：输入关键词（防抖 300ms）后命中片段 mark.log-search-hit，
 *    pre 文本拼接保真；未命中显示提示。
 * 4. 参数与产物 Tab：params Tag 展示 + ArtifactsList 渲染（mock api 层）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { tasksApi } from '../api/tasks';
import { artifactsApi } from '../api/artifacts';
import ExecutionDetailPage from '../pages/ExecutionDetailPage';
import { failureRunbookAction, FAILURE_RUNBOOK_ACTIONS } from '../pages/failure-runbook';
import { buildLogSearchSegments, splitLineByKeyword } from '../utils/log-search';

// 隔离 api 层（对齐既有 execution-detail-* 测试先例）。
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

vi.mock('../api/artifacts', () => ({
  artifactsApi: {
    listArtifacts: vi.fn(),
    downloadArtifact: vi.fn(),
  },
}));

vi.mock('../api/execution-reports', () => ({
  executionReportsApi: {
    report: vi.fn().mockResolvedValue({ execution: {}, timeline: [], report: null }),
  },
}));

// jsdom 缺失 antd 依赖的浏览器 API（对齐既有测试先例）。
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

const LOGS = ['line-1', 'line-2 with keyword', 'plain'].join('\n');

/** 捕获当前 URL（?tab= 断言用） */
function LocationProbe() {
  const loc = useLocation();
  return <span data-testid="loc-probe">{loc.search}</span>;
}

function mockExecution(overrides: Record<string, unknown> = {}) {
  vi.mocked(tasksApi.execution).mockReset().mockResolvedValue({
    id: 'e1',
    taskId: 't1',
    taskName: 'nightly',
    status: 'failed',
    triggerType: 'manual',
    logs: LOGS,
    failureReason: 'script_error',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as never);
  vi.mocked(tasksApi.get).mockReset().mockResolvedValue({
    id: 't1', maxRetry: 3, retryDelay: 5, params: { region: 'cn-north', shards: 4 },
  } as never);
  vi.mocked(tasksApi.executionsWithStatus).mockReset().mockResolvedValue({
    items: [{ id: 'e1', retryCount: 0, status: 'failed' }], total: 1, page: 1, pageSize: 100,
  } as never);
  vi.mocked(tasksApi.executionLogs).mockReset();
}

function renderPage(initialSearch = '') {
  // FEAT-17: ExecutionDetailPage 改用 TanStack Query——测试包 QueryClientProvider
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/tasks/t1/executions/e1${initialSearch}`]}>
        <LocationProbe />
        <Routes>
          <Route path="/tasks/:taskId/executions/:execId" element={<ExecutionDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function getPre(): HTMLElement {
  const pre = document.querySelector<HTMLElement>('pre[data-testid="log-pre"]');
  if (!pre) throw new Error('日志 pre 未渲染');
  return pre;
}

beforeEach(() => {
  mockExecution();
  vi.mocked(artifactsApi.listArtifacts).mockReset().mockResolvedValue([
    { name: 'report.txt', size: 2048, sha256: 'a'.repeat(64) },
  ]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('UI-05: Tab 化信息架构', () => {
  it('默认 Tab=执行日志：日志 pre 渲染、时间线面板不在初始视图', async () => {
    renderPage();
    await screen.findByText(/line-2 with keyword/);
    expect(getPre()).toBeTruthy();
    // ExecutionReportPanel 的 data-testid 不在 DOM（未激活 Tab 不挂载内容）
    expect(screen.queryByTestId('execution-report-panel')).toBeNull();
    expect(screen.getByTestId('loc-probe').textContent).toBe('');
  });

  it('切换到时间线·报告 Tab：ExecutionReportPanel 挂载，AI 分析卡随迁', async () => {
    renderPage();
    await screen.findByText(/line-2 with keyword/);
    fireEvent.click(screen.getByTestId('tab-label-report'));
    await vi.waitFor(() => expect(screen.getByTestId('execution-report-panel')).toBeTruthy());
    expect(screen.getByTestId('loc-probe').textContent).toContain('tab=report');
  });

  it('?tab=report 初始直达：刷新/分享链接回到原 Tab（searchParams 记忆）', async () => {
    renderPage('?tab=report');
    await vi.waitFor(() => expect(screen.getByTestId('execution-report-panel')).toBeTruthy());
    // 初始视图没有日志 pre（日志 Tab 未激活）
    expect(screen.queryByTestId('log-pre')).toBeNull();
  });

  it('?tab=retry 初始直达：重试链 Tab 渲染（复用既有 mock 单行链）', async () => {
    renderPage('?tab=retry');
    // 既有 mock 的 executionsWithStatus 返回单行链（retryCount=0）→ 渲染链路而非空占位
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('重试链路');
    });
    expect(document.body.textContent).toContain('Attempt #0');
    expect(document.body.textContent).toContain('重试预算：Attempt #1 of 4');
    expect(screen.queryByTestId('log-pre')).toBeNull();
  });

  it('切到参数与产物 Tab：params Tag 渲染 + ArtifactsList 渲染产物', async () => {
    renderPage('?tab=context');
    await screen.findByText(/region = cn-north/);
    expect(screen.getByText(/shards = 4/)).toBeTruthy();
    // ArtifactsList（003 组件）自取数渲染
    await vi.waitFor(() => expect(screen.getByText('report.txt')).toBeTruthy());
    expect(screen.getByText(/产物（1）/)).toBeTruthy();
  });
});

describe('UI-05: 失败定位卡片', () => {
  it('failed 执行：日志 Tab 顶部渲染定位卡——分类映射建议动作 + runbook + AI 跳转', async () => {
    mockExecution({ runbook: undefined });
    vi.mocked(tasksApi.get).mockResolvedValue({
      id: 't1', maxRetry: 3, retryDelay: 5, runbook: '# 排障手册\n1. 查看日志尾部',
    } as never);
    renderPage();
    const card = await screen.findByTestId('failure-triage-card');
    // script_error → 建议动作（failure-runbook.ts 中文映射）
    expect(card.textContent).toContain('阅读日志末尾首个堆栈帧附近');
    // runbook 有值时展示（pre-wrap 文本）
    expect(screen.getByTestId('failure-runbook').textContent).toContain('# 排障手册');
    // 「AI 分析」跳时间线 Tab 锚点
    expect(card.textContent).toContain('查看 AI 分析与时间线');
  });

  it('timeout 执行：定位卡以 warning 形态渲染且映射 timeout 动作', async () => {
    mockExecution({ status: 'timeout', failureReason: 'timeout' });
    renderPage();
    const card = await screen.findByTestId('failure-triage-card');
    expect(card.textContent).toContain('调大 timeoutSeconds');
  });

  it('unknown/未收录 failureReason 回退 unknown 兜底动作', async () => {
    mockExecution({ failureReason: 'brand_new_reason' });
    renderPage();
    const card = await screen.findByTestId('failure-triage-card');
    expect(card.textContent).toContain('无失败原因上报');
  });

  it('success 执行：不渲染失败定位卡', async () => {
    mockExecution({ status: 'success', failureReason: null });
    renderPage();
    await screen.findByText(/line-2 with keyword/);
    expect(screen.queryByTestId('failure-triage-card')).toBeNull();
  });
});

function getSearchInput(): HTMLInputElement {
  // data-testid 直接落在真实 <input> 上（allowClear 时 antd Input 根是 span）
  return screen.getByTestId('log-search-input') as HTMLInputElement;
}

describe('UI-05: 日志搜索高亮', () => {
  it('输入关键词（防抖后）命中片段渲染 mark.log-search-hit，pre 拼接保真', async () => {
    renderPage();
    await screen.findByText(/line-2 with keyword/);
    fireEvent.change(getSearchInput(), { target: { value: 'keyword' } });
    // 防抖（300ms）后生效：命中片段 mark 化
    await vi.waitFor(() => {
      const marks = [...document.querySelectorAll('mark.log-search-hit')];
      expect(marks.length).toBe(1);
      expect(marks[0].textContent).toBe('keyword');
    }, { timeout: 3000 });
    // 拼接保真：mark 不改变文本流
    expect(getPre().textContent).toBe(LOGS);
  });

  it('未命中关键词显示提示', async () => {
    renderPage();
    await screen.findByText(/line-2 with keyword/);
    fireEvent.change(getSearchInput(), { target: { value: '不存在的词' } });
    await vi.waitFor(() => expect(screen.getByText(/未找到匹配/)).toBeTruthy(), { timeout: 3000 });
  });
});

describe('UI-05: 纯函数（failure-runbook / log-search）', () => {
  it('failure-runbook 十二类键完整且 unknown 兜底', () => {
    // 与 mcp-server FAILURE_RUNBOOK 键集对齐（12 键）
    const KEYS = [
      'package_fetch_failed', 'dependency_install_failed', 'git_fetch_failed',
      'runtime_missing', 'script_error', 'timeout', 'executor_offline',
      'executor_restart', 'stale_recovered', 'killed', 'unknown',
    ];
    for (const k of KEYS) {
      expect(FAILURE_RUNBOOK_ACTIONS[k]?.action.length).toBeGreaterThan(0);
      expect(failureRunbookAction(k).action).toBe(FAILURE_RUNBOOK_ACTIONS[k].action);
    }
    // 未收录键 → unknown 兜底
    expect(failureRunbookAction('mystery')).toBe(FAILURE_RUNBOOK_ACTIONS.unknown);
    expect(failureRunbookAction(null).action).toBe(FAILURE_RUNBOOK_ACTIONS.unknown.action);
    expect(failureRunbookAction(undefined).action).toBe(FAILURE_RUNBOOK_ACTIONS.unknown.action);
  });

  it('splitLineByKeyword：大小写不敏感切分 + 拼接保真 + 空词单块', () => {
    expect(splitLineByKeyword('abc KEYWORD def keyWord x', 'keyword')).toEqual([
      { text: 'abc ', hit: false },
      { text: 'KEYWORD', hit: true },
      { text: ' def ', hit: false },
      { text: 'keyWord', hit: true },
      { text: ' x', hit: false },
    ]);
    expect(splitLineByKeyword('plain', '')).toEqual([{ text: 'plain', hit: false }]);
    // 正则元字符不炸
    expect(splitLineByKeyword('a.b(c)', '.b(')).toEqual([
      { text: 'a', hit: false }, { text: '.b(', hit: true }, { text: 'c)', hit: false },
    ]);
  });

  it('buildLogSearchSegments：行类注入与末行标记，拼接逐字符一致', () => {
    const logs = 'x [ERROR] boom\nok keyword';
    const segs = buildLogSearchSegments(logs, 'keyword', (l) =>
      l.includes('ERROR') ? 'log-line-error' : '');
    expect(segs.length).toBe(2);
    expect(segs[0].lineClass).toBe('log-line-error');
    expect(segs[0].isLast).toBe(false);
    expect(segs[1].isLast).toBe(true);
    expect(segs[1].segments.some((s) => s.hit && s.text === 'keyword')).toBe(true);
    // 保真
    expect(segs.map((s) => s.segments.map((p) => p.text).join('')).join('\n')).toBe(logs);
  });
});
