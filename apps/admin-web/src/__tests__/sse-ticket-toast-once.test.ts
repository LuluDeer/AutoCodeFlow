/**
 * W3（遗留 E3）：SSE 换票失败不得走「共享拦截器 + 退避重连」的 toast 循环。
 *
 * 缺陷链：sse-client 换票失败 → scheduleReconnect（3s→6s→…→30s）；而换票请求走
 * 共享 axios client，拦截器对每次失败都 antMessage.error，去重窗口只有 1500ms，
 * 退避间隔全都大于它 ⇒ 后端 5xx/网络抖动时，同一件事被按分钟级节奏反复弹。
 *
 * 判据：
 *  ① 换票请求带 skipGlobalToast → 拦截器不弹（但仍打 __toastedByClient 标，避免
 *     页面兜底再补一条）；
 *  ② createSseClient 侧**只对首次失败**做一次页面级提示，恢复 live 后重置。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AxiosError, AxiosHeaders, type AxiosAdapter } from 'axios';
import { message } from 'antd';
import { createSseClient } from '../api/sse-client';
import { client, __resetToastDedupe } from '../api/client';

vi.mock('antd', () => ({
  message: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(),
    open: vi.fn(),
    destroy: vi.fn(),
  },
}));

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

const adapter = vi.fn<AxiosAdapter>();
/** 4xx 确定性失败：不进 1s 重试路径，只考察 toast 与打标 */
const failure = (status: number): AxiosAdapter => async (config) => {
  throw new AxiosError('Request failed', undefined, config, undefined, {
    config,
    status,
    statusText: 'Error',
    headers: new AxiosHeaders(),
    data: { message: `HTTP ${status}` },
  });
};

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.mocked(message.error).mockClear();
  __resetToastDedupe();
  adapter.mockReset().mockImplementation(failure(400));
  client.defaults.adapter = adapter;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('W3 换票请求跳过全局 toast', () => {
  it('带 skipGlobalToast 的请求失败不弹全局 toast，但仍打 __toastedByClient 标', async () => {
    let rejectValue: unknown;
    try {
      // 通道层：与 sse-client 默认换票实现同一形态（端点/配置逐位一致）
      await client.post('/auth/sse-ticket', undefined, { skipGlobalToast: true });
    } catch (e) {
      rejectValue = e;
    }
    expect(rejectValue).toBeTruthy();
    expect(message.error).not.toHaveBeenCalled();
    // 打标：页面/调用方兜底不得再补一条
    expect((rejectValue as Record<string, unknown>).__toastedByClient).toBe(true);
    // 标记确实随请求发出（拦截器据此分流）
    expect(
      (adapter.mock.calls[0][0] as unknown as Record<string, unknown>).skipGlobalToast,
    ).toBe(true);
  });

  it('createSseClient 默认换票实现把 skipGlobalToast 带上（不注入 fetchTicket 时的真实路径）', async () => {
    vi.useFakeTimers();
    const c = createSseClient({ baseUrl: 'http://api', path: '/metrics/stream', base: 10, cap: 10 });
    await vi.advanceTimersByTimeAsync(0);

    const cfg = adapter.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(String(cfg.url)).toContain('/auth/sse-ticket');
    expect(cfg.skipGlobalToast).toBe(true);
    // 拦截器未弹全局 toast，页面级提示恰好一条
    expect(message.error).toHaveBeenCalledTimes(1);
    c.close();
  });

  it('对照：普通请求（无标记）失败仍照常弹全局 toast', async () => {
    await expect(client.get('/any')).rejects.toBeTruthy();
    expect(message.error).toHaveBeenCalledTimes(1);
  });

  it('换票连续失败 3 次 → 页面级提示只弹 1 次（而不是 3 次）', async () => {
    vi.useFakeTimers();
    const fetchTicket = vi.fn().mockRejectedValue(new Error('502'));
    createSseClient({
      baseUrl: 'http://api',
      path: '/metrics/stream',
      fetchTicket,
      base: 10,
      cap: 10,
    });
    // attempt 0 → 10ms → attempt 1 → 20ms → attempt 2 …
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(20);

    expect(fetchTicket.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(message.error).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(0); // 从未建流
  });

  it('恢复 live 后重置提示开关：下一轮故障能重新被看见', async () => {
    vi.useFakeTimers();
    const fetchTicket = vi
      .fn()
      .mockRejectedValueOnce(new Error('502'))
      .mockResolvedValueOnce('t-1')
      .mockRejectedValue(new Error('502'));
    createSseClient({
      baseUrl: 'http://api',
      path: '/metrics/stream',
      fetchTicket,
      base: 10,
      cap: 10,
    });
    await vi.advanceTimersByTimeAsync(0); // 第 1 次失败 → toast #1
    await vi.advanceTimersByTimeAsync(10); // 第 2 次成功 → 建流
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(message.error).toHaveBeenCalledTimes(1);

    // 进入 live（onopen）→ 提示开关重置
    FakeEventSource.instances[0].onopen?.();
    // 再次断线 → 换票又失败 → 应重新提示一次
    FakeEventSource.instances[0].onerror?.();
    await vi.advanceTimersByTimeAsync(20);

    expect(message.error).toHaveBeenCalledTimes(2);
  });
});
