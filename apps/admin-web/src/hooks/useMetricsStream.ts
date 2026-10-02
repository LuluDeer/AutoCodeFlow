/**
 * UI-14 第一阶段：Dashboard 汇总流客户端（GET /metrics/stream）。
 *
 * 与 ExecutionDetailPage 的日志流消费同款模式（EventSource + ?ticket= 短效票据（A5）
 * 查询串回退——jwt.strategy 白名单含 /metrics/stream），差异点：
 * - 长驻连接：Dashboard 挂载期间常开，非 running 态条件建立；
 * - 自动重连：EventSource 原生 onerror 后浏览器会自动重连，但 token 过期等
 *   永久失败场景下会无限失败轮转——这里断开后按退避节奏手动重建（3s×2^n
 *   封顶 30s），并暴露连接状态（connecting/live/reconnecting）供页面状态点；
 * - 快照写 queryClient 缓存（setQueryData 到 metrics.summary 等 queryKey），
 *   与 ARCH-26 的 useMetricsSummary 等 hooks 共享缓存——SSE 活跃时轮询空转
 *   （staleTime 内不重取），断线时 hooks 自动退化为其自身的请求节奏。
 */
import { QueryClientContext } from '@tanstack/react-query';
import { useContext, useEffect, useState, useSyncExternalStore } from 'react';

import { getApiBaseUrl } from '../api/client';
import { createSseClient, sseReconnectBackoffMs, SSE_STATUS_KEYS } from '../api/sse-client';
import { useAuthStore } from '../store/auth';
import { queryKeys } from '../api/queries';

export type MetricsStreamStatus = 'connecting' | 'live' | 'reconnecting';

/** metrics/stream 快照载荷（与 admin-api MetricsStreamController 对齐） */
export interface MetricsStreamSnapshot {
  summary: Record<string, unknown> | null;
  executors: Array<Record<string, unknown>> | null;
  scheduler: Record<string, unknown> | null;
  errors: string[];
}

// F-08（DEEP_REVIEW 0ef3bbe）：退避逻辑已收敛到 api/sse-client.ts 的
// sseReconnectBackoffMs；此处 re-export 仅保留既有测试锚定（原函数签名不变）。
export const reconnectBackoffMs = sseReconnectBackoffMs;

// ── A-4（审计降级黑洞）：查询降级面 ──────────────────────────────────────
// 后端任一快照查询失败会发具名 error 帧（metrics-stream.controller.ts 的
// send(payload, "error")），快照体也自带 errors 数组。此前 hook 只注册默认
// onmessage——具名 error 帧在 EventSource 层被静默丢弃（sse-client 仅在有
// events 映射时 addEventListener），叠加 queries.ts 的「live 停轮询」
// （sseFallbackRefetchInterval），Dashboard 会无限陈旧还显示「实时」。
// 降级标志以模块级最小 store 承载：useMetricsStream 保持既有 string 返回值
// （useExecutorLive 等既有消费方不受扰），降级面经独立的
// useMetricsStreamDegraded() 订阅（useSyncExternalStore）。
let metricsStreamDegraded = false;
const degradedListeners = new Set<() => void>();

const setStreamDegraded = (v: boolean) => {
  if (metricsStreamDegraded === v) return;
  metricsStreamDegraded = v;
  for (const l of [...degradedListeners]) l();
};

function subscribeStreamDegraded(listener: () => void): () => void {
  degradedListeners.add(listener);
  return () => {
    degradedListeners.delete(listener);
  };
}

/** A-4：Dashboard 降级角标数据源——最近一次 metrics/stream 快照是否查询降级 */
export function useMetricsStreamDegraded(): boolean {
  return useSyncExternalStore(subscribeStreamDegraded, () => metricsStreamDegraded);
}

/** A-4：metrics/stream 降级段名 → queryClient 缓存键（与 onMessage 写入面同源） */
const STREAM_SEGMENT_QUERY_KEYS: Record<string, readonly unknown[]> = {
  summary: queryKeys.metrics.summary,
  executors: queryKeys.metrics.executorStats,
  scheduler: queryKeys.metrics.scheduler,
};

interface UseMetricsStreamOptions {
  /** SSE 挂载开关（如登录后才连接）；默认 true */
  enabled?: boolean;
}

/**
 * 连接 GET /metrics/stream，把推送的快照直接写入 queryClient 缓存。
 * 返回连接状态（Dashboard 连接状态点消费）。
 */
export function useMetricsStream({ enabled = true }: UseMetricsStreamOptions = {}): MetricsStreamStatus {
  // F-09（DEEP_REVIEW 0ef3bbe）：用 useContext(QueryClientContext) 替代 useQueryClient()
  // ——后者在无 Provider 时直接 throw，会让无 Provider 的测试裸渲染崩溃。useContext
  // 缺席返回 undefined（无 throw），下方 enabled 门控保证不写缓存。
  const queryClient = useContext(QueryClientContext);
  const token = useAuthStore((s) => s.token);
  const [status, setStatus] = useState<MetricsStreamStatus>('connecting');

  useEffect(() => {
    if (!enabled || !queryClient) {
      setStatus('connecting');
      return;
    }

    const client = createSseClient({
      baseUrl: getApiBaseUrl(),
      path: '/metrics/stream',
      // NETOPT-DEBT：登记到全局状态注册表——queries.ts 的 metrics summary/
      // executorStats/scheduler 三处函数式 refetchInterval 据此「live 停轮询」。
      statusKey: SSE_STATUS_KEYS.metricsStream,
      onStatus: setStatus,
      onMessage: (e) => {
        try {
          const snap = JSON.parse(e.data) as MetricsStreamSnapshot;
          // A-4：快照自带 errors 数组——以此同步降级标志（恢复即清除，
          // 与具名 error 帧的置位形成对称闭环）。
          setStreamDegraded(snap.errors.length > 0);
          if (snap.summary !== undefined && snap.summary !== null) {
            queryClient.setQueryData(queryKeys.metrics.summary, snap.summary);
          }
          if (snap.executors !== undefined && snap.executors !== null) {
            queryClient.setQueryData(queryKeys.metrics.executorStats, snap.executors);
          }
          if (snap.scheduler !== undefined && snap.scheduler !== null) {
            queryClient.setQueryData(queryKeys.metrics.scheduler, snap.scheduler);
          }
        } catch {
          /* 忽略畸形帧（与日志流消费同策略） */
        }
      },
      events: {
        // A-4：具名 error 帧 = 本拍快照查询降级（失败段在紧随其后的快照体
        // 中为 null、旧缓存保留）。置降级标志 + 对失败段各触发一次 refetch
        // ——live 期间 refetchInterval=false（sseFallbackRefetchInterval），
        // 不主动补拉的话失败段会陈旧到下一拍恢复为止。
        error: (e) => {
          setStreamDegraded(true);
          let failed: string[] = [];
          try {
            const payload = JSON.parse(e.data) as { failed?: unknown };
            if (Array.isArray(payload.failed)) {
              failed = payload.failed.filter((s): s is string => typeof s === 'string');
            }
          } catch {
            /* 畸形帧按整体降级处理（failed 保持空，仅置标志） */
          }
          for (const segment of failed) {
            const key = STREAM_SEGMENT_QUERY_KEYS[segment];
            if (key) void queryClient.refetchQueries({ queryKey: key });
          }
        },
      },
    });

    return () => {
      client.close();
      // A-4：连接生命周期结束（卸载/重挂载）→ 降级标志复位，避免残留的
      // 「数据延迟」角标跨连接存留（重连后由第一拍快照重新置位）。
      setStreamDegraded(false);
    };
  }, [enabled, token, queryClient]);

  return status;
}
