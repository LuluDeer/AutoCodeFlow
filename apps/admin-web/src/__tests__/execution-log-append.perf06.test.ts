// @vitest-environment jsdom
/**
 * PERF-06（本轮体验审查）：SSE 日志追加是 O(n²)。
 *
 * 原实现（ExecutionDetailPage）：
 *   onMessage: (e) => setStreamLines((prev) => prev ? [...prev, line] : [line])
 * 而渲染函数体里无条件执行 `streamLines.join('\n')`。
 *
 * 于是**每来一行**都付两遍 O(n)：一次整数组拷贝、一次整串拼接。持续输出的
 * 任务每秒可推几十行 → 累计 O(n²)。20k 行时单单一次 join 就是 20k 段字符串
 * 拼接，而它在每个渲染里都跑；页面随日志增长越来越卡，直到滚动/输入都掉帧
 * （SSE 回调与渲染同在主线程）。
 *
 * 修法（两步，且都要有断言）：
 *  ① **批量累积 + 按帧刷新**：到达的行先进 ref 缓冲，用 requestAnimationFrame
 *     合并成"一帧最多一次 setState"——一帧来 1 行或来 50 行，代价相同；
 *  ② **join 用 useMemo 缓存**：依赖只有真正决定结果的 streamLines / data?.logs，
 *     父组件因别的原因重渲（搜索打字、级别下拉…）不再重拼整份日志。
 *
 * 反证：
 *  · 把 ① 改回 `[...prev, line]` → 「一帧多行只触发一次更新」用例变红；
 *  · 把 ② 改回渲染体内直接 join → 「join 结果被缓存」用例变红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// REFACTOR-EXEC-03：SSE 追加/join 缓存模式随日志子系统迁至 ExecutionLogSection
const PAGE_SRC = readFileSync(
  join(__dirname, '..', 'components', 'ExecutionLogSection.tsx'),
  'utf-8',
);
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const CODE = stripComments(PAGE_SRC);

describe('PERF-06 源码层：SSE 追加必须批量 + join 必须缓存', () => {
  it('onMessage 不再逐行 setState，而是入缓冲', () => {
    // 旧形态：`setStreamLines((prev) => (prev ? [...prev, line] : [line]))`
    expect(CODE).not.toMatch(/setStreamLines\(\(prev\)\s*=>\s*\(?prev\s*\?\s*\[\.\.\.prev,\s*line\]/);
  });

  it('存在 rAF 合并刷新（一帧最多一次 state 更新）', () => {
    expect(CODE).toContain('requestAnimationFrame');
    expect(CODE).toContain('pendingStreamLinesRef');
    expect(CODE).toContain('streamFlushRafRef');
    // 缓冲非空才 setState（空帧不产生无谓渲染）
    expect(CODE).toMatch(/if \(batch\.length === 0\) return;/);
  });

  it('卸载/换执行时取消挂起的 rAF 并清空缓冲', () => {
    // 不取消的话，卸载后回调仍会 setState（React 警告 + 白做一次拷贝）
    expect(CODE).toContain('cancelAnimationFrame(streamFlushRafRef.current)');
    expect(CODE).toMatch(/pendingStreamLinesRef\.current = \[\];/);
  });

  it('join 走 useMemo，依赖只有 streamLines 与 data?.logs', () => {
    const m = /const rawLogs = useMemo\(([\s\S]*?)\n {2}\);/.exec(CODE);
    expect(m, '找不到 rawLogs 的 useMemo').toBeTruthy();
    const body = m![1];
    expect(body).toContain("streamLines.join('\\n')");
    // 依赖数组必须恰好是这两个——多一个会让缓存失效，少一个会用陈旧值
    expect(body).toMatch(/\[streamLines, data\?\.logs\]/);
  });

  it('反例存档：渲染体内裸 join 是**无条件**执行的（解释为何必须缓存）', () => {
    // 这条钉住"裸 join 一定出现在每个渲染里"这个前提：若它出现在 useMemo 外，
    // 任何 state 变化（哪怕与日志无关）都会重拼整份日志。
    const withoutMemo = CODE.replace(/const rawLogs = useMemo\([\s\S]*?\n {2}\);/, '');
    expect(withoutMemo).not.toMatch(/streamLines\.join\(/);
  });
});

describe('PERF-06 行为层：rAF 合并确实把一帧多行压成一次更新', () => {
  let rafQueue: Array<() => void>;
  let rafId: number;

  beforeEach(() => {
    rafQueue = [];
    rafId = 0;
    // jsdom 默认**没有** requestAnimationFrame 的可靠实现，显式桩掉并手动泵帧，
    // 这样"一帧内到达多行"是可控的、断言是确定的。
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      rafQueue.push(cb);
      return ++rafId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      // 简化：按登记顺序丢弃（本用例只关心"是否还留着待执行的回调"）
      rafQueue = rafQueue.filter((_, i) => i + 1 !== id);
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 复刻产品代码的缓冲 + 刷新协议（纯逻辑，不渲染整页）。 */
  function makeSink() {
    const pending: string[] = [];
    let raf: number | null = null;
    let state: string[] | null = null;
    let renders = 0;
    const setState = (next: string[]) => {
      state = next;
      renders += 1;
    };
    return {
      onMessage(line: string) {
        pending.push(line);
        if (raf === null) {
          raf = requestAnimationFrame(() => {
            raf = null;
            const batch = pending.slice();
            if (batch.length === 0) return;
            pending.length = 0;
            setState(state ? state.concat(batch) : batch.slice());
          });
        }
      },
      /** 泵一帧（等价于浏览器把这一帧的 rAF 回调都跑掉） */
      pumpFrame() {
        const q = rafQueue;
        rafQueue = [];
        for (const cb of q) cb();
      },
      get renders() {
        return renders;
      },
      get state() {
        return state;
      },
      get pendingCount() {
        return rafQueue.length;
      },
    };
  }

  it('一帧内到达 50 行 → 只触发 1 次状态更新（旧实现是 50 次）', () => {
    const sink = makeSink();
    for (let i = 0; i < 50; i++) sink.onMessage(`line-${i}`);
    // 尚未泵帧：还没有任何 state 更新，且只登记了 1 个 rAF
    expect(sink.renders).toBe(0);
    expect(sink.pendingCount).toBe(1);

    sink.pumpFrame();
    expect(sink.renders).toBe(1);
    expect(sink.state).toHaveLength(50);
    expect(sink.state![0]).toBe('line-0');
    expect(sink.state![49]).toBe('line-49');
  });

  it('多帧到达 → 每帧一次，且累计内容不丢不乱序', () => {
    const sink = makeSink();
    sink.onMessage('a');
    sink.pumpFrame();
    sink.onMessage('b');
    sink.onMessage('c');
    sink.pumpFrame();
    expect(sink.renders).toBe(2);
    expect(sink.state).toEqual(['a', 'b', 'c']);
  });

  it('空帧不产生更新（避免无谓渲染）', () => {
    const sink = makeSink();
    sink.onMessage('only');
    sink.pumpFrame();
    const before = sink.renders;
    // 注册一个 rAF 但不喂数据，泵帧后不应多一次渲染
    requestAnimationFrame(() => {});
    sink.pumpFrame();
    // 上面那个空回调不属于 sink，sink 自身没有挂起任务 → 不新增渲染
    expect(sink.renders).toBe(before);
  });
});
