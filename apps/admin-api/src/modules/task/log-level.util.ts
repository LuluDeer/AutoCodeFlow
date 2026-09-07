/**
 * OBS-03: 执行日志行级别推断——纯函数，零状态、零 IO。
 *
 * 背景：execution_log_lines 的 content 是纯文本行，详情页无法按级别过滤。
 * 写入路径（storeLogLines）为每行调用 levelOfLine 推断级别并落库到
 * execution_log_lines.level（可空）。
 *
 * 流来源说明（已核实 apps/executor-node/src/routes/execute.ts 的 runProcess）：
 * 执行器把子进程的 stdout 与 stderr 追加进同一个 BoundedLogBuffer 后整体
 * 回传（回调 `logs` 字段是合流字符串，DTO 亦无流来源字段），admin-api
 * 收到的文本不带任何 stdout/stderr 流标记，因此没有流来源信号可用——
 * 级别只能从行文本本身推断，推断不到返回 null（= 未知级别）。
 *
 * 识别形态（大小写不敏感）：
 * - 行首直接标注：[ERROR] msg / ERROR: msg / INFO msg 等（括号可选）；
 * - 时间戳前缀后标注：2026-09-06 12:00:00 [WARN] ...、
 *   2026-09-06T12:00:00.123Z error ...、[2026/09/06 12:00:00] [INFO] ...、
 *   12:00:00,123 debug ...、Sep  6 12:00:00 INFO ...（时间/日期均可选带
 *   毫秒与时区，分隔符支持 - 与 /）；
 * - WARNING 归一化为 WARN（值域四值：ERROR/WARN/INFO/DEBUG）；
 * - 只认"级别词 + 完整边界"（后随空白/冒号/括号闭合）——ERRORS、
 *   information、debugger 等非级别词一律推断不到。
 *
 * 明确不识别（返回 null，避免误报）：
 * - 级别词出现在行中间（"the error was handled"）；
 * - FATAL/CRITICAL/TRACE 等值域外级别（保持值域严格，不强行折叠）；
 * - 空行/纯空白行、只有时间戳没有级别标注的行。
 */

export type LogLevel = "ERROR" | "WARN" | "INFO" | "DEBUG";

/** level 列的合法值域（迁移注释、查询参数枚举校验、文档共用同一口径） */
export const LOG_LEVEL_VALUES: readonly LogLevel[] = [
  "ERROR",
  "WARN",
  "INFO",
  "DEBUG",
];

/** 级别词 → 归一化级别；WARNING 折叠进 WARN */
const LEVEL_WORDS: Readonly<Record<string, LogLevel>> = {
  ERROR: "ERROR",
  WARN: "WARN",
  WARNING: "WARN",
  INFO: "INFO",
  DEBUG: "DEBUG",
};

/**
 * 行首可剥离的时间戳前缀（剥离后剩余文本再做级别匹配）：
 * - `2026-09-06 12:00:00` / `2026-09-06T12:00:00.123Z` / `2026/09/06 12:00:00+08:00`
 *   （日期可选，`T` 或空格分隔，毫秒/时区可选，分隔符支持 - 与 /）；
 * - 方括号形式 `[2026-09-06 12:00:00]`；
 * - 纯时间 `12:00:00` / `12:00:00,123`。
 * 前缀与级别标注之间允许任意空白（含多空格）。
 */
const TIMESTAMP_PREFIX_RE =
  /^\s*(?:\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\[\d{4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}:\d{2}\]|\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)\s*/;

/**
 * 级别标记：[ERROR] / ERROR: / warn 等（括号可选，冒号或空白收尾）。
 * - 大小写不敏感；
 * - 允许行首任意空白（无时间戳前缀时的缩进/多空格形态）；
 * - 要求级别词后有边界（冒号/空白），防止把 "information overload" 的
 *   INFO、debugger 的 DEBUG 误判为级别标注。
 */
const LEVEL_MARKER_RE = /^\s*\[?(ERROR|WARN|WARNING|INFO|DEBUG)\]?[:\s]/i;

/**
 * 从一行日志文本推断级别；推断不到返回 null。
 *
 * - 大小写不敏感（[error] / Error: / info 均可识别）；
 * - 支持行首直接标注与"时间戳前缀后标注"两种形态；
 * - WARNING 归一化为 WARN；
 * - 非级别词 / 空行 / 纯空白行 / 只有时间戳的行 → null。
 */
export function levelOfLine(line: string | null | undefined): LogLevel | null {
  if (typeof line !== "string" || line.length === 0) return null;
  const withoutTimestamp = line.replace(TIMESTAMP_PREFIX_RE, "");
  const m = LEVEL_MARKER_RE.exec(withoutTimestamp);
  if (!m) return null;
  return LEVEL_WORDS[m[1].toUpperCase()] ?? null;
}
