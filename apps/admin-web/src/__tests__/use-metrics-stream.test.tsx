/**
 * UI-14 第一阶段：useMetricsStream 专项（Dashboard 汇总流客户端）。
 *
 * 覆盖：重连退避节奏（纯函数）与流行为（FakeEventSource 捕获建流 URL/
 * 消息分发/queryClient 缓存写入/错误重建/卸载清理）。对齐
 * execution-detail-sse 先例：stubEnv + vi.stubGlobal(EventSource)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMetricsStream, reconnectBackoffMs } from '../hooks/useMetricsStream';
import { queryKeys } from '../api/queries';
import { useAuthStore } from '../store/auth';

// ── 纯函数：重连退避 ─────────────────────────────────────────────────────

describe('reconnectBackoffMs 退避节奏', () => {
  it('3s 起步按 2^n 递增（3000/6000/12000/24000）', () => {
    expect(reconnectBackoffMs(0)).toBe(3_000);
    expect(reconnectBackoffMs(1)).toBe(6_000);
    expect(reconnectBackoffMs(2)).toBe(12_000);
    expect(reconnectBackoffMs(3)).toBe(24_000);
  });

  it('封顶 30s：更大 attempt 不再增长', () => {
    expect(reconnectBackoffMs(4)).toBe(30_000);
    expect(reconnectBackoffMs(10)).toBe(30_000);
  });

  it('负数 attempt 钳为基值（Math.max(0, attempt) 防御）', () => {
    expect(reconnectBackoffMs(-1)).toBe(3_000);
  });
});

// ── 流行为：FakeEventSource ──────────────────────────────────────────────

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener() {}
  close() {
    this.closed = true;
  }
}

const summaryPayload = {
  totalTasks: 3,
  todayRuns: 5,
  totalExecutors: 2,
  onlineExecutors: 1,
  executions: { total: 10, success: 8, failed: 1, running: 1 },
  successRate: 80,
  avgDurationMs: 1000,
};

describe('useMetricsStream 流行为', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    useAuthStore.setState({ token: 'test-token' });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('建立连接：URL 指向 /metrics/stream 且携带 ?access_token=（logs/stream 先例）', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <StreamStatusProbe />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.instances[0];
    expect(es.url).toContain('/metrics/stream');
    expect(es.url).toContain('access_token=');
    expect(es.url).toContain(encodeURIComponent('test-token'));
  });

  it('快照推送写入 queryClient 缓存（summary/executors/scheduler 三 key）', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <StreamStatusProbe />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.instances[0];
    es.onopen?.();

    act(() => {
      es.onmessage?.({
        data: JSON.stringify({
          summary: summaryPayload,
          executors: [{ id: 'e1', cpuUsage: 10 }],
          scheduler: { healthy: true },
          errors: [],
        }),
      });
    });

    expect(qc.getQueryData(queryKeys.metrics.summary)).toEqual(summaryPayload);
    expect(qc.getQueryData(queryKeys.metrics.executorStats)).toEqual([
      { id: 'e1', cpuUsage: 10 },
    ]);
    expect(qc.getQueryData(queryKeys.metrics.scheduler)).toEqual({ healthy: true });
  });

  it('onopen 后状态转 live（状态点文案实时）', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <StreamStatusProbe />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    expect(screen.getByTestId('stream-status').textContent).toBe('connecting');
    act(() => {
      FakeEventSource.instances[0].onopen?.();
    });
    expect(screen.getByTestId('stream-status').textContent).toBe('live');
  });

  it('onerror 后按退避重建连接（同 hook 生命周期内第二个实例）', async () => {
    vi.useFakeTimers();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <StreamStatusProbe />
      </QueryClientProvider>,
    );
    expect(FakeEventSource.instances.length).toBe(1);
    const first = FakeEventSource.instances[0];
    act(() => {
      first.onerror?.();
    });
    // 3s 退避后重建
    act(() => {
      vi.advanceTimersByTime(3_100);
    });
    expect(FakeEventSource.instances.length).toBe(2);
    // 二次失败 → 6s 退避
    act(() => {
      FakeEventSource.instances[1].onerror?.();
    });
    act(() => {
      vi.advanceTimersByTime(6_100);
    });
    expect(FakeEventSource.instances.length).toBe(3);
  });

  it('卸载清理：close 实例 + 清除重连定时器（不再新建连接）', async () => {
    vi.useFakeTimers();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = render(
      <QueryClientProvider client={qc}>
        <StreamStatusProbe />
      </QueryClientProvider>,
    );
    expect(FakeEventSource.instances.length).toBe(1);
    const es = FakeEventSource.instances[0];
    // 先触发错误（挂起重连定时器），再卸载
    act(() => {
      es.onerror?.();
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(FakeEventSource.instances.length).toBe(1); // 无新实例
    expect(es.closed).toBe(true);
  });

  it('畸形帧静默忽略不炸缓存（与日志流消费同策略）', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <StreamStatusProbe />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.instances[0];
    expect(() =>
      act(() => {
        es.onmessage?.({ data: 'not-json{{' });
      }),
    ).not.toThrow();
    expect(qc.getQueryData(queryKeys.metrics.summary)).toBeUndefined();
  });
});

/** 状态探针组件（hook 返回值直出，供状态断言） */
function StreamStatusProbe() {
  const status = useMetricsStream();
  return <span data-testid="stream-status">{status}</span>;
}
