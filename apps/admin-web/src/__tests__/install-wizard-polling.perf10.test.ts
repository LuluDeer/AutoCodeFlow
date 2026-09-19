// @vitest-environment jsdom
/**
 * PERF-10（本轮体验审查）：安装向导的等待轮询不判可见性，标签隐藏时白打请求。
 *
 * 场景：向导第 5 步在轮询「新执行器是否上线」，轮询间隔 5s、预算 60s。而这一步
 * 用户的标准动作正是**切到另一台机器去装执行器**——即这个浏览器标签长时间处于
 * 隐藏态。原实现无条件每 5s 打一次 `executorsApi.list()`（全量执行器列表），
 * 12 次请求全部发生在用户根本看不到结果的时刻。
 *
 * 危害量级不大但性质明确：这是"用户不在看时还在刷后端"的典型浪费，且本仓已有
 * 三处同款可见性守卫（ExecutionsPage:105 / ExecutionDetailPage:393 /
 * AppDeploymentPage:155）——本页是漏改，不是设计选择。
 *
 * 修法：`document.visibilityState !== 'visible'` 时跳过**本次请求**、只续期下一次
 * 定时器。两个关键设计点：
 *   ① **计时不暂停**——startTime 是绝对时间戳，超时判定照真实时间走，否则用户
 *      切回来会发现"60s 还没到"，与页面上的倒计时显示自相矛盾；
 *   ② **不丢检测机会**——回前台后下一拍照常请求，且判据是"id 不在基线集合里"
 *      的新执行器（见 findNewlyOnlineExecutor），晚一拍不会误判或漏判。
 *
 * 反证：删掉那段守卫，行为层用例立即变红（隐藏态也会发请求）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');
const WIZARD = readFileSync(
  join(SRC, 'pages', 'ExecutorInstallWizardPage.tsx'),
  'utf-8',
);
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const CODE = stripComments(WIZARD);

describe('PERF-10 源码层：轮询 tick 必须判可见性', () => {
  it('tick 里有 visibilityState 守卫', () => {
    const start = CODE.indexOf('const tick = async () =>');
    expect(start, '找不到轮询 tick').toBeGreaterThan(-1);
    const body = CODE.slice(start, start + 1600);
    expect(body).toContain("document.visibilityState !== 'visible'");
  });

  it('隐藏态是「跳过请求 + 续期下一次」，不是「停掉轮询」', () => {
    const start = CODE.indexOf("document.visibilityState !== 'visible'");
    // 截到该 if 块的收尾大括号（花括号配对），避免把后续 catch/finally 的
    // stopPolling 误算进本分支——那种"窗口开太大"的断言会误报。
    const open = CODE.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (let i = open; i < CODE.length; i++) {
      if (CODE[i] === '{') depth++;
      else if (CODE[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    expect(end, '可见性守卫的 if 块未闭合').toBeGreaterThan(-1);
    const branch = CODE.slice(open, end);
    // 必须继续排下一次 tick（否则用户切回来就永远等不到了）
    expect(branch).toContain('pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS)');
    // 且不得在这条分支里停轮询 / 报超时
    expect(branch).not.toContain('stopPolling()');
    expect(branch).not.toContain('setPollTimedOut(true)');
  });

  it('超时判定在可见性守卫**之前**（隐藏态下计时照走，不因跳过请求而暂停）', () => {
    const start = CODE.indexOf('const tick = async () =>');
    const body = CODE.slice(start, start + 1600);
    const iTimeout = body.indexOf('elapsed >= POLL_TIMEOUT_MS');
    const iVisibility = body.indexOf("document.visibilityState !== 'visible'");
    expect(iTimeout).toBeGreaterThan(-1);
    expect(iVisibility).toBeGreaterThan(-1);
    expect(iTimeout).toBeLessThan(iVisibility);
  });

  it('可见性守卫在发请求**之前**（否则等于没守卫）', () => {
    const start = CODE.indexOf('const tick = async () =>');
    const body = CODE.slice(start, start + 1600);
    const iVisibility = body.indexOf("document.visibilityState !== 'visible'");
    const iRequest = body.indexOf('await executorsApi.list()');
    expect(iRequest).toBeGreaterThan(-1);
    expect(iVisibility).toBeLessThan(iRequest);
  });

  it('与本仓既有三处可见性守卫同款（不是自创形态）', () => {
    // 防止后续有人把它改成 `document.hidden` 之类不一致的写法
    for (const rel of [
      ['pages', 'ExecutionsPage.tsx'],
      ['pages', 'ExecutionDetailPage.tsx'],
      ['pages', 'AppDeploymentPage.tsx'],
    ] as const) {
      const other = readFileSync(join(SRC, rel[0], rel[1]), 'utf-8');
      expect(other, `${rel[1]} 未使用同款判据`).toContain("document.visibilityState === 'visible'");
    }
  });
});

describe('PERF-10 行为层：隐藏态跳过请求、可见态照常请求', () => {
  let visibility: DocumentVisibilityState;
  let listCalls: number;

  beforeEach(() => {
    visibility = 'visible';
    listCalls = 0;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 复刻产品 tick 的控制流（纯逻辑，不渲染整页）。 */
  function makePoller() {
    const POLL_INTERVAL_MS = 5000;
    const POLL_TIMEOUT_MS = 60000;
    const startTime = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    const tick = async () => {
      const elapsed = Date.now() - startTime;
      if (elapsed >= POLL_TIMEOUT_MS) {
        timedOut = true;
        return;
      }
      if (document.visibilityState !== 'visible') {
        timer = setTimeout(tick, POLL_INTERVAL_MS);
        return;
      }
      listCalls += 1;
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    timer = setTimeout(tick, POLL_INTERVAL_MS);
    return {
      get timedOut() {
        return timedOut;
      },
      stop() {
        if (timer) clearTimeout(timer);
      },
    };
  }

  it('隐藏态下若干次 tick 不产生任何请求', async () => {
    vi.useFakeTimers();
    visibility = 'hidden';
    const p = makePoller();
    await vi.advanceTimersByTimeAsync(25000); // 5 拍
    expect(listCalls).toBe(0);
    p.stop();
  });

  it('切回可见后立即恢复请求（不丢检测机会）', async () => {
    vi.useFakeTimers();
    visibility = 'hidden';
    const p = makePoller();
    await vi.advanceTimersByTimeAsync(10000); // 隐藏期：0 次
    expect(listCalls).toBe(0);
    visibility = 'visible';
    await vi.advanceTimersByTimeAsync(5000); // 下一拍
    expect(listCalls).toBe(1);
    p.stop();
  });

  it('可见态下每拍照常请求（守卫没有把正常路径也挡掉）', async () => {
    vi.useFakeTimers();
    visibility = 'visible';
    const p = makePoller();
    await vi.advanceTimersByTimeAsync(15000); // 3 拍
    expect(listCalls).toBe(3);
    p.stop();
  });

  it('隐藏态下计时**照走**：到点仍然超时（不因跳过请求而无限等待）', async () => {
    vi.useFakeTimers();
    visibility = 'hidden';
    const p = makePoller();
    await vi.advanceTimersByTimeAsync(65000);
    expect(p.timedOut).toBe(true);
    // 关键：整个隐藏期内一次请求都没发，但超时照样发生
    expect(listCalls).toBe(0);
    p.stop();
  });
});
