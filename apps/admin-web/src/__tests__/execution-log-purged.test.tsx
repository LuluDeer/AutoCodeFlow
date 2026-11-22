// @vitest-environment jsdom
/**
 * R284-LOGPURGE-01（切片 B，只说清不碰策略）：空日志区必须区分**三态**。
 *
 * ## 真事故形态
 *
 * 日志行留 30 天（`logRetention.days`），执行行留 90 天
 * （`configuration.ts` 的 `logRetention` vs 执行保留）。⇒ 翻 31~90 天前的执行
 * 详情，日志区是一个**空 `<pre>`**，而此前唯一的「空」暗示来自「无 XX 级别日志」
 * 文案（讲的是切日志级别）。用户读成「这条执行没输出 / 采集坏了」，复盘里写
 * 「没有证据」——**真相是证据已按策略删除**。
 *
 * ## 本套件的断言口径（不是"渲染了就行"）
 *
 * ① 已清理：`logsPurged:true` ⇒ 出现「已清理」文案 + 清理截止时刻；
 * ② 真没输出：`logsPurged:false` ⇒ 出现「没有输出」文案；
 * ③ 未知：`logsPurged:null` / 字段缺失 / 请求抛错 ⇒ 出现「无法判定」文案；
 * ④ **三态文案互不相同**（不是只断言"某个 Alert 出现了"）——同一句话覆盖
 *    两种完全不同的结论正是本 bug 的形态，只断言"渲染了"完全抓不到它。
 * ⑤ 未知态**不得**被写成"没有输出"：断言它既不是 ① 也不是 ② 的那条。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { tasksApi } from '../api/tasks';
import ExecutionDetailPage from '../pages/ExecutionDetailPage';
import zh from '../locales/zh';

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

const T = (k: string) => zh[k as keyof typeof zh] as string;

/**
 * 造一条「终态 + 空日志」的执行（终态是空态判定的前提：运行中为空是正常态，
 * 不该挂任何结论）。
 */
function mockEmptyExecution(status = 'failed') {
  vi.mocked(tasksApi.execution).mockReset().mockResolvedValue({
    id: 'e1',
    taskId: 't1',
    taskName: 'nightly',
    status,
    triggerType: 'manual',
    logs: '',
    createdAt: new Date(Date.now() - 40 * 86_400_000).toISOString(),
  } as never);
  vi.mocked(tasksApi.get).mockReset().mockResolvedValue({
    id: 't1',
    maxRetry: 3,
    retryDelay: 5,
  } as never);
  vi.mocked(tasksApi.executions).mockReset().mockResolvedValue({
    items: [{ id: 'e1', retryCount: 0, status }],
    total: 1,
    page: 1,
    pageSize: 100,
  } as never);
}

function renderPage() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={['/tasks/t1/executions/e1']}>
        <Routes>
          <Route
            path="/tasks/:taskId/executions/:execId"
            element={<ExecutionDetailPage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 按 data-testid 取空态 Alert 的可见文本（title + description）。 */
async function emptyStateText(testId: string): Promise<string> {
  const el = await screen.findByTestId(testId);
  return el.textContent ?? '';
}

beforeEach(() => {
  vi.mocked(tasksApi.executionLogs).mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('R284-LOGPURGE-01 日志空态三态', () => {
  it('① logsPurged:true ⇒ 「已清理」文案 + 清理截止时刻', async () => {
    mockEmptyExecution();
    vi.mocked(tasksApi.executionLogs).mockResolvedValue({
      lines: [],
      totalLines: 0,
      hasMore: false,
      logsPurged: true,
      logsPurgedAt: '2026-10-21T03:30:00.000Z',
    } as never);

    renderPage();

    const text = await emptyStateText('log-empty-purged');
    // 标题是"已清理"这条事实，而不是"没有输出"
    expect(text).toContain(T('execDetail.log.purgedTitle'));
    // 截止时刻必须落地（否则用户无从判断"这是什么时候删的"）
    expect(text).not.toContain(T('execDetail.log.purgedAtUnknown'));
  });

  it('② logsPurged:false ⇒ 「真没输出」文案（不是"已清理"）', async () => {
    mockEmptyExecution();
    vi.mocked(tasksApi.executionLogs).mockResolvedValue({
      lines: [],
      totalLines: 0,
      hasMore: false,
      logsPurged: false,
      logsPurgedAt: null,
    } as never);

    renderPage();

    const text = await emptyStateText('log-empty-no-output');
    expect(text).toContain(T('execDetail.log.emptyTitle'));
    // 关键：不能同时挂"已清理"——那正是本 bug 的形态
    expect(screen.queryByTestId('log-empty-purged')).toBeNull();
  });

  it('③ logsPurged:null ⇒ 「无法判定」文案（既非 true 也非 false）', async () => {
    mockEmptyExecution();
    vi.mocked(tasksApi.executionLogs).mockResolvedValue({
      lines: [],
      totalLines: 0,
      hasMore: false,
      logsPurged: null,
      logsPurgedAt: null,
    } as never);

    renderPage();

    const text = await emptyStateText('log-empty-unknown');
    expect(text).toContain(T('execDetail.log.unknownTitle'));
    // 未知态不得被写成"没有输出"，也不得被写成"已清理"
    expect(screen.queryByTestId('log-empty-no-output')).toBeNull();
    expect(screen.queryByTestId('log-empty-purged')).toBeNull();
  });

  it('③b 读失败 ⇒ 未知态（不谎报"真没输出"）', async () => {
    mockEmptyExecution();
    vi.mocked(tasksApi.executionLogs).mockRejectedValue(new Error('boom'));

    renderPage();

    await emptyStateText('log-empty-unknown');
    expect(screen.queryByTestId('log-empty-no-output')).toBeNull();
    expect(screen.queryByTestId('log-empty-purged')).toBeNull();
  });

  it('③c 旧后端不返回该字段 ⇒ 未知态（undefined 不等于 false）', async () => {
    mockEmptyExecution();
    vi.mocked(tasksApi.executionLogs).mockResolvedValue({
      lines: [],
      totalLines: 0,
      hasMore: false,
    } as never);

    renderPage();

    await emptyStateText('log-empty-unknown');
  });

  /**
   * ④ 三态文案**互不相同**。这一条是本切片的验收核心：
   * 同一句话覆盖两种结论 = 用户无法区分，即使每个分支都"渲染了 Alert"。
   */
  it('④ 三态文案两两不相等（已清理 / 真没输出 / 无法判定）', () => {
    const purged = `${T('execDetail.log.purgedTitle')}|${T('execDetail.log.purgedDesc')}`;
    const empty = `${T('execDetail.log.emptyTitle')}|${T('execDetail.log.emptyDesc')}`;
    const unknown = `${T('execDetail.log.unknownTitle')}|${T('execDetail.log.unknownDesc')}`;

    expect(purged).not.toBe(empty);
    expect(purged).not.toBe(unknown);
    expect(empty).not.toBe(unknown);
    // 标题本身也必须互异（用户扫一眼标题就要能区分）
    expect(T('execDetail.log.purgedTitle')).not.toBe(T('execDetail.log.emptyTitle'));
    expect(T('execDetail.log.purgedTitle')).not.toBe(T('execDetail.log.unknownTitle'));
    expect(T('execDetail.log.emptyTitle')).not.toBe(T('execDetail.log.unknownTitle'));
  });

  it('有日志时不挂任何空态结论（不误报）', async () => {
    mockEmptyExecution();
    vi.mocked(tasksApi.execution).mockReset().mockResolvedValue({
      id: 'e1',
      taskId: 't1',
      taskName: 'nightly',
      status: 'failed',
      triggerType: 'manual',
      logs: 'boom line',
      createdAt: new Date().toISOString(),
    } as never);
    vi.mocked(tasksApi.executionLogs).mockResolvedValue({
      lines: ['boom line'],
      totalLines: 1,
      hasMore: false,
      logsPurged: false,
      logsPurgedAt: null,
    } as never);

    renderPage();

    await waitFor(() =>
      expect(document.querySelector('[data-testid="log-pre"]')).not.toBeNull(),
    );
    expect(screen.queryByTestId('log-empty-purged')).toBeNull();
    expect(screen.queryByTestId('log-empty-no-output')).toBeNull();
    expect(screen.queryByTestId('log-empty-unknown')).toBeNull();
  });
});