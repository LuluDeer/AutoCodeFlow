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
});
