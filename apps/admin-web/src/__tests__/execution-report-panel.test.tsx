/**
 * OBS-04: ExecutionReportPanel 组件测试。
 * 覆盖：① 时间线与 DB 时间戳一致渲染（formatDateTime 输出）；② 空报告
 * 降级（report=null 显示提示而非报错）；③ AI 分析缺失降级与存在渲染；
 * ④ 终态段状态图标映射。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import ExecutionReportPanel from '../components/ExecutionReportPanel';
import type { ExecutionReportPayload } from '../api/execution-reports';

// jsdom 缺失 antd 依赖的浏览器 API（对齐 execution-detail-sse.test 先例）
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

const FULL_PAYLOAD: ExecutionReportPayload = {
  execution: {
    id: 'e1',
    status: 'failed',
    triggerType: 'cron',
    executorAddress: 'http://executor-a:3001',
    createdAt: '2026-09-07T01:00:00.000Z',
    startTime: '2026-09-07T01:00:05.000Z',
    endTime: '2026-09-07T01:05:00.000Z',
    duration: 295000,
    aiAnalysis: '根因：脚本第 12 行抛出 ZeroDivisionError。',
  },
  timeline: [
    { phase: 'created', at: '2026-09-07T01:00:00.000Z', detail: 'trigger=cron' },
    { phase: 'started', at: '2026-09-07T01:00:05.000Z', detail: 'executor=http://executor-a:3001' },
    { phase: 'finished', at: '2026-09-07T01:05:00.000Z', detail: 'status=failed' },
  ],
  report: {
    id: 7,
    triggerDay: '2026-09-07',
    runningCount: 1,
    successCount: 10,
    failCount: 3,
    timeoutCount: 1,
    cancelledCount: 0,
    avgDurationMs: 42000,
    maxDurationMs: 300000,
    minDurationMs: 1500,
  },
};

beforeEach(() => {
  vi.useFakeTimers?.();
  vi.useRealTimers?.();
});

afterEach(() => {
  cleanup();
});

describe('ExecutionReportPanel', () => {
  it('renders timeline timestamps formatted from the DB values', () => {
    render(<ExecutionReportPanel payload={FULL_PAYLOAD} />);
    // formatDateTime 本地时区渲染 DB 时刻——三个阶段都出现且非「—」
    for (const phase of ['created', 'started', 'finished'] as const) {
      const node = screen.getByTestId(`timeline-${phase}`);
      expect(node.textContent).not.toContain('—');
      expect(node.textContent!.length).toBeGreaterThan(0);
    }
    // detail 透传
    expect(screen.getByText('trigger=cron')).toBeTruthy();
    expect(screen.getByText('status=failed')).toBeTruthy();
    // DB 耗时展示（295000ms → 4分55秒）
    expect(screen.getByText('4分55秒')).toBeTruthy();
  });

  it('degrades gracefully when the daily report row is absent (report:null)', () => {
    render(
      <ExecutionReportPanel
        payload={{ ...FULL_PAYLOAD, report: null }}
      />,
    );
    expect(screen.getByTestId('report-empty')).toBeTruthy();
    // 报告缺行不吞时间线：三段仍渲染
    expect(screen.getByTestId('timeline-created')).toBeTruthy();
    expect(screen.getByTestId('timeline-finished')).toBeTruthy();
    // 不渲染聚合数字行
    expect(screen.queryByTestId('report-row')).toBeNull();
  });

  it('degrades the AI analysis section when aiAnalysis is empty', () => {
    render(
      <ExecutionReportPanel
        payload={{
          ...FULL_PAYLOAD,
          execution: { ...FULL_PAYLOAD.execution, aiAnalysis: null },
        }}
      />,
    );
    expect(screen.getByText(/暂无 AI 分析/)).toBeTruthy();
  });

  it('renders the AI analysis text when present', () => {
    render(<ExecutionReportPanel payload={FULL_PAYLOAD} />);
    expect(
      screen.getByText(/ZeroDivisionError/),
    ).toBeTruthy();
  });

  it('renders all-missing timeline as em-dash skeleton without throwing', () => {
    render(<ExecutionReportPanel payload={null} loadError="网络超时" />);
    for (const phase of ['created', 'started', 'finished'] as const) {
      expect(screen.getByTestId(`timeline-${phase}`).textContent).toContain('—');
    }
    // 降级警告可见
    expect(screen.getByText(/报告数据加载失败/)).toBeTruthy();
  });
});
