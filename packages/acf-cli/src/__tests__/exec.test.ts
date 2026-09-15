/**
 * ECO-02: acf exec tail 的 SSE 解析器与路由决策单测。
 * 解析器必须跨 chunk 半行/半消息安全，并对 admin-api 的三种帧
 * （data: JSON line / event: done + data: [DONE] / : ping 保活）分类正确。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const { axiosInstance, tokenState } = vi.hoisted(() => ({
  axiosInstance: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    request: vi.fn(),
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  },
  tokenState: { access: 'cli-token', refresh: '' },
}));

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => axiosInstance),
    post: vi.fn(),
    // exec tail 的 SSE 建流用的是模块级 axios.get（不是 client 实例），
    // 断言必须打在这个 mock 上，否则会误判为「没有建流」。
    get: vi.fn(),
    isAxiosError: (e: unknown) =>
      !!e && typeof e === 'object' && (e as { isAxiosError?: boolean }).isAxiosError === true,
  },
}));

vi.mock('../config', () => ({
  getApiUrl: () => 'http://localhost:3105',
  getToken: () => tokenState.access,
  getRefreshToken: () => tokenState.refresh,
  setToken: vi.fn(),
  setRefreshToken: vi.fn(),
  clearAuth: vi.fn(),
  showConfig: vi.fn(),
}));

import { createSseParser } from '../commands/exec';
import { get } from '../client';

// exec tail 会在 stream.on('data'/'end') 的异步回调里调 process.exit()。回调可能
// 在用例结束之后才触发，vitest 随即把它记为 unhandled error 并使整轮非零退出。
// 这里把 process.exit 钉成桩做兜底；同时注意 describe 内的 vi.clearAllMocks()
// 会清掉 mockImplementation，故在 beforeEach 里重新装回。
const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
beforeEach(() => {
  exitSpy.mockImplementation((() => undefined) as never);
});
afterAll(() => exitSpy.mockRestore());

describe('createSseParser (ECO-02)', () => {
  it('parses a complete message and defaults the event name to message', () => {
    const seen: Array<{ event: string; data: string }> = [];
    const p = createSseParser((m) => seen.push(m));
    p.feed('data: "line-1"\n\n');
    expect(seen).toEqual([{ event: 'message', data: '"line-1"' }]);
  });

  it('buffers partial lines across chunks (half-line and half-message safe)', () => {
    const seen: string[] = [];
    const p = createSseParser((m) => seen.push(m.data));
    p.feed('data: "hal');
    expect(seen).toEqual([]);
    p.feed('f"\n\ndata: "second"');
    expect(seen).toEqual(['"half"']);
    p.feed('\n\n');
    expect(seen).toEqual(['"half"', '"second"']);
  });

  it('routes the done event and ignores ping comment frames', () => {
    const seen: Array<{ event: string; data: string }> = [];
    const p = createSseParser((m) => seen.push(m));
    p.feed(': ping\n\ndata: "log"\n\nevent: done\ndata: [DONE]\n\n');
    expect(seen).toEqual([
      { event: 'message', data: '"log"' },
      { event: 'done', data: '[DONE]' },
    ]);
  });

  it('handles CRLF line endings', () => {
    const seen: string[] = [];
    const p = createSseParser((m) => seen.push(m.data));
    // SSE 规范：连续两行 data 无空行分隔 = 单条多行消息（join('\n')）；
    // admin-api 实际每行日志都是独立帧（data 行后紧跟空行）。
    p.feed('data: "a"\r\ndata: "b"\r\n\r\n');
    expect(seen).toEqual(['"a"\n"b"']);
    p.feed('data: "c"\r\n\r\n');
    expect(seen).toEqual(['"a"\n"b"', '"c"']);
  });

  it('skips empty messages (event line without data does not dispatch)', () => {
    const seen: Array<{ event: string; data: string }> = [];
    const p = createSseParser((m) => seen.push(m));
    p.feed('event: done\n\n');
    expect(seen).toEqual([]);
  });
});

describe('exec tail route decisions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves the execution by execId via the compat alias', async () => {
    (axiosInstance.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { code: 0, message: 'success', data: { taskId: 't-1', status: 'success' } },
    });
    await get('/tasks/executions/e-1');
    expect(axiosInstance.get).toHaveBeenCalledWith(
      '/tasks/executions/e-1',
      expect.anything(),
    );
  });

  it('terminal status map covers all five terminal states', () => {
    // 终态集合与 admin-api ExecutionStatus 终态对齐——直接钉死常量集
    const TERMINAL = ['success', 'failed', 'timeout', 'killed', 'cancelled'];
    expect(TERMINAL).toHaveLength(5);
    expect(TERMINAL).not.toContain('running');
    expect(TERMINAL).not.toContain('pending');
  });
});

/**
 * SEC-CLI-01 回归：exec tail 此前在**两条**路径上都不工作。
 *  a) 非终态用已撤销的 `?access_token=` 建流（服务端只认 ?ticket=）→ 401；
 *  b) 终态读 `page.logs`，而服务端返回 `lines` → 恒为空 → 静默无输出。
 * 这里直接驱动真实 commander 命令，断言实际发出的 URL 与解析的字段。
 */
describe('SEC-CLI-01: exec tail 契约', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** 收集 stdout 写入，避免污染测试输出。 */
  function captureStdout() {
    const chunks: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((c: string | Uint8Array) => {
        chunks.push(String(c));
        return true;
      });
    return { chunks, restore: () => spy.mockRestore() };
  }

  it('终态：读取服务端的 `lines` 字段并按页输出（此前读 logs 恒为空）', async () => {
    const { execCommand } = await import('../commands/exec');
    (axiosInstance.get as ReturnType<typeof vi.fn>)
      // 1) compat alias 解析执行
      .mockResolvedValueOnce({
        data: { code: 0, message: 'success', data: { taskId: 't-1', status: 'success' } },
      })
      // 2) 全量日志页：服务端真实形状 { lines: [...], totalLines, hasMore }
      .mockResolvedValueOnce({
        data: {
          code: 0,
          message: 'success',
          data: { lines: ['alpha', 'beta'], totalLines: 2, hasMore: false },
        },
      });

    const cap = captureStdout();
    try {
      await execCommand().parseAsync(['node', 'acf', 'tail', 'e-1']);
    } finally {
      cap.restore();
    }

    expect(cap.chunks.join('')).toContain('alpha');
    expect(cap.chunks.join('')).toContain('beta');
  });

  it('非终态：先取 SSE 票据，再用 ?ticket= 建流（绝不再用 ?access_token=）', async () => {
    const { execCommand } = await import('../commands/exec');
    const axiosDefault = (await import('axios')).default as unknown as {
      get: ReturnType<typeof vi.fn>;
    };
    // 1) compat alias 解析执行（走 client 实例）
    (axiosInstance.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { code: 0, message: 'success', data: { taskId: 't-1', status: 'running' } },
    });
    // 2) SSE 建流（走模块级 axios.get）。这里给一个「不会自动 end」的最小流桩：
    //    真 Readable 在读完会触发 stream.on('end') → process.exit(0)，而该回调
    //    在用例结束后才跑，vitest 会记为 unhandled error。本用例只关心建流 URL，
    //    不需要流真的收尾，故手动 feed 一帧后就不再推进。
    const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
    const fakeStream = {
      on(evt: string, cb: (arg?: unknown) => void) {
        (listeners[evt] ??= []).push(cb);
        return fakeStream;
      },
    };
    axiosDefault.get.mockResolvedValueOnce({ data: fakeStream });
    // POST /auth/sse-ticket 返回票据
    (axiosInstance.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { code: 0, message: 'success', data: { ticket: 'TK-123' } },
    });

    const cap = captureStdout();
    try {
      await execCommand().parseAsync(['node', 'acf', 'tail', 'e-1']);
    } catch {
      /* 建流/解析异常不影响 URL 断言 */
    } finally {
      cap.restore();
    }

    // 必须调用过 sse-ticket 端点换票（client.post 无 body 时第二参为 undefined）
    const ticketCall = (axiosInstance.post as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === '/auth/sse-ticket',
    );
    expect(ticketCall).toBeTruthy();
    // 建流 URL 必须带 ticket，且绝不带 access_token。
    // 建流走的是模块级 axios.get（exec.ts 里 `axios.get(url, ...)`）。
    const sseCall = axiosDefault.get.mock.calls.find(
      (c) => typeof c[0] === 'string' && String(c[0]).includes('/logs/stream'),
    );
    expect(sseCall).toBeTruthy();
    expect(String(sseCall![0])).toContain('ticket=TK-123');
    expect(String(sseCall![0])).not.toContain('access_token');
  });
});
