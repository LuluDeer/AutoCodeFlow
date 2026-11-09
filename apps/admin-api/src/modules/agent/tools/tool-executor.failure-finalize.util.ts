/**
 * R67（ADR-031 步骤 4/5 第三刀）：**失败/超时出口的纯计算**——从 `execute` 的
 * `catch` 分支整段搬出（不碰 DB / 事件 / 熔断记账，只算「落什么库、回什么话」）。
 *
 * 搬出的核心是那个**有语义分叉的判断**（缺陷 A ②）：
 *   写/危险 tier 的**超时** ≠ 调用失败，而是「结果未知」——
 *   · 回给模型的语义是「先只读核实、不要重试」（重试 = 双份副作用）；
 *   · **不**计入熔断的连续失败（「未知」不改变连续失败计数）。
 *   只读工具没有副作用（重试安全）⇒ 超时仍按失败处理。
 *
 * 这三个后果（observation / patch / 是否记账）由本模块一次算出，调用方只负责
 * 三件带副作用的事：落库、写日志、记熔断。这样「判断」只有一份实现，
 * 而「副作用」仍在 service 里可被 spy 断言。
 */

export interface ToolFailureInput {
  /** 会话 id（只用于 warn 文案，与既有日志格式逐字一致）。 */
  sessionId: string;
  /** 原始错误消息（未脱敏；本模块只读它判断超时）。 */
  message: string;
  /** 是否超时（`ToolTimeoutError` 或消息含 timed out；由调用方判定后传入）。 */
  isTimeout: boolean;
  /** 工具 tier（决定超时是否按「结果未知」处理）。 */
  tier: "read" | "write" | "dangerous" | string;
  toolName: string;
  /** 超时阈值（用于文案）。 */
  timeoutMs: number;
  durationMs: number;
  /** 已脱敏的错误消息（调用方用 `sanitizeString` 产出，唯一实现）。 */
  safeMessage: string;
  /**
   * 本次调用已消耗一张一次性审批单时的补充指引（`buildConsumeDenialMessage(...)`）；
   * null = 没有消耗过审批单。
   */
  consumeHint: string | null;
}

export interface ToolFailureFinalization {
  /** `unknown_timeout` = 结果未知（写类超时）；`failed` = 寻常失败。 */
  kind: "unknown_timeout" | "failed";
  /** 落库载荷（`status`/`errorMessage`/`durationMs`/`stateChangedAt`）。 */
  patch: {
    status: "timeout" | "error";
    errorMessage: string;
    durationMs: number;
    stateChangedAt: Date;
  };
  /** 回给模型的观察结果。 */
  observation: { content: string; truncated: boolean };
  /** 需要调用方打的 warn 全文；null = 不打。 */
  warnLog: string | null;
  /** 是否应记一次「熔断连续失败」（`unknown_timeout` 时**为 false**）。 */
  recordFailure: boolean;
}

/**
 * 收敛一次工具执行的失败出口。
 *
 * 纯函数（`stateChangedAt` 取当前时刻，是「窗口关闭时刻」的单一实现）。
 */
export function finalizeToolFailure(
  input: ToolFailureInput,
): ToolFailureFinalization {
  const { isTimeout, tier, toolName, timeoutMs, safeMessage, consumeHint } =
    input;
  const durationMs = input.durationMs;

  if (isTimeout && tier !== "read") {
    return {
      kind: "unknown_timeout",
      patch: {
        // status 仍记 timeout：审计要能按「超时」筛出这类调用（与 error 区分）
        status: "timeout",
        errorMessage: `结果未知（超时）：${input.message}`,
        durationMs,
        // C2：窗口关闭时刻（结果未知也是终局，时间戳让审计能圈出未知窗口）
        stateChangedAt: new Date(),
      },
      observation: {
        content:
          `【结果未知（超时）】工具 ${toolName} 超过 ${timeoutMs}ms 未返回，` +
          `本次调用可能已经生效（副作用可能已发生），但没有回执。` +
          `请先用只读工具核实（例如 list_executions / get_execution）本次调用是否落地，` +
          `不要直接重试同一写调用——重复执行会产生双份副作用。`,
        truncated: false,
      },
      warnLog:
        `Agent tool timeout (write tier, outcome unknown): session=${input.sessionId} ` +
        `tool=${toolName} tier=${tier} — ${input.message}`,
      // 「未知」既不记 true 也不记 false —— 不改变连续失败计数。
      recordFailure: false,
    };
  }

  const errorMessage = consumeHint
    ? `${safeMessage}；${consumeHint}`
    : safeMessage;
  return {
    kind: "failed",
    patch: {
      status: isTimeout ? "timeout" : "error",
      errorMessage,
      durationMs,
      // C2：窗口关闭时刻（只读超时 / 普通失败都是终局）
      stateChangedAt: new Date(),
    },
    observation: {
      content: consumeHint
        ? `【调用失败】${safeMessage}；${consumeHint}`
        : `【调用失败】${safeMessage}`,
      truncated: false,
    },
    warnLog: null,
    recordFailure: true,
  };
}
