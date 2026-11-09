/**
 * 数值输入的「草稿 → 钳制 → 收口」纯逻辑（F-34 / P3-7）。
 *
 * 为什么单独成文件：`numValue` / `numChange` / `numBlur` 三件套原来直接写在
 * `ConfigPage` 里，而它们**唯一不可纯的部分**只有三行 setState。判定本身
 * （草稿优先的显示值、键入时要不要入表单、blur 时收口成什么数、这次是否
 * 触发了钳制）没有任何 state / DOM / 时钟依赖，却因为长在组件里而从未被
 * 执行过（renderer 此前零可执行覆盖）。搬到这里后由
 * `pages/config/pure-logic.selftest.mjs` 逐条真跑断言。
 *
 * 契约（照抄原实现的注释口径，行为一字未改）：
 *  · 输入中：显示权归草稿（含空串），form 只在得到合法整数时更新（越界先钳），
 *    保证 form 恒为合法值——这就是 controlled-clamp 毛刺（F-34）的修法；
 *  · blur：走完整 `parseBoundedInt`（空串=回落默认、越界钳制）并清草稿；
 *  · 只有「原始输入是合法整数但值被改写」才算钳制（空串/非数字回落默认是
 *    「未指定」的既定语义，不算改写 → P3-7 的一次性提示不打扰）。
 */
import { displayNumber, parseBoundedInt } from '../../number-input';

/** 一个数值字段的边界规则（`maxConcurrentTasks` / `executorPort` / 下载预算各一份）。 */
export type NumRule = { readonly fallback: number; readonly min: number; readonly max: number };

/** 受控 value：键入中显示草稿原样串，其余显示安全取值（脏值回落默认）。 */
export function draftOrDisplay(
  drafts: Record<string, string>,
  key: string,
  value: unknown,
  fallback: number,
): string {
  return drafts[key] ?? String(displayNumber(value, fallback));
}

/** onChange 的判定：`null` = 只留草稿、不动表单；否则返回应写入 form 的钳制值。 */
export function commitFromDraft(rule: NumRule, raw: string): number | null {
  const trimmed = raw.trim();
  // 空串/number input 非法半态：form 保持原值，显示权在草稿；blur 收口。
  if (trimmed === '') return null;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, rule.min), rule.max);
}

/** onBlur 的判定：收口值 + 「输入是合法整数但被改写」（P3-7 一次性提示的触发条件）。 */
export function settleDraft(rule: NumRule, raw: string): { parsed: number; clamped: boolean } {
  const parsed = parseBoundedInt(raw, rule.fallback, rule.min, rule.max);
  const trimmed = raw.trim();
  if (trimmed === '') return { parsed, clamped: false };
  const n = Number.parseInt(trimmed, 10);
  return { parsed, clamped: Number.isFinite(n) && n !== parsed };
}

/**
 * 不可变删除一个键：**键不存在时返回原对象本身**（不是一份新副本）。
 *
 * 这一点被 setState 依赖：React 以引用相等决定是否重渲染，原实现在
 * `if (!(key in prev)) return prev` 上做了同样的短路，删掉那个短路会让每次
 * 编辑都多一次空重渲染。故本函数的「同引用返回」是契约，不是优化。
 */
export function withoutKey<V>(record: Record<string, V>, key: string): Record<string, V> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}
