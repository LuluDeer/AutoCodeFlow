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
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { getApiBaseUrl } from '../api/client';
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

/** 重连退避节奏：3s 起步，每次翻倍，封顶 30s（纯函数导出可测） */
export function reconnectBackoffMs(attempt: number, base = 3_000, cap = 30_000): number {
  const ms = base * 2 ** Math.max(0, attempt);
  return Math.min(ms, cap);
}

interface UseMetricsStreamOptions {
  /** SSE 挂载开关（如登录后才连接）；默认 true */
  enabled?: boolean;
}

/**
 * 连接 GET /metrics/stream，把推送的快照直接写入 queryClient 缓存。
 * 返回连接状态（Dashboard 连接状态点消费）。
 */
export function useMetricsStream({ enabled = true }: UseMetricsStreamOptions = {}): MetricsStreamStatus {
  const queryClient = useQueryClient();
  const token = useAuthStore((s) => s.token);
  const [status, setStatus] = useState<MetricsStreamStatus>('connecting');
  const attemptRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) {
      setStatus('connecting');
      return;
    }

    let closed = false;
    let es: EventSource | null = null;

    const connect = () => {
      if (closed) return;
      setStatus(attemptRef.current === 0 ? 'connecting' : 'reconnecting');
      const base = getApiBaseUrl().replace(/\/$/, '');
      const url = `${base}/metrics/stream${token ? `?access_token=${encodeURIComponent(token)}` : ''}`;
      es = new EventSource(url);

      es.onopen = () => {
        attemptRef.current = 0;
        setStatus('live');
      };

      es.onmessage = (e) => {
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
      };

      const handleError = () => {
        es?.close();
        es = null;
        if (closed) return;
        // 退避重建：attempt 递增，成功 onopen 后归零
        const delay = reconnectBackoffMs(attemptRef.current);
        attemptRef.current += 1;
        setStatus('reconnecting');
        timerRef.current = setTimeout(connect, delay);
      };
      es.onerror = handleError;
    };

    connect();

    return () => {
      closed = true;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      es?.close();
      es = null;
    };
  }, [enabled, token, queryClient]);

  return status;
}
