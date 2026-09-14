/**
 * UI-07 ④：执行器列表页实时状态 —— 复用 /metrics/stream 的 executors 段。
 *
 * 决策（缩范围声明）：不新增 /executors/stream 逐执行器心跳端点——UI-14 的
 * GET /metrics/stream 已按 3s 推送 getExecutorStats 快照（每执行器 id/appName/
 * address/status/cpuUsage/memUsage/runningTaskCount/lastHeartbeat），字段足以
 * 支撑列表页状态/CPU/内存实时刷新；零 admin-api 改动（避让 002/AUTH-05 的
 * executor.controller 足迹）。
 *
 * 实现：页面侧以 useRequest(30s 轮询) 为数据源，本 hook 输出「流覆盖之上的
 * 合并列表 + 连接状态」。流快照由 useMetricsStream 写入 queryClient 缓存
 * （queryKeys.metrics.executorStats），本 hook 以**命令式缓存订阅**（useState
 * + useEffect + getQueryCache().subscribe）同 key——流 setQueryData 时组件自动
 * 重渲染。合并规则：流值优先、字段级类型守卫回退轮询值；流断线时覆盖层停在
 * 最后快照、轮询继续兜底——list 接口始终是数据事实源，SSE 只做覆盖加速。
 *
 * F-09（DEEP_REVIEW 0ef3bbe）：移除条件 hooks。
 * 旧实现用 `if (!canStream) { useMemo(...) return ... }` 在分支里调用 hooks、
 * 再在分支后调用 useQuery/useMetricsStream——违反 Rules of Hooks（曾用 4 处
 * eslint-disable 压制）。现改为：**所有 hooks 无条件、按固定顺序调用**，Provider
 * 缺席（useContext(QueryClientContext) 返回 undefined，无 throw）时把 Query
 * 订阅与 SSE 统一按 enabled=false 静默——不再有任何 if 包裹的 hook，删除全部
 * eslint-disable。
 *  - useContext 直读公开 QueryClientContext：缺席返回 undefined，不 throw；
 *  - 命令式订阅替代 useQuery（useQuery 内部 useQueryClient 无 Provider 会 throw）；
 *  - useMetricsStream 已改为 useContext 探测（无 Provider 安全），故可无条件调用。
 */
import { useContext, useEffect, useMemo, useState } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import type { Executor } from '../api/executors';
import { queryKeys } from '../api/queries';
import { useMetricsStream } from './useMetricsStream';
import type { MetricsStreamStatus } from './useMetricsStream';

/** metrics/stream executors 段的概要字段（getExecutorStats 返回子集，宽式接收） */
export interface ExecutorStreamStat {
  id: string;
  status?: string;
  cpuUsage?: number | null;
  memUsage?: number | null;
  runningTaskCount?: number | null;
  lastHeartbeat?: string | null;
}

/**
 * 从流快照构造「最新执行器概要 map」（id → 概要）。
 * 纯函数导出可测：畸形行（无 id）/非数组一律跳过。
 */
export function executorStatsToMap(
  stats: unknown,
): Record<string, ExecutorStreamStat> {
  const map: Record<string, ExecutorStreamStat> = {};
  if (!Array.isArray(stats)) return map;
  for (const row of stats) {
    if (row && typeof row === 'object' && typeof (row as ExecutorStreamStat).id === 'string') {
      const s = row as ExecutorStreamStat;
      map[s.id] = s;
    }
  }
  return map;
}

/**
 * 用流快照覆盖轮询列表：仅覆盖流里存在的同 id 字段（且流值类型正确）。
 * 流里不存在的执行器原样保留轮询值（list 接口是 status 语义的事实源，
 * 流只加速刷新）。纯函数导出可测。
 */
export function mergeStreamOverlay(
  executors: Executor[],
  overlay: Record<string, ExecutorStreamStat>,
): Executor[] {
  if (Object.keys(overlay).length === 0) return executors;
  return executors.map((ex) => {
    const s = overlay[ex.id];
    if (!s) return ex;
    return {
      ...ex,
      status: typeof s.status === 'string' ? s.status : ex.status,
      cpuUsage: typeof s.cpuUsage === 'number' ? s.cpuUsage : ex.cpuUsage,
      memUsage: typeof s.memUsage === 'number' ? s.memUsage : ex.memUsage,
      runningTaskCount:
        typeof s.runningTaskCount === 'number' ? s.runningTaskCount : ex.runningTaskCount,
      lastHeartbeat: typeof s.lastHeartbeat === 'string' ? s.lastHeartbeat : ex.lastHeartbeat,
    };
  });
}

export interface UseExecutorLiveResult {
  /** 合并后的列表（流覆盖之上）——页面渲染唯一数据源 */
  executors: Executor[];
  /** SSE 连接状态（connecting/live/reconnecting），页面状态点消费 */
  streamStatus: MetricsStreamStatus;
  /** 流是否处于 live 态（轮询降级提示用） */
  isLive: boolean;
}

/** 缓存订阅目标 key（executorStats 流快照落点） */
const STATS_KEY = queryKeys.metrics.executorStats;

/**
 * 列表页实时状态 hook（providerless 安全）：
 * 30s 轮询（ahooks useRequest，调用方持有）为数据源，/metrics/stream
 * executors 段做同 id 字段覆盖；Provider 缺席（测试裸渲染/异常环境）时
 * 原样透传轮询数据——不触碰任何 React Query hook，无 throw 路径。
 *
 * @param polled 轮询快照（executorsApi.list 结果）
 * @param enabled 流开关（默认 true）
 */
export function useExecutorLive(
  polled: Executor[] | undefined,
  enabled = true,
): UseExecutorLiveResult {
  // F-09：所有 hooks 无条件按固定顺序调用。useContext 直读 QueryClientContext，
  // 缺席返回 undefined（与 useQueryClient 的空值判定同源、无 throw）。
  const client = useContext(QueryClientContext);
  const hasProvider = client !== undefined && client !== null;
  const safePolled = useMemo(() => polled ?? [], [polled]);
  const canStream = hasProvider && enabled && typeof EventSource !== 'undefined';

  // 以命令式缓存订阅替代 useQuery({enabled:false})——useQuery 内部的
  // useQueryClient 无 Provider 会 throw；useState/useEffect 无此问题。
  const [statsCache, setStatsCache] = useState<unknown>(() =>
    hasProvider && client
      ? (client.getQueryData(STATS_KEY) as unknown)
      : undefined,
  );
  useEffect(() => {
    if (!client) return;
    setStatsCache(client.getQueryData(STATS_KEY) as unknown);
    const expected = (STATS_KEY as readonly unknown[]).join('|');
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      const k = event.query?.queryKey;
      if (Array.isArray(k) && k.join('|') === expected) {
        setStatsCache(client.getQueryData(STATS_KEY) as unknown);
      }
    });
    return unsubscribe;
  }, [client]);

  // 无条件调用 useMetricsStream；canStream=false 时其内部短路（不建流、不写缓存）。
  const streamStatus = useMetricsStream({ enabled: canStream });

  const overlay = useMemo(() => executorStatsToMap(statsCache), [statsCache]);
  const merged = useMemo(
    () => mergeStreamOverlay(safePolled, overlay),
    [safePolled, overlay],
  );

  return {
    executors: merged,
    streamStatus,
    isLive: canStream && streamStatus === 'live',
  };
}

export default useExecutorLive;
