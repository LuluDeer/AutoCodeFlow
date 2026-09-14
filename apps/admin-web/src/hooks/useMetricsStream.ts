/**
 * UI-14 第一阶段：Dashboard 汇总流客户端（GET /metrics/stream）。
 *
 * 与 ExecutionDetailPage 的日志流消费同款模式（EventSource + ?access_token=
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
import { useContext, useEffect, useState } from 'react';

import { getApiBaseUrl } from '../api/client';
import { createSseClient, sseReconnectBackoffMs } from '../api/sse-client';
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
      token,
      onStatus: setStatus,
      onMessage: (e) => {
        try {
          const snap = JSON.parse(e.data) as MetricsStreamSnapshot;
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
    });

    return () => client.close();
  }, [enabled, token, queryClient]);

  return status;
}
