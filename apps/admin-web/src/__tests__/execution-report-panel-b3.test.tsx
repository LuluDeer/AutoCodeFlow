/**
 * B3-②：ExecutionReportPanel 时间线升级回归。
 *
 * 覆盖：① 失败终态段失败点高亮（归类 Tag + 原始错误信息）；② 重试链关联
 * （第 N 次尝试 · 链上共 M 次 + 「查看重试链」跳转回调）；③ 阶段耗时可见
 * （排队等待 / 运行耗时）；④ 成功执行不渲染失败点块。
 *
 * 数据源复用既有 report 载荷（execution 行携 failureReason/errorMessage/retryCount），
 * 不发新请求；链长与跳转回调由页面注入。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import ExecutionReportPanel from '../components/ExecutionReportPanel';
import type { ExecutionReportPayload } from '../api/execution-reports';

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

const FAILED_PAYLOAD: ExecutionReportPayload = {
  execution: {
    id: 'e1',
    status: 'failed',
    triggerType: 'cron',
    executorAddress: 'http://executor-a:3001',
    createdAt: '2026-09-07T01:00:00.000Z',
    startTime: '2026-09-07T01:00:05.000Z',
    endTime: '2026-09-07T01:05:00.000Z',
    duration: 295000,
    retryCount: 1,
    failureReason: 'script_error',
    errorMessage: 'ZeroDivisionError: division by zero',
    aiAnalysis: null,
  },
  timeline: [
    { phase: 'created', at: '2026-09-07T01:00:00.000Z', detail: 'trigger=cron' },
    { phase: 'started', at: '2026-09-07T01:00:05.000Z', detail: 'executor=http://executor-a:3001' },
    { phase: 'finished', at: '2026-09-07T01:05:00.000Z', detail: 'status=failed' },
  ],
  report: null,
};

const SUCCESS_PAYLOAD: ExecutionReportPayload = {
  execution: {
    id: 'e2',
    status: 'success',
    triggerType: 'manual',
    executorAddress: 'http://executor-b:3002',
    createdAt: '2026-09-07T02:00:00.000Z',
    startTime: '2026-09-07T02:00:02.000Z',
    endTime: '2026-09-07T02:01:00.000Z',
    duration: 58000,
    retryCount: 0,
    aiAnalysis: null,
  },
  timeline: [
    { phase: 'created', at: '2026-09-07T02:00:00.000Z', detail: 'trigger=manual' },
    { phase: 'started', at: '2026-09-07T02:00:02.000Z', detail: 'executor=http://executor-b:3002' },
    { phase: 'finished', at: '2026-09-07T02:01:00.000Z', detail: 'status=success' },
  ],
  report: null,
};

afterEach(() => {
  cleanup();
});

describe('B3-② ExecutionReportPanel 时间线升级', () => {
  it('失败终态段渲染失败点块：归类 Tag + 原始错误信息', () => {
    render(<ExecutionReportPanel payload={FAILED_PAYLOAD} />);
    const point = screen.getByTestId('timeline-failure-point');
    expect(point).toBeTruthy();
    expect(point.textContent).toContain('ZeroDivisionError: division by zero');
    // 归类标签走 failureReasonLabel（script_error 既有词条）
    expect(point.querySelector('.ant-tag')).toBeTruthy();
  });

  it('重试链关联：展示第 N 次尝试/链上总数，「查看重试链」触发回调', () => {
    const onShowRetry = vi.fn();
    render(
      <ExecutionReportPanel
        payload={FAILED_PAYLOAD}
        chainLength={3}
        onShowRetry={onShowRetry}
      />,
    );
    expect(screen.getByTestId('timeline-attempt-meta').textContent).toContain('第 2 次尝试 · 链上共 3 次');
    const btn = screen.getByTestId('timeline-view-retry');
    fireEvent.click(btn);
    expect(onShowRetry).toHaveBeenCalledTimes(1);
  });

  it('阶段耗时可见：排队等待（started 段）与运行耗时（finished 段）', () => {
    render(<ExecutionReportPanel payload={FAILED_PAYLOAD} />);
    expect(screen.getByText(/排队等待/)).toBeTruthy();
    expect(screen.getByText(/运行耗时/)).toBeTruthy();
  });

  it('成功执行不渲染失败点块', () => {
    render(<ExecutionReportPanel payload={SUCCESS_PAYLOAD} chainLength={1} />);
    expect(screen.queryByTestId('timeline-failure-point')).toBeNull();
    // 单链原始尝试不展示链上次数元信息
    expect(screen.queryByTestId('timeline-attempt-meta')).toBeNull();
  });
});
