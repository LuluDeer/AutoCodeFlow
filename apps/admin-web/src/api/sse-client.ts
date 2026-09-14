/**
 * F-08（DEEP_REVIEW 0ef3bbe）：统一 SSE 客户端工厂。
 *
 * 此前全站存在三套近乎逐字重复的 SSE 实现：
 *  - hooks/useMetricsStream.ts（默认 message 帧 → 写 queryClient 缓存）
 *  - hooks/useExecutionsStream.ts（具名事件帧 → invalidate 列表）
 *  - pages/ExecutionDetailPage.tsx（日志流，onmessage + done/error 具名帧）
 * 三者各自维护「连接 / 退避重连 / 畸形帧忽略 / 卸载清理」逻辑，退避函数两份
 * 逐字重复。本工厂把连接生命周期收敛为单一点：
 *  - token 注入仍由调用方经 buildSseUrl 完成（F-05 安全取舍在 api/sse.ts 记录）；
 *  - 本工厂只负责：建连、onopen 重置退避、断线退避重建（指数退避封顶）、
 *    具名/默认帧分发、close 时关流 + 清定时器。
 * 消费方只写「事件语义」（onMessage / events / onStatus），不再各自实现重连。
 */

import { buildSseUrl, fetchSseTicket } from './sse';

export type SseClientStatus = 'connecting' | 'live' | 'reconnecting';

/**
 * 重连退避节奏：3s 起步，每次翻倍，封顶 30s。
 * 全站唯一一份（F-08）；旧导出 reconnectBackoffMs / executionsReconnectBackoffMs
 * 以别名 re-export 保留既有测试锚定。
 */
export function sseReconnectBackoffMs(
  attempt: number,
  base = 3_000,
  cap = 30_000,
): number {
  const ms = base * 2 ** Math.max(0, attempt);
  return Math.min(ms, cap);
}

export interface CreateSseClientOptions {
  /** SSE 基地址（不含尾斜杠），与 axios client 同源 */
  baseUrl: string;
  /** SSE 路径，如 /metrics/stream */
  path: string;
  /**
   * 换票函数（可注入，测试桩用）。默认走 `POST /auth/sse-ticket`：
   * A5 之后 access token 不再进 URL，建流前现换一枚 30s 的专用票据。
   */
  fetchTicket?: () => Promise<string>;
  /** 默认 message 帧回调 */
  onMessage?: (e: MessageEvent) => void;
  /** 具名 SSE 事件帧（如 done / execution.completed） */
  events?: Record<string, (e: MessageEvent) => void>;
  /** 连接状态回调（connecting/live/reconnecting） */
  onStatus?: (s: SseClientStatus) => void;
  /** 断线是否自动退避重连，默认 true；false 时断线即停（交由轮询兜底） */
  reconnect?: boolean;
  /** 退避起步 ms（默认 3000） */
  base?: number;
  /** 退避上限 ms（默认 30000） */
  cap?: number;
}

export interface SseClient {
  /** 关闭连接并停止后续重连（幂等） */
  close: () => void;
}

/**
 * 创建一个自管理的 SSE 客户端。返回 close() 供调用方在 effect cleanup 中释放。
 * 浏览器环境无 EventSource（jsdom/旧浏览器）时静默降级为 no-op。
 */
export function createSseClient(options: CreateSseClientOptions): SseClient {
  const {
    baseUrl,
    path,
    fetchTicket = fetchSseTicket,
    onMessage,
    events,
    onStatus,
    reconnect = true,
    base,
    cap,
  } = options;

  if (typeof EventSource === 'undefined') {
    onStatus?.('connecting');
    return { close() {} };
  }

  let closed = false;
  let es: EventSource | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  /** 换票失败或断线后的统一退避重试（A5：换票是一次网络请求，可能失败）。 */
  const scheduleReconnect = () => {
    if (closed) return;
    if (!reconnect) {
      onStatus?.('reconnecting');
      return;
    }
    const delay = sseReconnectBackoffMs(attempt, base, cap);
    attempt += 1;
    onStatus?.('reconnecting');
    clearTimer();
    timer = setTimeout(() => void connect(), delay);
  };

  const connect = async () => {
    if (closed) return;
    onStatus?.(attempt === 0 ? 'connecting' : 'reconnecting');

    // A5：每次建流（含重连）都现换一枚 30s 票据——票据短效，不能复用旧值。
    let ticket: string;
    try {
      ticket = await fetchTicket();
    } catch {
      // 换票失败（401 / 网络 / 后端未就绪）与断线同处理：退避重连。
      scheduleReconnect();
      return;
    }
    // 换票期间被 close（组件卸载）→ 丢弃票据，不再建流。
    if (closed) return;

    es = new EventSource(buildSseUrl(baseUrl, path, ticket));

    es.onopen = () => {
      attempt = 0;
      onStatus?.('live');
    };

    if (onMessage) {
      es.onmessage = onMessage;
    }
    if (events) {
      for (const [name, handler] of Object.entries(events)) {
        es.addEventListener(name, handler);
      }
    }

    es.onerror = () => {
      es?.close();
      es = null;
      scheduleReconnect();
    };
  };

  void connect();

  return {
    close() {
      closed = true;
      clearTimer();
      es?.close();
      es = null;
    },
  };
}
