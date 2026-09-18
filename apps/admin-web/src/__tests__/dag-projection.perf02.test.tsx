// @vitest-environment jsdom
/**
 * PERF-02（本轮体验审查）：DAG 取数必须带上 `dependencies`。
 *
 * 缺陷：`tasksApi.listAll` 默认注入 `?fields=id,name`（F-10 的性能优化），而
 * TaskDependencyGraph 的边集**只**来自 `t.dependencies`
 * （`components/dag-layout.ts:58`，undefined 即 `continue`）。默认投影把该列
 * 裁掉后，边集恒为空 → 任何配了上下游依赖的任务打开「依赖」页签都显示
 * 「该任务没有依赖其他任务」，「触发整条链」退化为只触发单任务。
 *
 * 这是 F-10 引入的**静默功能损坏**，且既有单测发现不了：`dag-layout.test.ts`
 * 与 `task-dag-chain-trigger.test.tsx` 都直接构造带 `dependencies` 的对象并
 * mock 掉 `tasksApi.listAll`，**绕过了 API 层**，所以投影把列裁掉它们依然是
 * 绿的。本文件的职责就是把断点前移到 API 层：断言真实发出的 query 串里
 * 必须有 `dependencies`。
 *
 * 反证：若把 `queries.ts` 的 `listAll({ fields: 'id,name,dependencies' })`
 * 改回 `listAll({})`，第一条用例立刻变红。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { client } from '../api/client';
import { useAllTasksForDag } from '../api/queries';

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

/** 从 mockGet 的调用参数里取出 `params`。 */
function paramsOfCall(index: number): Record<string, unknown> {
  const call = mockGet.mock.calls[index];
  expect(call, `client.get 第 ${index + 1} 次调用不存在`).toBeDefined();
  return (call[1] as { params: Record<string, unknown> }).params;
}

/** 把 params.fields 解析成集合，便于断言「包含」而非「全等」。 */
function fieldsOf(params: Record<string, unknown>): Set<string> {
  const raw = params.fields;
  expect(typeof raw, 'fields 必须是字符串（后端按逗号分隔解析）').toBe('string');
  return new Set(
    String(raw)
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean),
  );
}

afterEach(() => {
  mockGet.mockReset();
});

describe('PERF-02 — DAG 取数必须请求 dependencies', () => {
  it('useAllTasksForDag 发出的 query 串包含 dependencies（否则图边恒空）', async () => {
    mockGet.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 100,
      totalPages: 0,
    });

    const { result } = renderHook(() => useAllTasksForDag(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockGet).toHaveBeenCalled();
    const fields = fieldsOf(paramsOfCall(0));

    // 核心断言：DAG 的唯一边集来源必须在投影里。
    expect(fields.has('dependencies')).toBe(true);
    // F-10 的收益保留：仍然是轻量投影，没有退回全列。
    expect(fields.has('id')).toBe(true);
    expect(fields.has('name')).toBe(true);
    // SEC-02 / F-10：重量列与密钥永不出现在投影里。
    expect(fields.has('secrets')).toBe(false);
    expect(fields.has('params')).toBe(false);
    expect(fields.has('glueSource')).toBe(false);
  });

  it('投影串精确等于 id,name,dependencies（防止后续再被悄悄改窄）', async () => {
    mockGet.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 100,
      totalPages: 0,
    });

    const { result } = renderHook(() => useAllTasksForDag(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(paramsOfCall(0).fields).toBe('id,name,dependencies');
  });

  it('dependencies 确实随响应抵达消费方（端到端形状，不只查 query 串）', async () => {
    // 后端投影后返回的行：带 dependencies 的 jsonb 映射（任务 id → 任务名）。
    mockGet.mockResolvedValue({
      items: [
        {
          id: 't2',
          name: 'downstream',
          dependencies: { 't1': 'upstream' },
        },
      ],
      total: 1,
      page: 1,
      pageSize: 100,
      totalPages: 1,
    });

    const { result } = renderHook(() => useAllTasksForDag(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const items = result.current.data!.items as Array<{
      dependencies?: Record<string, string>;
    }>;
    // 消费方（dag-layout）读的就是这个字段；undefined 会让它 continue。
    expect(items[0].dependencies).toEqual({ 't1': 'upstream' });
  });
});
