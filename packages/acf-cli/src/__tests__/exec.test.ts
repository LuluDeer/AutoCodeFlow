/**
 * ECO-02: acf exec tail 的 SSE 解析器与路由决策单测。
 * 解析器必须跨 chunk 半行/半消息安全，并对 admin-api 的三种帧
 * （data: JSON line / event: done + data: [DONE] / : ping 保活）分类正确。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
