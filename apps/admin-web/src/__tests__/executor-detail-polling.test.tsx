/**
 * P1-23（UX-AUDIT-2026-09-21）：执行器详情必须轮询，否则状态是冻结快照。
 *
 * ## 这条守的是什么
 *
 * `useExecutorDetail` 此前**没有** `refetchInterval`（紧挨着的 `useExecutorMetrics`
 * 有），于是 `status` / `lastHeartbeat` 只来自进入页面那一次拉取：
 *   · 节点刚死 → 页面可以永远显示"在线"；
 *   · 节点已恢复 → 页面永远显示"离线"，心跳 tooltip 冻在旧时刻。
 *
 * 而用户打开详情页**恰恰是为了诊断这台执行器**——读到的可能是几小时前的状态。
 * 更糟的是页面自己还渲染着「每 30s 轮询」的文案（`executorDetail.live.pollInterval`），
 * 与实际行为相反：**界面承诺了一个它没有做的事**。
 *
 * ## 断言策略
 *
 * 直接断言 hook 传给 react-query 的配置——这是缺陷本体。同时钉住"与 metrics 同频"，
 * 避免同屏两个数据源互相矛盾（一个刷新、一个冻结）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

vi.mock('../api/executors', () => ({
  executorsApi: {
    get: vi.fn().mockResolvedValue({ id: 'e1', status: 'online' }),
    getMetrics: vi.fn().mockResolvedValue({}),
    list: vi.fn().mockResolvedValue([]),
  },
}));

import { useExecutorDetail, useExecutorMetrics } from '../api/queries';
import { executorsApi } from '../api/executors';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: undefined } },
  });
  return createElement(QueryClientProvider, { client: qc }, children);
}

beforeEach(() => {
  vi.mocked(executorsApi.get).mockClear();
});

describe('P1-23: 执行器详情的轮询', () => {
  it('useExecutorDetail 配置了 refetchInterval（状态不再冻结）', async () => {
    // 通过实际行为反证：以 30s 为间隔轮询时，用假定时器推进即可观察到第二次拉取。
    // 这里先断言"能拿到数据"，再用定时器推进验证真的会 refetch。
    vi.useFakeTimers();
    try {
      renderHook(() => useExecutorDetail('e1'), { wrapper });
      await vi.waitFor(() => expect(executorsApi.get).toHaveBeenCalledTimes(1));

      // 推进 30s —— 有 refetchInterval 才会出现第二次调用
      // act 包裹：refetch 触发的 query state 更新必须在 act 内刷新，否则告警
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      await vi.waitFor(() =>
        expect(vi.mocked(executorsApi.get).mock.calls.length).toBeGreaterThan(1),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('详情与 metrics 的轮询频率一致（同屏两个数据源不得一刷新一冻结）', async () => {
    vi.useFakeTimers();
    try {
      renderHook(
        () => {
          useExecutorDetail('e1');
          useExecutorMetrics('e1');
        },
        { wrapper },
      );
      await vi.waitFor(() => expect(executorsApi.get).toHaveBeenCalled());

      const afterFirst = {
        detail: vi.mocked(executorsApi.get).mock.calls.length,
        metrics: vi.mocked(executorsApi.getMetrics).mock.calls.length,
      };
      expect(afterFirst.detail).toBe(1);
      expect(afterFirst.metrics).toBe(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      await vi.waitFor(() => {
        // 两者都必须刷新——若只有 metrics 刷新，页面会显示"状态几小时前 + 指标刚刚"，
        // 用户无法判断到底哪个可信
        expect(vi.mocked(executorsApi.get).mock.calls.length).toBeGreaterThan(1);
        expect(vi.mocked(executorsApi.getMetrics).mock.calls.length).toBeGreaterThan(1);
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
