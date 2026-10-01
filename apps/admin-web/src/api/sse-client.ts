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
 *
 * NETOPT-DEBT：另维护一份模块级连接状态注册表（statusKey → 状态），供
 * queries.ts 的函数式 refetchInterval 实现「SSE live 停轮询、断流恢复 30s
 * 兜底」——见下方注册表段注记。
 */

import { buildSseUrl, fetchSseTicket } from './sse';

export type SseClientStatus = 'connecting' | 'live' | 'reconnecting';

// ── 连接状态注册表（NETOPT-DEBT：SSE 条件轮询的事实源）────────────────────
// 此前 queries.ts 的 30s 兜底轮询无条件恒转：SSE 活跃时全是空转请求。注册表
// 按 statusKey（调用方传入，约定用流路径）记录每条流的生命周期状态，供
// queries.ts 的函数式 refetchInterval 判断「流活着（live）就不轮询」。
// 设计要点：
//  - 键由使用方显式传入（CreateSseClientOptions.statusKey）；未传（旧调用方/
//    EventSource 不可用降级）一律不登记——getSSEStatus 返回 undefined，消费方
//    视为「无流可用」保持轮询（向后兼容，行为不变）；
//  - close() 即删键（组件卸载清理登记，防泄漏）；断线走 'reconnecting'，
//    不删键——轮询与退避重连并行，正是断流兜底想要的语义；
//  - 注册表只反映「当前是否存在活跃连接生命周期」，不保存历史终态，因此
//    无需 idle/disconnected 两值（缺省即代表两者）。
const sseStatusRegistry = new Map<string, SseClientStatus>();

type SseStatusListener = (s: SseClientStatus) => void;
const sseStatusListeners = new Map<string, Set<SseStatusListener>>();

/** 读取某条流（statusKey）当前状态；未登记（旧调用方）返回 undefined。 */
export function getSSEStatus(key: string): SseClientStatus | undefined {
  return sseStatusRegistry.get(key);
}

/**
 * 订阅某条流的状态变化；返回退订函数（幂等）。
 * 供需要响应式联动的地方使用（如把状态变化接到 refetch 触发面）。
 */
export function onSSEStatusChange(
  key: string,
  listener: SseStatusListener,
): () => void {
  let set = sseStatusListeners.get(key);
  if (!set) {
    set = new Set();
    sseStatusListeners.set(key, set);
  }
  set.add(listener);
  return () => {
    const current = sseStatusListeners.get(key);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) sseStatusListeners.delete(key);
  };
}

/** 预定义 statusKey：hooks 传键、queries.ts 消费同键，防两处字符串漂移。 */
export const SSE_STATUS_KEYS = {
  /** GET /metrics/stream（useMetricsStream，Dashboard 汇总快照） */
  metricsStream: 'metrics/stream',
  /** GET /executions/stream（useExecutionsStream，执行终态事件） */
  executionsStream: 'executions/stream',
} as const;

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
  /**
   * 状态注册表键（如 '/metrics/stream'）。传入后本客户端的生命周期状态会
   * 登记（getSSEStatus 可查、close 时移除）；不传则不登记（旧调用方行为
   * 不变）。键常量用 SSE_STATUS_KEYS。
   */
  statusKey?: string;
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
    statusKey,
    reconnect = true,
    base,
    cap,
  } = options;

  // 状态登记统一出口：注册表 + 订阅者 + 调用方回调三同步。
  // EventSource 不可用（jsdom/旧浏览器）的降级路径不经过它——SSE 根本没建，
  // 不得登记任何状态（轮询兜底必须保持，见注册表设计注记）。
  const setStatus = (s: SseClientStatus) => {
    if (statusKey) {
      sseStatusRegistry.set(statusKey, s);
      const listeners = sseStatusListeners.get(statusKey);
      if (listeners) {
        for (const l of [...listeners]) l(s);
      }
    }
    onStatus?.(s);
  };

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
      setStatus('reconnecting');
      return;
    }
    const delay = sseReconnectBackoffMs(attempt, base, cap);
    attempt += 1;
    setStatus('reconnecting');
    clearTimer();
    timer = setTimeout(() => void connect(), delay);
  };

  const connect = async () => {
    if (closed) return;
    setStatus(attempt === 0 ? 'connecting' : 'reconnecting');

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
      setStatus('live');
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
      // 组件卸载清理登记（防泄漏）：注册表删键 → getSSEStatus 回 undefined，
      // 消费方（queries.ts 函数式 refetchInterval）自动恢复 30s 轮询兜底。
      if (statusKey) {
        sseStatusRegistry.delete(statusKey);
      }
    },
  };
}
