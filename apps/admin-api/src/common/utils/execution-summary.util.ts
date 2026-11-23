/**
 * rt-3：执行终态「摘要」口径的单一来源（事件载荷 `logHead` + 告警摘要共用）。
 *
 * ## 为什么需要它
 * 终态事件 `ExecutionTerminalEventPayload` 此前直接携带回调原始 `logs`
 * （DTO 上限 512_000 字符）。这个载荷会被（a）`JSON.stringify` 后 PUBLISH 到
 * Redis（逐副本一份）、（b）每个 `/executions/stream` SSE 连接各自再
 * `JSON.stringify` 一遍写 socket，而全仓唯一消费方只取**第一行**做告警回退。
 * 事件总线只应传「事实 + 句柄」，日志全文属于数据面（DB `task_executions.logs`
 * / S3 对象），由 `GET /tasks/:id/executions/:execId/logs` 一次性拉取。
 *
 * ## 口径
 * 500 字符——与 `execution-events.listener.ts` 的 `errorSummary` 既有截断
 * （`${failureReason}: ${detail}` 后 `.slice(0, 500)`）**同一个常量**，不是新
 * 数字：告警摘要与事件 `logHead` 都只用于「一眼看出是哪类问题」，长度越界对
 * 两处都无信息增量。
 */

/**
 * 终态摘要硬上限（字符）。`logHead` 与 `errorSummary` 共用此值。
 *
 * 命名刻意用「摘要」而非「日志」：本常量约束的是**进事件/告警的派生摘要**，
 * 与回调 DTO 的 `logs` 上限（512_000，见 `dto/execution-callback.dto.ts`）
 * 是两个完全不同的口径——后者是持久化输入，前者是广播输出。
 */
export const EXECUTION_SUMMARY_MAX_CHARS = 500;

/**
 * 取文本的首行。
 *
 * `\r\n` / `\n` / `\r` 均视为行分隔符，且**返回值不含行终止符**——旧实现
 * `logs.split("\n")[0]` 在 Windows 换行下会把尾随 `\r` 带进告警摘要（渲染成
 * 一行内多余回车），这里按行语义归一。
 *
 * 逐字符扫描而非 `split("\n")`：输入最大 512KB，`split` 会为**全部**行分配
 * 子串（数万个）只为取 `[0]`；本函数在首个行终止符处即停止，成本与首行长度
 * 成正比（与 rt-3「别为大字符串做全量派生」同一纪律）。
 */
export function firstLineOf(text: string): string {
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    // 10 = \n, 13 = \r
    if (ch === 10 || ch === 13) return text.slice(0, i);
  }
  return text;
}

/**
 * 派生终态事件载荷的 `logHead`：首行 + 硬切 {@link EXECUTION_SUMMARY_MAX_CHARS}。
 *
 * - 空/未提供 → `""`（类型上仍是必给的 string，消费方无需判空分支）。
 * - 首行超上限 → 截断（**不**加省略号：与 `errorSummary` 的 `.slice(0, 500)`
 *   逐字同口径，避免两处摘要尾部形态不一致）。
 * - 单行 512KB 无换行 → 只返回前 500 字符。
 */
export function logHeadOf(
  logs: string | null | undefined,
  max: number = EXECUTION_SUMMARY_MAX_CHARS,
): string {
  if (!logs) return "";
  const line = firstLineOf(logs);
  return line.length > max ? line.slice(0, max) : line;
}

/**
 * 通用「进程退出骨架」文案判定（node / python 两端执行器同形）：
 * - `进程以退出码 N 结束`
 * - `进程被信号 <SIG> 终止…`
 *
 * 这类骨架只说明「进程没跑成」，原始 throw 消息 / 异常类型留在回调 `logs`
 * 的栈里（D-3 实测：Node `Error: demo intentional failure…` 在 stderr 栈中，
 * 落库摘要只有退出码）。
 */
const GENERIC_PROCESS_EXIT_MESSAGE_RE =
  /^进程以退出码\s*\d+\s*结束|^进程被信号\s*\S+\s*终止/i;

/**
 * 日志里的「原始异常行」候选：JS/TS 栈的 `Error: 消息`、Python 栈尾的
 * `XxxError / XxxException: 消息`。栈帧行（`at …`、`File "…"`、`^`  caret）
 * 不匹配。
 */
const ERROR_LINE_RE =
  /^(?:[A-Za-z_$][\w$.]*)?(?:Error|Exception|Interrupt|Failure):\s*(.+)$/;

/**
 * 从回调日志中提取最能定位问题的异常行（**栈尾优先**：Python Traceback 的
 * 真实错误行在最后；JS 栈一般只有一条 `Error:` 行，链式 cause 也取最后一条）。
 *
 * 找不到异常形态行时返回 `null`——不回退到任意 stdout 行（那可能是任务正常
 * 打印，不是错误）；调用方保留原骨架文案。
 */
function extractErrorLineFromLogs(logs: string): string | null {
  const lines = logs.split(/\r?\n/);
  let last: string | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    const m = ERROR_LINE_RE.exec(line);
    if (m && m[1].trim()) last = m[1].trim();
  }
  return last;
}

/**
 * D-3：失败摘要补全——骨架文案时从 `logs` 上提原始异常消息。
 *
 * - 摘要已经是可读原因（非退出码 / 信号骨架）→ 原样返回，不改动。
 * - 骨架文案 + `logs` 含异常行 → 返回「原始异常消息（骨架旁证）」，上限
 *   {@link EXECUTION_SUMMARY_MAX_CHARS}（与 `logHead` / `errorSummary` 同口径，
 *   不加省略号；完整栈与退出码仍在 DB `logs` / `exitCode` 列，不丢全文）。
 * - 骨架文案但 `logs` 无可识别异常行 → 原样返回骨架（不硬造消息）。
 *
 * `errorMessage` 非字符串时原样返回（类型上与回调 DTO 的可空字符串对齐）。
 */
export function summarizeScriptFailure(
  errorMessage: unknown,
  logs: string | null | undefined,
  max: number = EXECUTION_SUMMARY_MAX_CHARS,
): string | undefined {
  if (typeof errorMessage !== "string" || errorMessage.trim() === "") {
    return errorMessage as string | undefined;
  }
  const trimmed = errorMessage.trim();
  if (!GENERIC_PROCESS_EXIT_MESSAGE_RE.test(trimmed)) {
    return errorMessage;
  }
  if (!logs) return errorMessage;
  const extracted = extractErrorLineFromLogs(logs);
  if (!extracted) return errorMessage;
  const summary = extracted.length > max ? extracted.slice(0, max) : extracted;
  // 保留退出码骨架作为旁证：用户既能看到原始消息，也不丢「怎么退出的」；
  // 完整栈仍在 logs 列。
  return `${summary}（${trimmed}）`;
}
