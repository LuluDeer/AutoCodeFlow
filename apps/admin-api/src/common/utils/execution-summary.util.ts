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
