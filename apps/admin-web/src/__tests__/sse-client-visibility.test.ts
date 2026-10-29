/**
 * WEB-3（第 3 轮 web-ux 审计）：SSE 长连接必须随**标签页可见性**暂停/恢复。
 *
 * 缺陷：全站轮询都守「页面隐藏即暂停」（TanStack `refetchIntervalInBackground`
 * 默认 false），但三条 SSE 流（metrics / executions / logs）从不看
 * `document.visibilityState`——`createSseClient` 只在 `onerror` 退避重连。
 * 后果不是省流量问题而是可靠性退化：服务端每 3s 一拍快照（`getSummary` 自身
 * ≈ 6 条聚合查询，整拍 8–10 条聚合 SQL），并占满默认 32 个 stream 槽位
 * （超限真 503，把真正需要看板的人挡在门外）。
 *
 * 本文件钉住五条行为（每条都能失败）：
 *   ① `hidden` → `EventSource.close()` 被调用，且**不留任何定时器**；
 *   ② `hidden` 之后长时间推进定时器**不重建连接**（隐藏不得走
 *      `scheduleReconnect`——否则后台每 30s 重连一次，比现状更糟）；
 *   ③ 回前台 → 立即重连，且 `attempt` **归零**（状态是 connecting 而不是
 *      reconnecting：隐藏不是失败，不该继承退避）；
 *   ④ `close()` 摘掉 `visibilitychange` 监听（同一个 handler 引用），摘掉后
 *      再切换可见性不再建流（防重复监听 / 防泄漏）；
 *   ⑤ 换票（异步）期间被隐藏 → 丢弃票据不建流（否则"隐藏后仍有一条幽灵连接"）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSseClient, getSSEStatus, SSE_STATUS_KEYS } from '../api/sse-client';

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

let visState: DocumentVisibilityState = 'visible';

/** 模拟浏览器把标签页切到 hidden / visible 并派发 visibilitychange。 */
function setVisibility(next: DocumentVisibilityState) {
  visState = next;
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visState,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

const makeClient = (over: Partial<Parameters<typeof createSseClient>[0]> = {}) =>
  createSseClient({
    baseUrl: 'http://api',
    path: '/metrics/stream',
    statusKey: SSE_STATUS_KEYS.metricsStream,
    fetchTicket: async () => 't-1',
    ...over,
  });

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  visState = 'visible';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  // 摘掉本文件定义的实例属性，恢复 jsdom 原型上的 getter
  delete (document as unknown as Record<string, unknown>).visibilityState;
});

describe('WEB-3：SSE 随标签页可见性暂停/恢复', () => {
  it('① hidden：关闭 EventSource，且不留任何退避定时器', async () => {
    vi.useFakeTimers();
    const client = makeClient();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeEventSource.instances).toHaveLength(1);
    const es = FakeEventSource.instances[0];
    expect(es.closed).toBe(false);

    setVisibility('hidden');

    expect(es.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    client.close();
  });

  it('② hidden 之后 10 分钟内不重建连接（不走 scheduleReconnect）', async () => {
    vi.useFakeTimers();
    const fetchTicket = vi.fn().mockResolvedValue('t-1');
    const client = makeClient({ fetchTicket, base: 3_000, cap: 30_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeEventSource.instances).toHaveLength(1);

    setVisibility('hidden');
    // 退避窗口是 3s/6s/…/30s：若 hidden 走了重连路径，这里必然出现新连接。
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(fetchTicket).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    client.close();
  });

  it('③ 回前台：立即重连且 attempt 归零（不继承退避，状态回 connecting）', async () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const client = makeClient({
      onStatus: (s) => statuses.push(s),
      base: 3_000,
      cap: 30_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    // 先制造一次真实断线：attempt 0→1，退避定时器 3s 在跑
    FakeEventSource.instances[0].onopen?.();
    FakeEventSource.instances[0].onerror?.();
    expect(statuses[statuses.length - 1]).toBe('reconnecting');
    expect(vi.getTimerCount()).toBe(1);

    setVisibility('hidden');
    expect(vi.getTimerCount()).toBe(0); // 后台连退避定时器都不许留

    setVisibility('visible');
    // 只需要冲刷微任务（若沿用 attempt=1 的退避，这里必须等满 3s）
    await vi.advanceTimersByTimeAsync(0);

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(statuses[statuses.length - 1]).toBe('connecting'); // 归零的证据：不是 reconnecting
    client.close();
  });

  it('④ close() 摘掉 visibilitychange 监听，摘掉后切换可见性不再建流', async () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const client = makeClient();
    await flush();

    const added = addSpy.mock.calls.filter((c) => c[0] === 'visibilitychange');
    expect(added).toHaveLength(1);

    client.close();
    const removed = removeSpy.mock.calls.filter((c) => c[0] === 'visibilitychange');
    expect(removed).toHaveLength(1);
    // 必须是**同一个** handler 引用，否则等于没摘（匿名函数每次新建）
    expect(removed[0][1]).toBe(added[0][1]);

    const before = FakeEventSource.instances.length;
    setVisibility('hidden');
    setVisibility('visible');
    await flush();
    expect(FakeEventSource.instances).toHaveLength(before);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('⑤ 换票期间被隐藏 → 丢弃票据不建流；回前台才建', async () => {
    let resolveTicket!: (t: string) => void;
    const fetchTicket = vi
      .fn()
      .mockReturnValue(new Promise<string>((res) => (resolveTicket = res)));
    const client = makeClient({ fetchTicket });

    setVisibility('hidden'); // 换票还没落定
    resolveTicket('t-9');
    await flush();
    expect(FakeEventSource.instances).toHaveLength(0);

    setVisibility('visible');
    await flush();
    expect(FakeEventSource.instances).toHaveLength(1);
    client.close();
  });

  it('⑥ 隐藏期间不误删状态登记（回前台靠它恢复 live）', async () => {
    vi.useFakeTimers();
    const client = makeClient();
    await vi.advanceTimersByTimeAsync(0);
    FakeEventSource.instances[0].onopen?.();
    expect(getSSEStatus(SSE_STATUS_KEYS.metricsStream)).toBe('live');

    setVisibility('hidden');
    // hidden 只是暂停，不是生命周期终点：键仍在（close 才删键）
    expect(getSSEStatus(SSE_STATUS_KEYS.metricsStream)).toBe('live');

    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(getSSEStatus(SSE_STATUS_KEYS.metricsStream)).toBe('connecting');
    FakeEventSource.instances[1].onopen?.();
    expect(getSSEStatus(SSE_STATUS_KEYS.metricsStream)).toBe('live');
    client.close();
  });
});
