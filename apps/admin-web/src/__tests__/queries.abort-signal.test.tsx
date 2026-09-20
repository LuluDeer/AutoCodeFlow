// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { client } from '../api/client';
import {
  useExecutionDetail,
  useExecutionReport,
  useExecutionRetryChain,
  useExecutionsList,
  useTaskDetail,
  useTaskExecutions,
  useExecutorsList,
  useExecutorGroups,
  useExecutorRuntimeConfig,
  useExecutorDetail,
  useExecutorMetrics,
  useMetricsSummary,
  useMetricsTrend,
  useExecutorStats,
  useRecentFailures,
  useSchedulerMetrics,
  useSchedulerStats,
  useTaskTemplates,
  useTaskStats,
} from '../api/queries';

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

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function responseFor(url: string) {
  if (url === '/tasks/t1') return { id: 't1', name: 'task' };
  if (url === '/tasks/t1/executions/e1') return { id: 'e1', taskId: 't1', status: 'success' };
  if (url === '/tasks/executions/all') return { items: [], total: 0 };
  if (url === '/tasks/t1/executions') return { items: [], total: 0, page: 1, pageSize: 100 };
  if (url === '/tasks/t1/executions/e1/report') {
    return { execution: {}, timeline: [], report: null };
  }
  // NETOPT-C P2-3: metrics / executors / scheduler 面 hooks 的响应桩
  if (url === '/executors') return [];
  if (url === '/executors/groups') return [];
  if (url === '/executors/runtime-config') return {};
  if (url === '/executors/e1') return { id: 'e1', address: '127.0.0.1:3105' };
  if (url === '/executors/e1/metrics') return {};
  if (url === '/metrics/summary') return {};
  if (url === '/metrics/trend?days=7') return [];
  if (url === '/metrics/executors') return [];
  if (url === '/metrics/failures') return [];
  if (url === '/metrics/scheduler') return {};
  if (url === '/tasks/scheduler/stats') return { healthy: true };
  if (url === '/task-templates') return [];
  if (url === '/tasks/t1/stats') {
    return { recentExecutions: [], successRate: 1, avgDuration: 0, totalRuns: 0 };
  }
  throw new Error(`unexpected GET ${url}`);
}

afterEach(() => {
  mockGet.mockReset();
});

describe('admin-web query GET cancellation', () => {
  it('passes TanStack Query signal through task detail and execution list APIs', async () => {
    mockGet.mockImplementation((url) => Promise.resolve(responseFor(url)));

    const detail = renderHook(() => useTaskDetail('t1'), { wrapper });
    const execution = renderHook(() => useExecutionDetail('t1', 'e1'), { wrapper });
    const list = renderHook(
      () => useExecutionsList({ page: 1, pageSize: 20 }),
      { wrapper },
    );

    await Promise.all([
      waitFor(() => expect(detail.result.current.data).toBeTruthy()),
      waitFor(() => expect(execution.result.current.data).toBeTruthy()),
      waitFor(() => expect(list.result.current.data).toBeTruthy()),
    ]);

    expect(mockGet).toHaveBeenCalledTimes(3);
    for (const [, config] of mockGet.mock.calls) {
      expect(config).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    }

    detail.unmount();
    execution.unmount();
    list.unmount();
  });

  it('passes a real AbortSignal to executors, metrics, and scheduler hooks (NETOPT-C P2-3)', async () => {
    // P2-3: 本轮 signal 接线覆盖 metrics 面 5 hook + executors 面 5 hook +
    // useSchedulerStats——此前这些 hook 的测试保护为零，断言退化为存在性检查。
    mockGet.mockImplementation((url) => Promise.resolve(responseFor(url)));

    const hooks = [
      renderHook(() => useExecutorsList(), { wrapper }),
      renderHook(() => useExecutorGroups(), { wrapper }),
      renderHook(() => useExecutorRuntimeConfig(), { wrapper }),
      renderHook(() => useExecutorDetail('e1'), { wrapper }),
      renderHook(() => useExecutorMetrics('e1'), { wrapper }),
      renderHook(() => useMetricsSummary(), { wrapper }),
      renderHook(() => useMetricsTrend(7), { wrapper }),
      renderHook(() => useExecutorStats(), { wrapper }),
      renderHook(() => useRecentFailures(), { wrapper }),
      renderHook(() => useSchedulerMetrics(), { wrapper }),
      renderHook(() => useSchedulerStats(), { wrapper }),
    ];

    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(11));

    // 断言每个 GET 都带**真实 AbortSignal**（not expect.anything()）
    for (const [, config] of mockGet.mock.calls) {
      expect(config).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
      expect(config.signal).toBeInstanceOf(AbortSignal);
    }

    for (const hook of hooks) hook.unmount();
  });

  it('passes a real AbortSignal to useTaskStats (60s polling hook, NETOPT-D P3-2)', async () => {
    // P3-2: useTaskStats 的 queryFn 已接 signal 但不在任何测试面——改回
    // `() => tasksApi.stats(id!)` 全绿。补真实 AbortSignal 断言钉死。
    mockGet.mockImplementation((url) => Promise.resolve(responseFor(url)));

    const stats = renderHook(() => useTaskStats('t1'), { wrapper });

    await waitFor(() => expect(stats.result.current.data).toBeTruthy());

    const lastCall = mockGet.mock.calls[mockGet.mock.calls.length - 1];
    expect(lastCall[0]).toBe('/tasks/t1/stats');
    expect(lastCall[1]).toEqual(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(lastCall[1].signal).toBeInstanceOf(AbortSignal);

    stats.unmount();
  });

  it('passes signal to task execution, retry-chain, and report GET APIs', async () => {
    mockGet.mockImplementation((url) => Promise.resolve(responseFor(url)));

    const executions = renderHook(
      () => useTaskExecutions('t1', { page: 1, pageSize: 100 }),
      { wrapper },
    );
    const retryChain = renderHook(() => useExecutionRetryChain('t1'), { wrapper });
    const report = renderHook(() => useExecutionReport('t1', 'e1'), { wrapper });

    await Promise.all([
      waitFor(() => expect(executions.result.current.data).toBeTruthy()),
      waitFor(() => expect(retryChain.result.current.data).toBeTruthy()),
      waitFor(() => expect(report.result.current.data).toBeTruthy()),
    ]);

    expect(mockGet).toHaveBeenCalledTimes(3);
    for (const [, config] of mockGet.mock.calls) {
      expect(config).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    }

    executions.unmount();
    retryChain.unmount();
    report.unmount();
  });

  // NETOPT-C P2-3: 本轮 signal 接线的 metrics 5 + executors 5 + scheduler 1 共 11
  // 个 hook 必须逐个断言真 AbortSignal——此前只验"传了第二参"（expect.anything()）
  // 把 useMetricsSummary 改回 `queryFn: () => metricsApi.getSummary()` 也全绿。
  it('passes a real AbortSignal through every metrics hook', async () => {
    mockGet.mockImplementation((url) => Promise.resolve(responseFor(url)));

    const summary = renderHook(() => useMetricsSummary(), { wrapper });
    const trend = renderHook(() => useMetricsTrend(7), { wrapper });
    const execStats = renderHook(() => useExecutorStats(), { wrapper });
    const failures = renderHook(() => useRecentFailures(), { wrapper });
    const scheduler = renderHook(() => useSchedulerMetrics(), { wrapper });

    await Promise.all([
      waitFor(() => expect(summary.result.current.data).toBeTruthy()),
      waitFor(() => expect(trend.result.current.data).toBeTruthy()),
      waitFor(() => expect(execStats.result.current.data).toBeTruthy()),
      waitFor(() => expect(failures.result.current.data).toBeTruthy()),
      waitFor(() => expect(scheduler.result.current.data).toBeTruthy()),
    ]);

    const urls = mockGet.mock.calls.map(([url]) => url as string);
    expect(urls).toEqual(
      expect.arrayContaining([
        '/metrics/summary',
        '/metrics/trend?days=7',
        '/metrics/executors',
        '/metrics/failures',
        '/metrics/scheduler',
      ]),
    );
    for (const [, config] of mockGet.mock.calls) {
      expect(config).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    }

    summary.unmount();
    trend.unmount();
    execStats.unmount();
    failures.unmount();
    scheduler.unmount();
  });

  it('passes a real AbortSignal through useTaskTemplates (NETOPT-D P2-4)', async () => {
    // P2-4: useTaskTemplates 的 signal 接线此前零测试保护（改回裸调用全绿）。
    mockGet.mockImplementation((url) => Promise.resolve(responseFor(url)));

    const templates = renderHook(() => useTaskTemplates(), { wrapper });
    await waitFor(() => expect(templates.result.current.data).toBeTruthy());

    const call = mockGet.mock.calls.find(([url]) => url === '/task-templates')!;
    expect(call).toBeDefined();
    expect(call[1]).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(call[1].signal).toBeInstanceOf(AbortSignal);

    templates.unmount();
  });

  it('passes a real AbortSignal through every executor hook and useSchedulerStats', async () => {
    mockGet.mockImplementation((url) => Promise.resolve(responseFor(url)));

    const list = renderHook(() => useExecutorsList(), { wrapper });
    const groups = renderHook(() => useExecutorGroups(), { wrapper });
    const runtime = renderHook(() => useExecutorRuntimeConfig(), { wrapper });
    const detail = renderHook(() => useExecutorDetail('e1'), { wrapper });
    const metrics = renderHook(() => useExecutorMetrics('e1'), { wrapper });
    const schedulerStats = renderHook(() => useSchedulerStats(), { wrapper });

    await Promise.all([
      waitFor(() => expect(list.result.current.data).toBeTruthy()),
      waitFor(() => expect(groups.result.current.data).toBeTruthy()),
      waitFor(() => expect(runtime.result.current.data).toBeTruthy()),
      waitFor(() => expect(detail.result.current.data).toBeTruthy()),
      waitFor(() => expect(metrics.result.current.data).toBeTruthy()),
      waitFor(() => expect(schedulerStats.result.current.data).toBeTruthy()),
    ]);

    const urls = mockGet.mock.calls.map(([url]) => url as string);
    expect(urls).toEqual(
      expect.arrayContaining([
        '/executors',
        '/executors/groups',
        '/executors/runtime-config',
        '/executors/e1',
        '/executors/e1/metrics',
        '/tasks/scheduler/stats',
      ]),
    );
    for (const [, config] of mockGet.mock.calls) {
      expect(config).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    }

    list.unmount();
    groups.unmount();
    runtime.unmount();
    detail.unmount();
    metrics.unmount();
    schedulerStats.unmount();
  });
});
