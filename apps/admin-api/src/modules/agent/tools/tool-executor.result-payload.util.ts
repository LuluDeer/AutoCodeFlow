/**
 * R43（2026-11-05）：`tool-executor` 尾部的**结果落库载荷整形**（纯函数，不碰 DB/事件/状态机）。
 *
 * 从 `execute`（当时 619 行，R39/R40 的接线困难即其直接后果）里整段搬出，语义逐字保持：
 * · 未截断 ⇒ `result` 直接是脱敏后的数据；
 * · 截断 ⇒ `{ truncated:true, sha256, preview, (可选) full }`，`full` 只在脱敏副本 ≤ 32KB 时给
 *   （供 `get_tool_call_result` 回读，避免模型为看完整结果重跑有副作用的工具）。
 */
import type { } from "node:util";

/** 结果全文入库上限（与 `tool-executor.service.ts` 的 `TOOL_RESULT_FULL_MAX_CHARS` 同源语义）。 */
export const TOOL_RESULT_FULL_MAX_CHARS = 32_768;

export function buildPersistedResultPayload(input: {
  persistedData: unknown;
  sanitizedFull: string;
  serialized: string;
  truncated: boolean;
  sha256: string;
}): { result: Record<string, unknown>; resultTruncated: boolean } {
  const { persistedData, sanitizedFull, truncated, sha256 } = input;
  if (!truncated) {
    return {
      result: persistedData as Record<string, unknown>,
      resultTruncated: false,
    };
  }
  const preview = JSON.stringify(persistedData, null, 2).slice(0, 500);
  return {
    result: {
      truncated: true,
      sha256,
      preview,
      ...(sanitizedFull.length <= TOOL_RESULT_FULL_MAX_CHARS
        ? { full: sanitizedFull }
        : {}),
    } as Record<string, unknown>,
    resultTruncated: true,
  };
}
