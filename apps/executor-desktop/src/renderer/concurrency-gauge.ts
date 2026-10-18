/**
 * PLAN-EXECUTOR-DESKTOP-UX 2.1：并发饱和度的纯计算（无 React / DOM 依赖）。
 *
 * 为什么抽成独立纯模块：状态页「今日汇总」条上要显示 running/max 与一条
 * 细进度条，而这类"分子分母 + 百分比 + 阈值配色"的算术最容易在渲染层写成
 * 裸内联表达式（除零、NaN、负值、running 超 max 各写一遍）。抽出来后
 * `test:renderer` 可以在裸 node 下直接 import 断言（同 number-input.ts 先例，
 * Node ≥22.6 原生解析 .ts），页面里只留一次调用。
 *
 * 两个数字的真值源（都**不新增 IPC**）：
 *   · running ← `history:get` 里 status === 'running' 的记录数（全量，不限今天
 *     ——昨天的任务还在跑时它仍然占并发额度）；
 *   · max     ← `executor:status` 已经返回的 `config.maxConcurrentTasks`
 *     （与设置页「最大并发任务数」、executor-node 的 MAX_CONCURRENT_TASKS
 *     环境变量同源）。
 */

/** 并发表的饱和度分档：idle 空转 / ok 有余 / warn 逼近 / full 打满 / over 超额。 */
export type ConcurrencyState = 'idle' | 'ok' | 'warn' | 'full' | 'over';

export interface ConcurrencyGauge {
  /** 正在运行的任务数（非法输入归一为 0）。 */
  running: number;
  /** 并发上限（非法输入归一为 0 = 未知）。 */
  max: number;
  /** 0–100 的整数；max 不可用时为 0（不画一条假进度）。 */
  percent: number;
  state: ConcurrencyState;
  /** max 是否可用——false 时渲染层显示「—」而不是 0/0。 */
  known: boolean;
}

/** 逼近上限的阈值（≥80% 起提示"该留余量了"）。 */
export const CONCURRENCY_WARN_RATIO = 0.8;

/**
 * 把两个可能是脏值的输入（IPC 序列化后的 null / NaN / 字符串）归一成一条
 * 可渲染的并发表。
 *
 * 语义取舍：
 *   · max 缺失/为 0 → `known=false`：**不谎报 0%**（那会被读成"完全空闲"，
 *     而真相是"不知道上限是多少"）；
 *   · running 为脏值 → 按 0（与既有 runningCount 的 `?? []` 口径一致）；
 *   · running > max（上限刚被调小、或中台又派了单）→ `over`，百分比钳到 100，
 *     但不把 running 改成 max——超额本身就是用户要看到的信息。
 */
export function concurrencyGauge(running: unknown, max: unknown): ConcurrencyGauge {
  const r = toNonNegativeInt(running);
  const m = toNonNegativeInt(max);
  if (m <= 0) {
    return { running: r, max: 0, percent: 0, state: r > 0 ? 'over' : 'idle', known: false };
  }
  const percent = Math.min(100, Math.max(0, Math.round((r / m) * 100)));
  let state: ConcurrencyState;
  if (r > m) state = 'over';
  else if (r === m) state = 'full';
  else if (r === 0) state = 'idle';
  else if (r / m >= CONCURRENCY_WARN_RATIO) state = 'warn';
  else state = 'ok';
  return { running: r, max: m, percent, state, known: true };
}

function toNonNegativeInt(value: unknown): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/** 并发表的无障碍描述（`<progress>` 的 aria-label 用）。 */
export function concurrencyAriaText(gauge: ConcurrencyGauge): string {
  if (!gauge.known) return `${gauge.running}/—`;
  return `${gauge.running}/${gauge.max}`;
}
