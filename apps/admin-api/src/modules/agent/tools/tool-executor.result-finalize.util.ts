/**
 * R67（ADR-031 步骤 4/5 第二刀）：**结果整形与终局载荷**——从 `execute` 尾部
 * 整段搬出的纯计算（不读库、不写库、不碰状态机）。
 *
 * 输入只有「工具回执 + 已耗时 + 三个注入项」；输出是两组数据：
 *   · `patch`  —— 落库用的载荷片段（`persist` 的其余字段由 `execute` 补）；
 *   · `observation` —— 回给模型的那条观察结果。
 *
 * 注入（而不是 import）的三个东西，都是为了**不造环**、且让本模块零依赖可独立单测：
 *   · `sanitizeResult` / `sha256` —— service 的既有方法；
 *   · `maxChars` —— service 的 `TOOL_RESULT_MAX_CHARS`（常量在 service 里，
 *     import 它会形成 `service → 本模块 → service` 的环；由调用方传值即可）。
 *
 * 语义逐字保持（R41/R43 的取舍一个字都没改）：
 *   · 回给模型的 content 用**原文** `serialized`（模型要从日志里读事实）；
 *   · 落库副本走 `sanitizeResult`（长期保留、进审计详情页）；
 *   · `sha256` 按**原文**算（用途是与源数据对账，算脱敏后的串就失去意义）。
 */
import { buildPersistedResultPayload } from "./tool-executor.result-payload.util";
import { shapeToolResultForModel } from "./tool-result-shaping";

export interface ToolResultFinalizationInput {
  /** 工具的原始回执数据（未脱敏）。 */
  data: unknown;
  /** 工具是否以「失败」结束（`ApiCallResult.isError`）。 */
  isError: boolean;
  /** 工具自报的错误文案（`isError` 时回给模型）。 */
  errorMessage?: string | null;
  /** 本次调用耗时（毫秒）。 */
  durationMs: number;
  /** 模型侧结果上限（= service 的 `TOOL_RESULT_MAX_CHARS`）。 */
  maxChars: number;
  /** 结果脱敏（service 的 `sanitizeResult`）。 */
  sanitizeResult: (data: unknown) => unknown;
  /** 原文摘要（service 的 `sha256`）。 */
  sha256: (s: string) => string;
}

/** 落库载荷片段（不含 sessionId/stepId/toolCallId/toolName/tier/args）。 */
export interface ToolResultPersistPatch {
  result: Record<string, unknown>;
  resultTruncated: boolean;
  status: "ok" | "error";
  errorMessage: string | null;
  durationMs: number;
  stateChangedAt: Date;
}

/** 回给模型的观察结果。 */
export interface ToolObservation {
  content: string;
  truncated: boolean;
}

export interface ToolResultFinalization {
  /** 模型侧看的原始序列化（也用于算 sha256）。 */
  serialized: string;
  /** 原始序列化是否超过模型侧上限。 */
  truncated: boolean;
  patch: ToolResultPersistPatch;
  observation: ToolObservation;
}

/**
 * 把「工具回执」收敛成「落库载荷 + 回给模型的观察结果」。
 *
 * 纯函数：同一输入必然同一输出（`stateChangedAt` 除外 —— 它是「迁移时刻」，
 * 在这里生成是为了让「窗口关闭时刻」只有一处实现）。
 */
export function finalizeToolResult(
  input: ToolResultFinalizationInput,
): ToolResultFinalization {
  const { data, isError, errorMessage, durationMs, maxChars } = input;
  // 模型侧看的序列化（原文）：content 必须保留事实，脱敏只针对持久化副本。
  const serialized = JSON.stringify(data, null, 2);
  const truncated = serialized.length > maxChars;

  // ── 缺陷 B：结果落库前同样脱敏 ─────────────────────────────────
  // 典型载荷：get_execution_logs 的日志行里有 `AUTOFLOW_TOKEN=…`、`Bearer …`。
  const persistedData = input.sanitizeResult(data);
  const sanitizedFull = JSON.stringify(persistedData, null, 2);

  const shaped = shapeToolResultForModel(serialized, maxChars);
  return {
    serialized,
    truncated,
    patch: {
      ...buildPersistedResultPayload({
        persistedData,
        sanitizedFull,
        serialized,
        truncated,
        sha256: input.sha256(serialized),
      }),
      status: isError ? "error" : "ok",
      errorMessage: errorMessage ?? null,
      durationMs,
      // C2：正常终局的迁移时刻（与 in_flight 成对，差值即本次调用耗时的事实口径）
      stateChangedAt: new Date(),
    },
    observation: isError
      ? {
          content: `【调用失败】${errorMessage ?? "未知错误"}`,
          truncated: false,
        }
      : { content: shaped.content, truncated: shaped.truncated },
  };
}
