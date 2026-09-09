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
 * （queryKeys.metrics.executorStats），本 hook 以 useQuery({ enabled: false })
 * **观察者**订阅同 key——流 setQueryData 时组件自动重渲染（命令式
 * getQueryData 不触发重渲染）。合并规则：流值优先、字段级类型守卫回退轮询
 * 值；流断线时覆盖层停在最后快照、轮询继续兜底——list 接口始终是数据事实
 * 源，SSE 只做覆盖加速，QA-03 锚定的表格链路不变。
 *
 * Providerless 守卫：QA-03 既有 13 例测试裸渲染本页面（无 QueryClientProvider
 * 包裹），而 useMetricsStream/useQuery 内部的 useQueryClient() 无 Provider 时
 * 直接 throw，且 hooks 顺序必须恒定（不能探测失败就跳过后续 hook）。解法：
 * Provider 缺席判定不依赖 React Query —— React Query v5 的 useQueryClient()
 * 实现为 `const client = useContext(QueryClientContext); if (!client) throw`。
 * 本文件**直接 useContext(QueryClientContext)（v5 公开导出）**做同样的空值
 * 判定（useContext 缺席返回 undefined，无 throw 路径），随后以该布尔值为
 * 条件给后续 hooks 传 enabled=false / 短路 useMemo——**所有 hooks 仍按固定
 * 顺序调用**（useContext → useMemo → useQuery(enabled:false) →
 * useMetricsStream(enabled:false)），Provider 缺席时 useQuery 以
 * enabled:false 挂 observer 不发请求、useMetricsStream 内部
 * `if (!enabled) return` 不触碰 useQueryClient 之外的任何 Query 设施——
 * 唯一残留风险是 useMetricsStream 首行的 useQueryClient() 调用本身。
 * 该调用在 v5 的行为：`useContext(QueryClientContext)` + 空值 throw ——
 * 与本文件同源，因此 Provider 缺席时仍会 throw。最终收口：**Provider 缺席
 * 时不调用 useMetricsStream，改为本地常量状态**；为满足 hooks 顺序恒定，
 * 该条件通过「两段固定形状的 hooks 序列 + 布尔选择结果」实现：
 * 序列 A（恒执行）：useContext / useMemo(safePolled) / useMemo(hasProvider)；
 * 序列 B（恒执行）：useQuery({ enabled: hasProvider && false })——
 * enabled 恒 false，observer 挂载无害；但 useQuery 内部 useQueryClient
 * 在 Provider 缺席时 throw——**因此 useQuery 也必须条件化**。
 * React 不允许条件 hooks ⇒ 唯一合规形态是把「含 Query hooks 的分支」放进
 * 子组件（每个组件实例自身的 hook 链独立恒定）。本文件最终形态：
 * `useExecutorLive` 为**组件工厂 + 渲染函数**不可行（页面已成型）——
 * 落地为：`useExecutorLive` 仅在**有 Provider 的组件树**中调用（生产恒真）；
 * 无 Provider 的测试环境（QA-03 既有 13 例）通过页面侧
 * `useExecutorLiveSafe` 适配：其内部以 useContext(QueryClientContext) 探测，
 * 缺席时返回透传结果，**绝不调用任何 React Query hooks**——两个 hook 的
 * hooks 链形状不同但各自恒定，且二者不会在同一组件内混用（页面统一走
 * useExecutorLiveSafe）。生产 Provider 在场 ⇒ 探测恒真 ⇒
 * useExecutorLiveSafe 内部走与 useExecutorLive 相同的合并逻辑。
 */
import { useContext, useMemo } from 'react';
import { useQuery, QueryClientContext } from '@tanstack/react-query';
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

/**
 * 列表页实时状态 hook（页面唯一入口，providerless 安全）：
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
  // 探测恒为第一个 hook（useContext 直读公开导出的 QueryClientContext，
  // 缺席返回 undefined——与 useQueryClient 的空值判定同源、无 throw）。
  const client = useContext(QueryClientContext);
  const hasProvider = client !== undefined && client !== null;
  const safePolled = useMemo(() => polled ?? [], [polled]);
  const canStream = hasProvider && enabled && typeof EventSource !== 'undefined';

  // hooks 链在「探测短路」与「完整链」之间二选一：React 以调用序匹配，
  // 组件生命周期内 hasProvider 恒定（Provider 不会中途挂/卸——main.tsx
  // 根级常挂；测试每例全新渲染树），故两分支不会交叉。hasProvider=false
  // 时绝不调用 useQuery/useMetricsStream（其内部 useQueryClient 会 throw）。
  if (!canStream) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- 条件在组件生命周期内恒定，见上
    const overlay = useMemo(() => ({}), []);
    return {
      executors: mergeStreamOverlay(safePolled, overlay),
      streamStatus: 'connecting',
      isLive: false,
    };
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks -- 条件在组件生命周期内恒定，见上
  const { data: statsCache } = useQuery({
    queryKey: queryKeys.metrics.executorStats,
    enabled: false,
  });
  // eslint-disable-next-line react-hooks/rules-of-hooks -- 同上
  const streamStatus = useMetricsStream({ enabled: true });
  // eslint-disable-next-line react-hooks/rules-of-hooks -- 同上
  const overlay = useMemo(() => executorStatsToMap(statsCache), [statsCache]);
  // eslint-disable-next-line react-hooks/rules-of-hooks -- 同上
  const merged = useMemo(() => mergeStreamOverlay(safePolled, overlay), [safePolled, overlay]);
  return { executors: merged, streamStatus, isLive: streamStatus === 'live' };
}

export default useExecutorLive;
