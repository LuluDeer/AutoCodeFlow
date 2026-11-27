/**
 * LOG-HARDEN-01：执行日志「重连不重复 / 分页无交叠 / 断流 refresh 行级合并」加固单测。
 *
 * 验收级别：**单测 + 内存替身**（FakeEventSource + mock tasksApi）。
 * 未跑真实浏览器 / 未跑真实后端；SSE 工厂与组件 effect 均为真实代码路径，
 * 网络传输层与 API 响应用内存替身替代。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import {
  parseSseLogFrame,
  mergeLogRows,
  rowsFromPage,
  resolveNextCursor,
  rowsToLines,
} from '../components/ExecutionLogSection';

const { executionLogsMock, refreshMock } = vi.hoisted(() => ({
  executionLogsMock: vi.fn(),
  refreshMock: vi.fn(),
}));

vi.mock('../api/tasks', () => ({
  tasksApi: {
    executionLogs: (...args: unknown[]) => executionLogsMock(...args),
    get: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../api/sse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/sse')>();
  return { ...actual, fetchSseTicket: vi.fn().mockResolvedValue('tok-log') };
});

// ── Antd / jsdom shim（与 sse-h6-reconnect-contract.test.tsx 同型）────────
const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// ── FakeEventSource ─────────────────────────────────────────────────────────
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  onopen?: () => void;
  onerror?: () => void;
  onmessage?: (e: { data: string }) => void;
  private listeners = new Map<string, Array<(e: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, cb: (e: unknown) => void) {
    const arr = this.listeners.get(name) ?? [];
    arr.push(cb);
    this.listeners.set(name, arr);
  }
  emit(name: string, e: unknown = { data: '' }) {
    for (const cb of this.listeners.get(name) ?? []) cb(e);
  }
  sendLine(lineNumber: number, content: string) {
    this.onmessage?.({ data: JSON.stringify({ lineNumber, content }) });
  }
  close() { this.closed = true; }
}

let visState: DocumentVisibilityState = 'visible';

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  executionLogsMock.mockReset();
  executionLogsMock.mockResolvedValue({
    lines: [], lineNumbers: [], nextCursor: 0, hasMore: false,
  });
  refreshMock.mockReset();
  vi.stubGlobal('EventSource', FakeEventSource);
  // rAF 合并刷新在 fake timers 下用 macrotask 模拟，便于 advanceTimers 精确 flush。
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0) as unknown as number);
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  visState = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visState,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (document as unknown as Record<string, unknown>).visibilityState;
});

async function renderSection(logs = 'SEED', status = 'running') {
  const { default: ExecutionLogSection } = await import('../components/ExecutionLogSection');
  return render(
    <ExecutionLogSection
      taskId="t-log"
      execId="e-log"
      data={{ id: 'e-log', taskId: 't-log', status, logs } as never}
      refresh={refreshMock}
      isLive={true}
      onStreamStatusChange={vi.fn()}
      reconnectKey={0}
      runbookText={null}
      statusLabel="running"
      onRetrigger={vi.fn()}
      retriggering={false}
      onJumpToReport={vi.fn()}
    />,
  );
}

const shown = () => screen.getByTestId('log-pre').textContent;

// ── 纯函数层：去重口径与游标 ────────────────────────────────────────────────
describe('LOG-HARDEN 纯函数：行号去重 / nextCursor 游标', () => {
  it('SSE 帧只接受 { lineNumber, content }；重复/迟到帧按行号丢弃', () => {
    expect(parseSseLogFrame(JSON.stringify({ lineNumber: 2, content: 'L2' })))
      .toEqual({ lineNumber: 2, content: 'L2' });
    expect(parseSseLogFrame('"plain string"')).toBeNull(); // 旧帧形状
    expect(parseSseLogFrame('{bad json')).toBeNull();

    const map = new Map<number, string>();
    const max = { current: -1 };
    expect(mergeLogRows(map, max, [
      { lineNumber: 1, content: 'L1' },
      { lineNumber: 3, content: 'L3' },
    ], 'sse')).toBe(true);
    // 重放 3 + 迟到 2：均不得覆盖/插入
    expect(mergeLogRows(map, max, [
      { lineNumber: 3, content: 'DUP' },
      { lineNumber: 2, content: 'LATE' },
    ], 'sse')).toBe(false);
    expect(rowsToLines(map)).toEqual(['L1', 'L3']);
    expect(max.current).toBe(3);
  });

  it('REST 页按 lineNumbers 覆盖同号行，行号有洞不产生尾部交叠', () => {
    const map = new Map<number, string>();
    const max = { current: -1 };
    mergeLogRows(map, max, [
      { lineNumber: 1, content: 'SSE-1' },
      { lineNumber: 5, content: 'SSE-5' },
    ], 'sse');
    const rows = rowsFromPage({
      lines: ['DB-1', 'DB-5', 'DB-6'],
      lineNumbers: [1, 5, 6],
    });
    expect(rows).toEqual([
      { lineNumber: 1, content: 'DB-1' },
      { lineNumber: 5, content: 'DB-5' },
      { lineNumber: 6, content: 'DB-6' },
    ]);
    mergeLogRows(map, max, rows, 'rest');
    expect(rowsToLines(map)).toEqual(['DB-1', 'DB-5', 'DB-6']);
    expect(max.current).toBe(6);
  });

  it('nextCursor 优先：行号有洞时不会退化为 fromLine += lines.length', () => {
    const p1 = { lines: ['L1', 'L2', 'L5'], lineNumbers: [1, 2, 5], nextCursor: 6, hasMore: true };
    const p2 = { lines: ['L6', 'L7'], lineNumbers: [6, 7], nextCursor: 8, hasMore: false };
    expect(resolveNextCursor(p1, 0, 5, 3)).toBe(6); // 旧算法会给 3 ⇒ 重复尾部
    expect(resolveNextCursor(p2, 6, 7, 2)).toBe(8); // 旧算法会给 8，但纯属巧合
    expect(resolveNextCursor({ lines: ['a'] }, 0, undefined, 1)).toBe(1); // 旧后端兜底
  });
});

// ── ① 重连：带最后行号续传，服务端重放帧不重复 ─────────────────────────────
describe('LOG-HARDEN ① 断线重连', () => {
  it('重连 URL 带 fromLine=max+1（包含式起点），重放的旧帧不重复', async () => {
    await renderSection();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(FakeEventSource.instances).toHaveLength(1);
    const es1 = FakeEventSource.instances[0];
    expect(es1.url).not.toContain('fromLine='); // 首次连接从头推

    await act(async () => {
      es1.sendLine(1, 'L1');
      es1.sendLine(2, 'L2');
      es1.sendLine(3, 'L3');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(shown()).toBe('L1\nL2\nL3');

    // 传输层断连 → 组件自管 1.5s 后重建（工厂 reconnect:false）
    await act(async () => {
      es1.onerror?.();
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(FakeEventSource.instances).toHaveLength(2);
    const es2 = FakeEventSource.instances[1];
    expect(es2.url).toContain('fromLine=4'); // 包含式契约：max+1 = 续传起点

    // 模拟服务端重放 3（前端按 lineNumber 去重丢弃）+ 新增 4
    await act(async () => {
      es2.sendLine(3, 'L3');
      es2.sendLine(4, 'L4');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(shown()).toBe('L1\nL2\nL3\nL4');
  });
});

// ── ② 分页：按 nextCursor 推进，行号有洞不重复尾部 ─────────────────────────
describe('LOG-HARDEN ② 完整日志分页', () => {
  it('两页请求 fromLine 依次 0 / nextCursor；结果无交叠', async () => {
    executionLogsMock
      .mockResolvedValueOnce({
        lines: ['L1', 'L2', 'L5'], lineNumbers: [1, 2, 5], nextCursor: 6, hasMore: true,
      })
      .mockResolvedValueOnce({
        lines: ['L6', 'L7'], lineNumbers: [6, 7], nextCursor: 8, hasMore: false,
      });

    // success 态：SSE effect 不建流，rawLogs 保留 data.logs 的截断标记 ⇒ 显示"加载完整日志"。
    await renderSection('SEED [logs truncated, original length 999] ...', 'success');
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => {
      screen.getByRole('button', { name: /加载完整日志|Load full logs/ }).click();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(executionLogsMock.mock.calls.map((c) => c[2]?.fromLine)).toEqual([0, 6]);
    expect(shown()).toBe('L1\nL2\nL5\nL6\nL7');
  });
});

// ── ③ 断流 refresh：REST 页与 SSE 缓冲行级合并 ─────────────────────────────
describe('LOG-HARDEN ③ 断流轮询合并', () => {
  it('断流期间新行可见；重叠行按 lineNumber 合并不重复（DB 覆盖同号）', async () => {
    await renderSection();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const es1 = FakeEventSource.instances[0];
    await act(async () => {
      es1.sendLine(1, 'L1');
      es1.sendLine(2, 'L2');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(shown()).toBe('L1\nL2');

    // 连续三次断线，耗尽 2 次自动重试预算 → 降级轮询
    await act(async () => { es1.onerror?.(); await vi.advanceTimersByTimeAsync(1500); });
    await act(async () => {
      FakeEventSource.instances[1].onerror?.();
      await vi.advanceTimersByTimeAsync(3000);
    });
    await act(async () => {
      FakeEventSource.instances[2].onerror?.();
      await vi.advanceTimersByTimeAsync(0);
    });

    // 第一拍：REST 带新行 3、4，且 fromLine = max+1 = 3
    executionLogsMock.mockResolvedValueOnce({
      lines: ['L3', 'L4'], lineNumbers: [3, 4], nextCursor: 5, hasMore: true,
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    const pollCalls = executionLogsMock.mock.calls;
    expect(pollCalls[pollCalls.length - 1]?.[2]?.fromLine).toBe(3);
    expect(shown()).toBe('L1\nL2\nL3\nL4');

    // 第二拍：重叠行 4（DB 覆盖）+ 新行 5 → 4 不重复
    executionLogsMock.mockResolvedValueOnce({
      lines: ['L4-db', 'L5'], lineNumbers: [4, 5], nextCursor: 6, hasMore: true,
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(16000); });
    expect(shown()).toBe('L1\nL2\nL3\nL4-db\nL5');
  });
});
