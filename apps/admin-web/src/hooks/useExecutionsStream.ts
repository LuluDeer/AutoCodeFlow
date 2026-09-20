/**
 * FEAT-16：执行列表终态推送流客户端（GET /executions/stream）。
 *
 * 与 useMetricsStream（UI-14）同款模式：EventSource + ?ticket= 短效票据（A5）
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
import { QueryClientContext } from '@tanstack/react-query';
import { useContext, useEffect, useState } from 'react';

import { getApiBaseUrl } from '../api/client';
import { createSseClient, sseReconnectBackoffMs } from '../api/sse-client';
import { useAuthStore } from '../store/auth';
import { invalidateExecutionData } from '../api/queries';

export type ExecutionsStreamStatus = 'connecting' | 'live' | 'reconnecting';

// F-08（DEEP_REVIEW 0ef3bbe）：退避收敛到 api/sse-client.ts；此处 re-export
// 仅保留既有测试锚定（原函数签名 executionsReconnectBackoffMs 不变）。
export const executionsReconnectBackoffMs = sseReconnectBackoffMs;

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
  // F-09（DEEP_REVIEW 0ef3bbe）：useContext(QueryClientContext) 替代 useQueryClient()——
  // 无 Provider 时返回 undefined 不 throw；下方 enabled/空值守卫保证不写缓存。
  const queryClient = useContext(QueryClientContext);
  const token = useAuthStore((s) => s.token);
  const [status, setStatus] = useState<ExecutionsStreamStatus>('connecting');

  useEffect(() => {
    // jsdom/旧环境无 EventSource（测试裸渲染页面时）静默降级为纯轮询——
    // createSseClient 内部已做 EventSource 可用性检测。
    if (!enabled || !queryClient) {
      setStatus('connecting');
      return;
    }

    // NETOPT-D P3-3: 合并窗去抖——终态突发（批量 kill / 批量恢复 / 高吞吐
    // 任务流）时一帧一次 invalidate 会触发连续重取风暴；200ms 内事件合并为
    // 一次。终态刷新 <3s 验收不受影响（200ms 远小于验收窗口）。
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    // 具名事件帧：三个终态事件共用同一消费动作（invalidate 列表+汇总面）
    const onTerminalEvent = () => {
      if (debounceTimer) return;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void invalidateExecutionData(queryClient);
      }, 200);
    };
    const events = Object.fromEntries(
      EXECUTION_TERMINAL_EVENTS.map((name) => [name, onTerminalEvent]),
    );

    const client = createSseClient({
      baseUrl: getApiBaseUrl(),
      path: '/executions/stream',
      onStatus: setStatus,
      events,
    });

    return () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      client.close();
    };
  }, [enabled, token, queryClient]);

  return status;
}
