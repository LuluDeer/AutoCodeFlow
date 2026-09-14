/**
 * A5（DEEP_REVIEW §七 A5）：SSE 凭据从「access token 入 URL」改为「建流前换
 * 30s 短效票据」。本文件钉住的是**客户端侧**的四条行为：
 *
 *   ① 票据进 `?ticket=`，access token 不再进 URL（这是本改动的全部意义）；
 *   ② 每次建流（含自动重连）都**现换一枚**——票据只有 30s，复用旧值必然 401；
 *   ③ 换票失败（401 / 网络）与断线同处理：退避重试，而不是直接建一个必然
 *      失败的连接；
 *   ④ 换票期间组件卸载 → 丢弃票据，不再建流（避免泄漏一条幽灵长连接）。
 *
 * ③ ④ 是本改动引入的**新失败模式**：换票让建流从同步变成异步，这两条边界
 * 不钉住就会退化成「卸载后仍有连接」「401 时疯狂重连」。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSseClient } from '../api/sse-client';
import { buildSseUrl } from '../api/sse';

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

describe('SSE 短效票据（A5）', () => {
  it('票据进 ?ticket=，access token 不再出现在 URL 里', async () => {
    const fetchTicket = vi.fn().mockResolvedValue('t-1');
    createSseClient({
      baseUrl: 'http://api',
      path: '/metrics/stream',
      fetchTicket,
      reconnect: false,
    });
    await flush();

    expect(fetchTicket).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe(
      'http://api/metrics/stream?ticket=t-1',
    );
    expect(FakeEventSource.instances[0].url).not.toContain('access_token');
  });

  it('重连时现换一枚新票据（票据只有 30s，复用旧值必然 401）', async () => {
    vi.useFakeTimers();
    const fetchTicket = vi
      .fn()
      .mockResolvedValueOnce('t-1')
      .mockResolvedValueOnce('t-2');
    createSseClient({
      baseUrl: 'http://api',
      path: '/metrics/stream',
      fetchTicket,
      base: 10,
      cap: 10,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toContain('ticket=t-1');

    FakeEventSource.instances[0].onerror?.();
    await vi.advanceTimersByTimeAsync(20);

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(fetchTicket).toHaveBeenCalledTimes(2);
    expect(FakeEventSource.instances[1].url).toContain('ticket=t-2');
  });

  it('换票失败 → 不建流，按退避重试换票（而不是建一个必然失败的连接）', async () => {
    vi.useFakeTimers();
    const fetchTicket = vi.fn().mockRejectedValue(new Error('401'));
    createSseClient({
      baseUrl: 'http://api',
      path: '/metrics/stream',
      fetchTicket,
      base: 10,
      cap: 10,
    });
    await vi.advanceTimersByTimeAsync(0);
    // 换票失败 ⇒ 一个 EventSource 都不该被创建
    expect(FakeEventSource.instances).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(35);
    expect(fetchTicket.mock.calls.length).toBeGreaterThan(1);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('换票期间卸载 → 丢弃票据、不建流（防幽灵长连接）', async () => {
    let resolveTicket!: (t: string) => void;
    const fetchTicket = vi
      .fn()
      .mockReturnValue(new Promise<string>((res) => (resolveTicket = res)));

    const client = createSseClient({
      baseUrl: 'http://api',
      path: '/metrics/stream',
      fetchTicket,
      reconnect: false,
    });
    client.close();
    resolveTicket('t-9');
    await flush();

    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('buildSseUrl 对票据做 URL 编码（票据含特殊字符时不破坏 query）', () => {
    expect(buildSseUrl('http://api/', '/metrics/stream', 'a b&c')).toBe(
      'http://api/metrics/stream?ticket=a%20b%26c',
    );
    expect(buildSseUrl('http://api', '/metrics/stream', null)).toBe(
      'http://api/metrics/stream',
    );
  });
});
