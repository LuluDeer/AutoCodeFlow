/**
 * W2（P2）：执行器流覆盖层的 liveness 门。
 *
 * 缺陷：useExecutorLive 无条件把 queryClient 缓存里最后一份 /metrics/stream
 * executors 快照合并到轮询结果之上。断流（reconnecting/connecting）后缓存**不会**
 * 被清，于是「断流那一刻 online、之后已 offline」的执行器会被旧快照盖成 online
 * ——30s 轮询拿到的新事实反而看不见，状态比断流前更不可信。ExecutorListPage 的
 * 注释一直声称「断线时覆盖层回退轮询快照」，实现里并没有这道门。
 *
 * 用例即判据：
 *  · polled status:offline + overlay 同 id status:online + **非 live** → offline；
 *  · live 时仍被覆盖（反向断言，确保没有把覆盖能力一起关死）。
 */
import { describe, it, expect } from 'vitest';
import { executorStatsToMap, liveOverlay, mergeStreamOverlay } from '../hooks/useExecutorLive';
import type { Executor } from '../api/executors';

const polled = (over: Partial<Executor> = {}): Executor => ({
  id: 'ex-1',
  appName: 'demo',
  address: '10.0.0.1:3002',
  status: 'offline',
  cpuUsage: 3,
  memUsage: 12,
  runningTaskCount: 0,
  lastHeartbeat: '2026-01-01T00:00:00Z',
  ...over,
});

const statsSnapshot = [
  { id: 'ex-1', status: 'online', cpuUsage: 55, memUsage: 66, runningTaskCount: 2 },
];

describe('W2 覆盖层 liveness 门', () => {
  it('非 live（reconnecting）→ 覆盖层整体弃用：旧快照的 online 不得盖回轮询的 offline', () => {
    const raw = executorStatsToMap(statsSnapshot);
    const merged = mergeStreamOverlay([polled()], liveOverlay(raw, 'reconnecting', true));
    expect(merged[0].status).toBe('offline');
    // 字段级也不许透出（CPU/内存同属断流时刻的旧值）
    expect(merged[0].cpuUsage).toBe(3);
    expect(merged[0].runningTaskCount).toBe(0);
  });

  it('connecting（尚未 live）同样弃用覆盖层', () => {
    const raw = executorStatsToMap(statsSnapshot);
    const merged = mergeStreamOverlay([polled()], liveOverlay(raw, 'connecting', true));
    expect(merged[0].status).toBe('offline');
  });

  it('反向断言：live 时覆盖层仍然生效（流值优先）', () => {
    const raw = executorStatsToMap(statsSnapshot);
    const merged = mergeStreamOverlay([polled()], liveOverlay(raw, 'live', true));
    expect(merged[0].status).toBe('online');
    expect(merged[0].cpuUsage).toBe(55);
  });

  it('canStream=false（无 EventSource / 未启用）时覆盖层也必须为空', () => {
    const raw = executorStatsToMap(statsSnapshot);
    expect(liveOverlay(raw, 'live', false)).toEqual({});
  });
});
