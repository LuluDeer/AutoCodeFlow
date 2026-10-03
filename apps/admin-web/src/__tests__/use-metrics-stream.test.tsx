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
import {
  useMetricsStream,
  useMetricsStreamDegraded,
  reconnectBackoffMs,
} from '../hooks/useMetricsStream';
import { queryKeys } from '../api/queries';
import { getSSEStatus, SSE_STATUS_KEYS } from '../api/sse-client';
import { useAuthStore } from '../store/auth';

// A5：SSE 建流前先向后端换一枚 30s 短效票据（access token 不再进 URL）。
// 这里把换票桩成固定值，断言行相应改为断言 `?ticket=`。
vi.mock('../api/sse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/sse')>();
  return { ...actual, fetchSseTicket: vi.fn().mockResolvedValue('test-token') };
});

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
  // A-4：捕获具名事件监听（sse-client 的 events 映射走 addEventListener）
  private listeners = new Map<string, Array<(e: { data: string }) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, handler: (e: { data: string }) => void) {
    const arr = this.listeners.get(name) ?? [];
    arr.push(handler);
    this.listeners.set(name, arr);
  }
  /** 测试侧手动派发具名事件帧（如 error） */
  emit(name: string, event: { data: string }) {
    for (const h of this.listeners.get(name) ?? []) h(event);
  }
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

  it('建立连接：URL 指向 /metrics/stream 且携带 ?ticket=（logs/stream 先例）', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <StreamStatusProbe />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.instances[0];
    expect(es.url).toContain('/metrics/stream');
    expect(es.url).toContain('ticket=');
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

  it('NETOPT-DEBT：流状态接线进全局注册表（metricsStream 键），卸载移除', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = render(
      <QueryClientProvider client={qc}>
        <StreamStatusProbe />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    // 建流即登记（connecting）——queries.ts 的 metrics 三处条件轮询据此停/启
    expect(getSSEStatus(SSE_STATUS_KEYS.metricsStream)).toBe('connecting');
    act(() => {
      FakeEventSource.instances[0].onopen?.();
    });
    expect(getSSEStatus(SSE_STATUS_KEYS.metricsStream)).toBe('live');
    unmount();
    // 卸载清理登记（防泄漏）：键移除 → 条件轮询自动恢复 30s 兜底
    expect(getSSEStatus(SSE_STATUS_KEYS.metricsStream)).toBeUndefined();
  });

  it('onerror 后按退避重建连接（同 hook 生命周期内第二个实例）', async () => {
    vi.useFakeTimers();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <StreamStatusProbe />
      </QueryClientProvider>,
    );
    // A5：建流前先换票（异步）→ 断言前需冲刷微任务
    await act(async () => {});
    expect(FakeEventSource.instances.length).toBe(1);
    const first = FakeEventSource.instances[0];
    act(() => {
      first.onerror?.();
    });
    // 3s 退避后重建
    act(() => {
      vi.advanceTimersByTime(3_100);
    });
    await act(async () => {});
    expect(FakeEventSource.instances.length).toBe(2);
    // 二次失败 → 6s 退避
    act(() => {
      FakeEventSource.instances[1].onerror?.();
    });
    act(() => {
      vi.advanceTimersByTime(6_100);
    });
    await act(async () => {});
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
    await act(async () => {});
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
    await act(async () => {});
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

  // ── A-4（审计降级黑洞）：具名 error 帧 = 后端快照查询降级 ────────────────

  it('A-4：error 帧置降级标志并对失败段触发一次 refetch（live 停轮询下的补拉）', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const refetchSpy = vi.spyOn(qc, 'refetchQueries');
    render(
      <QueryClientProvider client={qc}>
        <StreamDegradedProbe />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.instances[0];
    expect(screen.getByTestId('stream-degraded').textContent).toBe('fresh');

    act(() => {
      es.emit('error', { data: JSON.stringify({ failed: ['summary'], at: 'now' }) });
    });
    expect(screen.getByTestId('stream-degraded').textContent).toBe('degraded');
    expect(refetchSpy).toHaveBeenCalledWith({ queryKey: queryKeys.metrics.summary });

    // 未列出的失败段不补拉（executors 不在 failed 数组）
    refetchSpy.mockClear();
    act(() => {
      es.emit('error', { data: JSON.stringify({ failed: ['summary'], at: 'now' }) });
    });
    expect(refetchSpy).toHaveBeenCalledTimes(1);
  });

  it('A-4：快照 errors 数组同步降级标志——恢复（空数组）即清除', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <StreamDegradedProbe />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.instances[0];

    act(() => {
      es.onmessage?.({
        data: JSON.stringify({ summary: null, executors: null, scheduler: null, errors: ['summary'] }),
      });
    });
    expect(screen.getByTestId('stream-degraded').textContent).toBe('degraded');
    // 降级拍不覆盖缓存（summary 为 null 不写入），旧值保留
    expect(qc.getQueryData(queryKeys.metrics.summary)).toBeUndefined();

    act(() => {
      es.onmessage?.({
        data: JSON.stringify({ summary: summaryPayload, executors: [], scheduler: {}, errors: [] }),
      });
    });
    expect(screen.getByTestId('stream-degraded').textContent).toBe('fresh');
    expect(qc.getQueryData(queryKeys.metrics.summary)).toEqual(summaryPayload);
  });

  it('A-4：畸形 error 帧按整体降级处理（置标志、不炸、不补拉）', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const refetchSpy = vi.spyOn(qc, 'refetchQueries');
    render(
      <QueryClientProvider client={qc}>
        <StreamDegradedProbe />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.instances[0];
    expect(() =>
      act(() => {
        es.emit('error', { data: 'not-json{{' });
      }),
    ).not.toThrow();
    expect(screen.getByTestId('stream-degraded').textContent).toBe('degraded');
    expect(refetchSpy).not.toHaveBeenCalled();
  });

  it('A-4：卸载后降级标志复位（不跨连接残留）', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = render(
      <QueryClientProvider client={qc}>
        <StreamDegradedProbe />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    act(() => {
      FakeEventSource.instances[0].emit('error', { data: JSON.stringify({ failed: ['summary'] }) });
    });
    expect(screen.getByTestId('stream-degraded').textContent).toBe('degraded');
    unmount();
    // 复位发生在 effect cleanup——下一次挂载（新渲染）读到 fresh
    const qc2 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc2}>
        <StreamDegradedProbe />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('stream-degraded').textContent).toBe('fresh');
  });
});

/** 状态探针组件（hook 返回值直出，供状态断言） */
function StreamStatusProbe() {
  const status = useMetricsStream();
  return <span data-testid="stream-status">{status}</span>;
}

/** A-4：连接状态 + 降级标志双面探针 */
function StreamDegradedProbe() {
  const status = useMetricsStream();
  const degraded = useMetricsStreamDegraded();
  return (
    <>
      <span data-testid="stream-status">{status}</span>
      <span data-testid="stream-degraded">{degraded ? 'degraded' : 'fresh'}</span>
    </>
  );
}
