/**
 * OBS-03: 执行日志行级别推断（前端侧）——与 admin-api
 * apps/admin-api/src/modules/task/log-level.util.ts 保持同一推断口径，
 * 用于日志详情页的行级高亮（.log-line-error / .log-line-warn）。
 *
 * 识别形态（大小写不敏感，与后端逐条对齐）：
 * - 行首直接标注：[ERROR] msg / ERROR: msg / INFO msg 等（括号可选）；
 * - 时间戳前缀后标注：2026-09-06 12:00:00 [WARN] ...、
 *   2026-09-06T12:00:00.123Z error ...、[2026/09/06 12:00:00] [INFO] ...、
 *   12:00:00,123 debug ...；
 * - WARNING 归一化为 WARN（值域四值：ERROR/WARN/INFO/DEBUG）；
 * - 只认"级别词 + 完整边界"——ERRORS、information、debugger 等非级别词
 *   一律推断不到；行中间的级别词 / 空行 / 只有时间戳的行 → null。
 */

export type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';

/** 级别过滤下拉值域（与后端 log-level.util.ts LOG_LEVEL_VALUES 对齐） */
export const LOG_LEVEL_VALUES: readonly LogLevel[] = [
  'ERROR',
  'WARN',
  'INFO',
  'DEBUG',
];

/** 级别词 → 归一化级别；WARNING 折叠进 WARN */
const LEVEL_WORDS: Readonly<Record<string, LogLevel>> = {
  ERROR: 'ERROR',
  WARN: 'WARN',
  WARNING: 'WARN',
  INFO: 'INFO',
  DEBUG: 'DEBUG',
};

/**
 * 行首可剥离的时间戳前缀（剥离后剩余文本再做级别匹配）：
 * - `2026-09-06 12:00:00` / `2026-09-06T12:00:00.123Z` / `2026/09/06 12:00:00+08:00`；
 * - 方括号形式 `[2026-09-06 12:00:00]`；
 * - 纯时间 `12:00:00` / `12:00:00,123`。
 * 与后端 TIMESTAMP_PREFIX_RE 逐字符一致。
 */
const TIMESTAMP_PREFIX_RE =
  /^\s*(?:\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\[\d{4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}:\d{2}\]|\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)\s*/;

/**
 * 级别标记：[ERROR] / ERROR: / warn 等（括号可选，冒号或空白收尾）。
 * 大小写不敏感；要求级别词后有边界（冒号/空白）。
 * 与后端 LEVEL_MARKER_RE 逐字符一致。
 */
const LEVEL_MARKER_RE = /^\s*\[?(ERROR|WARN|WARNING|INFO|DEBUG)\]?[:\s]/i;

/**
 * 从一行日志文本推断级别；推断不到返回 null（= 未知级别，不做高亮、
 * 服务端 level 过滤时也不会命中——后端 level 列为 NULL 的行被排除）。
 */
export function levelOfLine(line: string | null | undefined): LogLevel | null {
  if (typeof line !== 'string' || line.length === 0) return null;
  const withoutTimestamp = line.replace(TIMESTAMP_PREFIX_RE, '');
  const m = LEVEL_MARKER_RE.exec(withoutTimestamp);
  if (!m) return null;
  return LEVEL_WORDS[m[1].toUpperCase()] ?? null;
}

/**
 * OBS-03: 行级高亮类名——ERROR 红 / WARN 黄，其余（INFO/DEBUG/未知）返回
 * 空串（渲染为纯文本节点，不为万行日志制造海量 React 元素）。
 */
export function logLineHighlightClass(line: string): string {
  const level = levelOfLine(line);
  if (level === 'ERROR') return 'log-line-error';
  if (level === 'WARN') return 'log-line-warn';
  return '';
}
