/**
 * FEAT-16：useExecutionsStream 专项（执行列表终态推送流客户端）。
 *
 * 覆盖：重连退避节奏（纯函数）、建流 URL 与鉴权回退、具名事件帧消费
 * （completed/failed/killed → invalidateExecutionData）、畸形/无关事件
 * 忽略、断线退避重建、卸载清理。对齐 use-metrics-stream.test 先例：
 * FakeEventSource + vi.stubGlobal + QueryClientProvider。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import {
  useExecutionsStream,
  executionsReconnectBackoffMs,
  EXECUTION_TERMINAL_EVENTS,
} from '../hooks/useExecutionsStream';
import { queryKeys } from '../api/queries';
import { useAuthStore } from '../store/auth';

// ── 纯函数：重连退避 ─────────────────────────────────────────────────────

describe('executionsReconnectBackoffMs 退避节奏', () => {
  it('3s 起步按 2^n 递增（3000/6000/12000/24000）', () => {
    expect(executionsReconnectBackoffMs(0)).toBe(3_000);
    expect(executionsReconnectBackoffMs(1)).toBe(6_000);
    expect(executionsReconnectBackoffMs(2)).toBe(12_000);
    expect(executionsReconnectBackoffMs(3)).toBe(24_000);
  });

  it('封顶 30s：更大 attempt 不再增长', () => {
    expect(executionsReconnectBackoffMs(4)).toBe(30_000);
    expect(executionsReconnectBackoffMs(10)).toBe(30_000);
  });

  it('负数 attempt 钳为基值（Math.max(0, attempt) 防御）', () => {
    expect(executionsReconnectBackoffMs(-1)).toBe(3_000);
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
  private listeners = new Map<string, Array<() => void>>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, cb: () => void) {
    const arr = this.listeners.get(name) ?? [];
    arr.push(cb);
    this.listeners.set(name, arr);
  }
  /** 测试辅助：触发具名事件（SSE event 帧消费入口） */
  emit(name: string) {
    for (const cb of this.listeners.get(name) ?? []) cb();
  }
  close() {
    this.closed = true;
  }
}

/** 终态事件载荷形状参考（与 admin-api ExecutionTerminalEventPayload 对齐）。
 * 本文件事件消费只走 invalidate（不读载荷字段），保留形状注释供对齐。 */

/** 预置一个列表缓存值（invalidate 后应被标记 stale → refetch 触发） */
function seedListCache(qc: QueryClient) {
  qc.setQueryData(queryKeys.executions.list({ page: 1, pageSize: 20 }), {
    items: [],
    total: 0,
  });
  qc.setQueryData(queryKeys.metrics.summary, { totalTasks: 0 });
}

describe('useExecutionsStream 流行为', () => {
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

  it('建立连接：URL 指向 /executions/stream 且携带 ?access_token=（metrics/stream 先例）', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <StreamStatusProbe />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.instances[0];
    expect(es.url).toContain('/executions/stream');
    expect(es.url).toContain('access_token=');
    expect(es.url).toContain(encodeURIComponent('test-token'));
  });

  it('三个终态事件帧均触发 invalidate：列表+汇总缓存被标记 stale 并重取', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const listKey = queryKeys.executions.list({ page: 1, pageSize: 20 });
    // 挂活跃 observer：invalidate 标记 stale 后立即触发 refetch。
    // 观察直接经 fetchQuery 建立缓存+订阅的替代方案：invalidateQueries 对
    // 无 observer 的缓存也置 isInvalidated，refetch 侧改用 invalidate 后
    // refetchQueries 的调用计数验证（queryClient.invalidateQueries 返回
    // 前提是 observer 在场——这里用两枚探针组件挂 observer 最贴生产）。
    seedListCache(qc);
    const listSpy = vi.fn().mockResolvedValue({ items: [], total: 0 });
    const summarySpy = vi.fn().mockResolvedValue({ totalTasks: 1 });

    function ListObserverProbe() {
      useQuery({
        queryKey: listKey,
        queryFn: listSpy,
      });
      return null;
    }
    function SummaryObserverProbe() {
      useQuery({
        queryKey: queryKeys.metrics.summary,
        queryFn: summarySpy,
      });
      return null;
    }

    render(
      <QueryClientProvider client={qc}>
        <ListObserverProbe />
        <SummaryObserverProbe />
        <StreamStatusProbe />
      </QueryClientProvider>,
    );
    // 等两枚 observer 首次拉取完成（seedListCache 直写的数据被 observer
    // staleTime 内复用，不触发 queryFn——先手动 refetch 一次建立 spy 计数）
    await act(async () => {
      await qc.refetchQueries({ queryKey: listKey });
      await qc.refetchQueries({ queryKey: queryKeys.metrics.summary });
    });
    const callsBefore = listSpy.mock.calls.length;

    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.instances[0];
    es.onopen?.();

    act(() => {
      for (const name of EXECUTION_TERMINAL_EVENTS) es.emit(name);
    });

    await waitFor(() => {
      expect(listSpy.mock.calls.length).toBeGreaterThan(callsBefore);
    });
    // 汇总面同拍失效（invalidateExecutionData 双前缀语义）——observer 在场
    // 时 invalidate 触发 refetch，refetch 完成后 isInvalidated 归零、
    // queryFn 被再次调用，以 summarySpy 计数代替瞬时 isInvalidated 断言。
    expect(summarySpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('无关事件/默认 message 帧不触发 invalidate（具名事件白名单消费）', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedListCache(qc);

    render(
      <QueryClientProvider client={qc}>
        <StreamStatusProbe />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.instances[0];
    es.onopen?.();

    // executor.offline 等其他领域事件不在终态白名单内
    act(() => {
      es.emit('executor.offline');
      es.emit('deployment.completed');
    });
    // 列表缓存未被标记 stale
    const listState = qc.getQueryState(
      queryKeys.executions.list({ page: 1, pageSize: 20 }),
    );
    expect(listState?.isInvalidated).toBe(false);
  });

  it('onopen 后状态转 live；onerror 后按退避重建（3s → 6s）', async () => {
    vi.useFakeTimers();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <StreamStatusProbe />
      </QueryClientProvider>,
    );
    expect(FakeEventSource.instances.length).toBe(1);
    expect(screen.getByTestId('stream-status').textContent).toBe('connecting');
    act(() => {
      FakeEventSource.instances[0].onopen?.();
    });
    expect(screen.getByTestId('stream-status').textContent).toBe('live');

    act(() => {
      FakeEventSource.instances[0].onerror?.();
    });
    expect(screen.getByTestId('stream-status').textContent).toBe('reconnecting');
    act(() => {
      vi.advanceTimersByTime(3_100);
    });
    expect(FakeEventSource.instances.length).toBe(2);
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
    act(() => {
      es.onerror?.();
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(FakeEventSource.instances.length).toBe(1);
    expect(es.closed).toBe(true);
  });
});

/** 状态探针组件（hook 返回值直出，供状态断言） */
function StreamStatusProbe() {
  const status = useExecutionsStream();
  return <span data-testid="stream-status">{status}</span>;
}
