/**
 * WEB-4（P2，2026-10-29 第 3 轮 web-ux）：工具入参 → 可读文本的**纯逻辑**。
 *
 * 与 `components/ToolArgsView.tsx` 拆开的原因有两个：
 *  ① 这里的函数是「怎么把 argsJson 摊平」的判据，不依赖 React/i18n，可单独单测；
 *  ② 组件文件只导组件（react-refresh 的 only-export-components 纪律）。
 */

/** 超长值的折叠阈值（字符数）。短值直接平铺，避免每条都挂一个「展开」。 */
export const ARGS_LONG_VALUE_CHARS = 120;

/** 摘要（二次确认正文用）里单值最多保留的字符数——确认框只给「一眼认出是哪单」。 */
export const ARGS_SUMMARY_VALUE_CHARS = 40;

export interface ArgsEntry {
  key: string;
  /** 渲染用文本：字符串原样（不 JSON 加引号），其余 JSON.stringify */
  text: string;
  long: boolean;
}

/**
 * 参数值 → 可读文本。
 *
 * 字符串原样输出（`path=/srv/app` 比 `path="/srv/app"` 好读，且引号在窄列里浪费
 * 宽度）；对象/数组/null 走 JSON，保证「复杂值也看得见形状」。
 */
export function argValueText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // 循环引用等无法序列化的值：退化为 String()，不能因为一个值崩掉整个审批视图
    return String(value);
  }
}

/** 把 argsJson 摊平成保持后端键序的键值条目表（非对象/空值 → 空表）。 */
export function argsEntries(args: Record<string, unknown> | null | undefined): ArgsEntry[] {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
  return Object.entries(args).map(([key, value]) => {
    const text = argValueText(value);
    return { key, text, long: text.length > ARGS_LONG_VALUE_CHARS };
  });
}

/**
 * 参数摘要：前 `limit` 项 `key=value`（单值按 ARGS_SUMMARY_VALUE_CHARS 截短）+
 * 溢出计数。纯函数、零 i18n——「等 N 项」的措辞由调用方拼词条。
 */
export function argsSummary(
  args: Record<string, unknown> | null | undefined,
  limit = 3,
): { pairs: string[]; rest: number } {
  const entries = argsEntries(args);
  return {
    pairs: entries.slice(0, limit).map((e) => {
      const short = e.text.length > ARGS_SUMMARY_VALUE_CHARS
        ? `${e.text.slice(0, ARGS_SUMMARY_VALUE_CHARS)}…`
        : e.text;
      return `${e.key}=${short}`;
    }),
    rest: Math.max(0, entries.length - limit),
  };
}
