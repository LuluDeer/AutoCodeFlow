/**
 * NETOPT-E P3-2: invalidate* 辅助的失效前缀守护测试。
 *
 * 背景：invalidateExecutorData 在 NETOPT-D P3-4 移除了 tasks.all（删除/下线
 * 执行器不改任务定义，失效任务列表白白触发任务页重取），但当时零测试守
 * 护——把 tasks.all 加回 / 把 executors.all 删掉全绿。本文件把三个失效辅助
 * 的前缀覆盖钉死，防"实现改坏但测试全绿"。
 */
import { describe, it, expect } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  invalidateExecutorData,
  invalidateTaskData,
  invalidateExecutionData,
  queryKeys,
} from '../api/queries';

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** 预置四类面缓存各一条，返回 { key, 是否应被失效 } 供断言。 */
function seedAllFaces(qc: QueryClient) {
  qc.setQueryData(queryKeys.tasks.all, []);
  qc.setQueryData(queryKeys.tasks.list({ page: 1, pageSize: 20 }), { items: [], total: 0 });
  qc.setQueryData(queryKeys.executions.all, []);
  qc.setQueryData(queryKeys.executors.all, []);
  qc.setQueryData(queryKeys.metrics.all, []);
}

describe('invalidate 失效前缀', () => {
  it('invalidateExecutorData: 只失效 executors + metrics，不碰 tasks/executions', async () => {
    const qc = newClient();
    seedAllFaces(qc);
    await invalidateExecutorData(qc);
    expect(qc.getQueryState(queryKeys.executors.all)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(queryKeys.metrics.all)?.isInvalidated).toBe(true);
    // NETOPT-D P3-4: 删除/下线执行器不改任务定义与执行行——tasks/executions
    // 面不得被标记 stale（回归：把 tasks.all 加回此函数即红）。
    expect(qc.getQueryState(queryKeys.tasks.all)?.isInvalidated).toBe(false);
    expect(qc.getQueryState(queryKeys.tasks.list({ page: 1, pageSize: 20 }))?.isInvalidated).toBe(false);
    expect(qc.getQueryState(queryKeys.executions.all)?.isInvalidated).toBe(false);
  });

  it('invalidateTaskData: 失效 tasks + executions + metrics 全三面', async () => {
    const qc = newClient();
    seedAllFaces(qc);
    await invalidateTaskData(qc);
    expect(qc.getQueryState(queryKeys.tasks.all)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(queryKeys.tasks.list({ page: 1, pageSize: 20 }))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(queryKeys.executions.all)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(queryKeys.metrics.all)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(queryKeys.executors.all)?.isInvalidated).toBe(false);
  });

  it('invalidateExecutionData: 失效 executions + metrics，不碰 tasks/executors', async () => {
    const qc = newClient();
    seedAllFaces(qc);
    await invalidateExecutionData(qc);
    expect(qc.getQueryState(queryKeys.executions.all)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(queryKeys.metrics.all)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(queryKeys.tasks.all)?.isInvalidated).toBe(false);
    expect(qc.getQueryState(queryKeys.executors.all)?.isInvalidated).toBe(false);
  });
});
