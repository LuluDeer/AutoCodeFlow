// @vitest-environment jsdom
/**
 * NETOPT-DEBT：SSE 条件轮询判定专项（api/queries.ts sseFallbackRefetchInterval）。
 *
 * 覆盖任务书三态：
 *   ① 流 live → refetchInterval 为 false（不轮询，推送即新鲜度来源）；
 *   ② 流断开/断线（登记移除或 reconnecting）→ 恢复 30_000 兜底；
 *   ③ key 未登记（流未挂载/旧调用方）→ 30_000（向后兼容：保持轮询）。
 * 并以 useMetricsSummary + FakeEventSource 做一次端到端验证（live 时 4 个
 * 轮询周期零请求；close 登记移除后按 30s 节奏恢复轮询）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, act } from '@testing-library/react';
import { client } from '../api/client';
import {
  useMetricsSummary,
  sseFallbackRefetchInterval,
  queryKeys,
} from '../api/queries';
import {
  createSseClient,
  getSSEStatus,
  SSE_STATUS_KEYS,
} from '../api/sse-client';

vi.mock('../api/client', () => ({
  client: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

const mockGet = vi.mocked(client.get);

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  onopen?: () => void;
  onerror?: () => void;
  onmessage?: (e: unknown) => void;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener() {}
  close() {
    this.closed = true;
  }
}

/** 冲刷已 resolve 的 promise 链（换票与查询 fetch 均为异步）。 */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('sseFallbackRefetchInterval 三态判定', () => {
  it('key 未登记（无流/旧调用方）→ 30_000 兜底', () => {
    expect(sseFallbackRefetchInterval('never/registered')()).toBe(30_000);
  });

  it('live → false 停轮询；connecting/reconnecting/登记移除 → 30_000', async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    try {
      const sse = createSseClient({
        baseUrl: 'http://api',
        path: '/metrics/stream',
        statusKey: 'probe/key',
        fetchTicket: async () => 't-1',
        reconnect: false,
      });
      await flush();
      const interval = sseFallbackRefetchInterval('probe/key');
      expect(interval()).toBe(30_000); // connecting：流尚未活 → 兜底

      FakeEventSource.instances[0].onopen?.();
      expect(interval()).toBe(false); // live：推送即新鲜度来源

      FakeEventSource.instances[0].onerror?.();
      expect(interval()).toBe(30_000); // reconnecting：断流兜底

      sse.close();
      expect(interval()).toBe(30_000); // 登记移除：回到无流兜底
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('useMetricsSummary 条件轮询（注册表驱动，端到端）', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    mockGet.mockResolvedValue({ data: { data: { totalTasks: 1 } } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('流 live 时零轮询；登记移除后恢复 30s 轮询', async () => {
    vi.useFakeTimers();
    // 用真实工厂把注册表推到 live（与 useMetricsStream 同一 statusKey）。
    const sse = createSseClient({
      baseUrl: 'http://api',
      path: '/metrics/stream',
      statusKey: SSE_STATUS_KEYS.metricsStream,
      fetchTicket: async () => 't-1',
      reconnect: false,
    });
    await act(async () => {}); // 冲刷换票微任务
    FakeEventSource.instances[0].onopen?.();
    expect(getSSEStatus(SSE_STATUS_KEYS.metricsStream)).toBe('live');

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { rerender } = renderHook(() => useMetricsSummary(), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockGet).toHaveBeenCalledTimes(1); // 仅挂载首取

    // live：连续 4 个「轮询周期」零新增请求（推送承担新鲜度）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(mockGet).toHaveBeenCalledTimes(1);

    // 流登记移除（组件卸载 close / 断线）→ 重渲染重估 → 30s 兜底恢复
    sse.close();
    rerender(); // 页面因 SSE 状态点变化重渲染，refetchInterval 重估
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(mockGet).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mockGet).toHaveBeenCalledTimes(3);

    // 兜底查询自身的 queryKey 仍是缓存事实源（缓存语义未被本次改动触碰）
    expect(queryClient.getQueryData(queryKeys.metrics.summary)).toBeDefined();
  });

  it('流从未挂载（key 未登记）→ 30s 恒轮询（向后兼容）', async () => {
    vi.useFakeTimers();
    expect(getSSEStatus(SSE_STATUS_KEYS.metricsStream)).toBeUndefined();

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    renderHook(() => useMetricsSummary(), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockGet).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(91_000);
    });
    // 30s 节奏：+30/+60/+90 三次兜底轮询
    expect(mockGet).toHaveBeenCalledTimes(4);
  });
});
