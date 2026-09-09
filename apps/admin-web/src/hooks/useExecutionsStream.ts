/**
 * FEAT-16：执行列表终态推送流客户端（GET /executions/stream）。
 *
 * 与 useMetricsStream（UI-14）同款模式：EventSource + ?access_token= 查询串
 * 回退（jwt.strategy 白名单含 /executions/stream）、断线 3s×2^n 封顶 30s
 * 手动重建、连接状态外露。差异点：
 * - 事件驱动：服务端按领域事件名（execution.completed/failed/killed）发
 *   具名 SSE event 帧（非默认 message 帧），客户端 addEventListener 消费；
 * - 消费动作 = invalidate Executions 列表 + Dashboard 汇总缓存
 *   （invalidateExecutionData）——列表页数据形状是「分页+筛选后的行集」，
 *   终态载荷只有单行 id 级信息，无法 setQueryData 精准改写任意筛选下的
 *   行集，invalidate（标记 stale → 活跃 observer 立即重取）是正确粒度；
 *   终态事件到 invalidate 重取完成通常 <1s（本地 DB 单查询），满足
 *   「终态刷新 <3s」验收。
 * - 与 15s 轮询兜底互斥共存（对齐 DashboardPage 模式）：SSE live 时轮询
 *   空转（invalidate 已即时刷新，轮询 refetch 在 staleTime 内被去重），
 *   断线时轮询自动成为唯一新鲜度来源。
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { getApiBaseUrl } from '../api/client';
import { useAuthStore } from '../store/auth';
import { invalidateExecutionData } from '../api/queries';

export type ExecutionsStreamStatus = 'connecting' | 'live' | 'reconnecting';

/** 重连退避节奏：3s 起步，每次翻倍，封顶 30s（纯函数导出可测） */
export function executionsReconnectBackoffMs(
  attempt: number,
  base = 3_000,
  cap = 30_000,
): number {
  const ms = base * 2 ** Math.max(0, attempt);
  return Math.min(ms, cap);
}

/** 执行终态事件名（与 admin-api DOMAIN_EVENTS 对齐，SSE event 名即事件名） */
export const EXECUTION_TERMINAL_EVENTS = [
  'execution.completed',
  'execution.failed',
  'execution.killed',
] as const;

export type ExecutionTerminalEventName =
  (typeof EXECUTION_TERMINAL_EVENTS)[number];

/** 终态事件载荷（与 admin-api ExecutionTerminalEventPayload 对齐，宽式接收） */
export interface ExecutionTerminalEventFrame {
  executionId: string;
  taskId?: string | null;
  taskName?: string;
  status?: string;
  finishedAt?: string;
}

interface UseExecutionsStreamOptions {
  /** SSE 挂载开关（如登录后才连接）；默认 true */
  enabled?: boolean;
}

/**
 * 连接 GET /executions/stream，把推送的执行终态事件转为 Executions 列表 +
 * Dashboard 汇总缓存失效。返回连接状态（页面状态点消费）。
 */
export function useExecutionsStream({
  enabled = true,
}: UseExecutionsStreamOptions = {}): ExecutionsStreamStatus {
  const queryClient = useQueryClient();
  const token = useAuthStore((s) => s.token);
  const [status, setStatus] = useState<ExecutionsStreamStatus>('connecting');
  const attemptRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // jsdom/旧环境无 EventSource（测试裸渲染页面时）静默降级为纯轮询——
    // 与 useExecutorLive 的 canStream 探测同语义，页面测试无需逐个 stub。
    if (!enabled || typeof EventSource === 'undefined') {
      setStatus('connecting');
      return;
    }

    let closed = false;
    let es: EventSource | null = null;

    const connect = () => {
      if (closed) return;
      setStatus(attemptRef.current === 0 ? 'connecting' : 'reconnecting');
      const base = getApiBaseUrl().replace(/\/$/, '');
      const url = `${base}/executions/stream${token ? `?access_token=${encodeURIComponent(token)}` : ''}`;
      es = new EventSource(url);

      es.onopen = () => {
        attemptRef.current = 0;
        setStatus('live');
      };

      // 具名事件帧：三个终态事件共用同一消费动作（invalidate 列表+汇总面）
      const onTerminalEvent = () => {
        void invalidateExecutionData(queryClient);
      };
      for (const name of EXECUTION_TERMINAL_EVENTS) {
        es.addEventListener(name, onTerminalEvent);
      }

      const handleError = () => {
        es?.close();
        es = null;
        if (closed) return;
        // 退避重建：attempt 递增，成功 onopen 后归零
        const delay = executionsReconnectBackoffMs(attemptRef.current);
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
