/**
 * NETOPT-DEBT：SSE 连接状态注册表专项（api/sse-client.ts）。
 *
 * 此前 queries.ts 的 30s 兜底轮询无条件恒转，上轮审计确认 sse-client 无全局
 * 状态可查而搁置。本轮注册表落地，本文件钉住五条行为：
 *
 *   ① 建流登记：statusKey 传入后生命周期状态可查（connecting → live）；
 *   ② 断线不删键：转 reconnecting——轮询兜底与退避重连并行正是兜底语义；
 *   ③ close 移除登记：组件卸载清理（防泄漏），消费方自动恢复轮询；
 *   ④ 向后兼容：未传 statusKey（旧调用方）/ EventSource 不可用降级，一律
 *      不登记（getSSEStatus 返回 undefined → 轮询保持）；
 *   ⑤ onSSEStatusChange 订阅/退订 + 多键互不干扰。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createSseClient,
  getSSEStatus,
  onSSEStatusChange,
  SSE_STATUS_KEYS,
} from '../api/sse-client';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  onopen?: () => void;
  onerror?: () => void;
  onmessage?: (e: unknown) => void;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener() {}
  close() {
    this.closed = true;
  }
}

/** 冲刷已 resolve 的 promise 链（换票是异步的）。 */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('SSE 连接状态注册表（条件轮询事实源）', () => {
  it('① 建流登记：换票建流后 connecting，onopen 转 live', async () => {
    const client = createSseClient({
      baseUrl: 'http://api',
      path: '/metrics/stream',
      statusKey: SSE_STATUS_KEYS.metricsStream,
      fetchTicket: async () => 't-1',
      reconnect: false,
    });
    await flush();
    expect(getSSEStatus(SSE_STATUS_KEYS.metricsStream)).toBe('connecting');
    FakeEventSource.instances[0].onopen?.();
    expect(getSSEStatus(SSE_STATUS_KEYS.metricsStream)).toBe('live');
    client.close();
  });

  it('② 断线不删键：转 reconnecting（轮询兜底与退避重连并行）', async () => {
    const client = createSseClient({
      baseUrl: 'http://api',
      path: '/metrics/stream',
      statusKey: SSE_STATUS_KEYS.metricsStream,
      fetchTicket: async () => 't-1',
      reconnect: false,
    });
    await flush();
    FakeEventSource.instances[0].onopen?.();
    FakeEventSource.instances[0].onerror?.();
    // 断流 ≠ 生命周期结束：键仍在，值转 reconnecting → 轮询兜底即刻恢复
    expect(getSSEStatus(SSE_STATUS_KEYS.metricsStream)).toBe('reconnecting');
    client.close();
  });

  it('③ close 移除登记（组件卸载清理，防泄漏 → 消费方恢复轮询）', async () => {
    const client = createSseClient({
      baseUrl: 'http://api',
      path: '/metrics/stream',
      statusKey: SSE_STATUS_KEYS.metricsStream,
      fetchTicket: async () => 't-1',
      reconnect: false,
    });
    await flush();
    FakeEventSource.instances[0].onopen?.();
    expect(getSSEStatus(SSE_STATUS_KEYS.metricsStream)).toBe('live');

    client.close();
    expect(getSSEStatus(SSE_STATUS_KEYS.metricsStream)).toBeUndefined();
  });

  it('④a 未传 statusKey 不登记（旧调用方向后兼容）', async () => {
    createSseClient({
      baseUrl: 'http://api',
      path: '/metrics/stream',
      fetchTicket: async () => 't-1',
      reconnect: false,
    });
    await flush();
    FakeEventSource.instances[0].onopen?.();
    // 无论按路径还是任意键查，注册表都不应有登记
    expect(getSSEStatus(SSE_STATUS_KEYS.metricsStream)).toBeUndefined();
    expect(getSSEStatus('/metrics/stream')).toBeUndefined();
  });

  it('④b EventSource 不可用降级不登记（轮询兜底必须保持）', async () => {
    vi.unstubAllGlobals(); // jsdom 本就无 EventSource
    createSseClient({
      baseUrl: 'http://api',
      path: '/metrics/stream',
      statusKey: SSE_STATUS_KEYS.metricsStream,
      reconnect: false,
    });
    await flush();
    expect(getSSEStatus(SSE_STATUS_KEYS.metricsStream)).toBeUndefined();
  });

  it('⑤ onSSEStatusChange：状态迁移时触发，退订后不再触发', async () => {
    const seen: string[] = [];
    const unsub = onSSEStatusChange(SSE_STATUS_KEYS.metricsStream, (s) =>
      seen.push(s),
    );
    const client = createSseClient({
      baseUrl: 'http://api',
      path: '/metrics/stream',
      statusKey: SSE_STATUS_KEYS.metricsStream,
      fetchTicket: async () => 't-1',
      reconnect: false,
    });
    await flush();
    FakeEventSource.instances[0].onopen?.();
    expect(seen).toEqual(['connecting', 'live']);

    unsub();
    FakeEventSource.instances[0].onerror?.();
    expect(seen).toEqual(['connecting', 'live']); // 退订后不再推送
    client.close();
  });

  it('多键互不干扰：close 其一仅移除该键', async () => {
    const a = createSseClient({
      baseUrl: 'http://api',
      path: '/metrics/stream',
      statusKey: SSE_STATUS_KEYS.metricsStream,
      fetchTicket: async () => 't-1',
      reconnect: false,
    });
    const b = createSseClient({
      baseUrl: 'http://api',
      path: '/executions/stream',
      statusKey: SSE_STATUS_KEYS.executionsStream,
      fetchTicket: async () => 't-1',
      reconnect: false,
    });
    await flush();
    FakeEventSource.instances[0].onopen?.();
    FakeEventSource.instances[1].onopen?.();
    expect(getSSEStatus(SSE_STATUS_KEYS.metricsStream)).toBe('live');
    expect(getSSEStatus(SSE_STATUS_KEYS.executionsStream)).toBe('live');

    a.close();
    expect(getSSEStatus(SSE_STATUS_KEYS.metricsStream)).toBeUndefined();
    expect(getSSEStatus(SSE_STATUS_KEYS.executionsStream)).toBe('live');
    b.close();
  });
});
