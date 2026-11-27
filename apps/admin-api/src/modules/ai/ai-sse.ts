/**
 * OpenAI 兼容 **流式（SSE）分帧**（纯函数，可单测）。
 *
 * ## 为什么单独抽出
 * 网络分片不会按帧切：一次 `data:` 可能只到一半，下一块才补齐；`\r\n` 与
 * `\n` 混用也常见。把"缓冲 + 切帧 + 解析 JSON"写成纯函数，才能把这类
 * **只在慢网络下才出现**的问题钉在单测里（真机跑一百次也未必撞上一次）。
 *
 * ## 协议要点（OpenAI 兼容）
 * ```
 * data: {"choices":[{"delta":{"content":"你"}}]}
 * data: {"choices":[{"delta":{"content":"好"}}]}
 * data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}
 * data: [DONE]
 * ```
 * - `usage` 通常只在**最后一个** chunk 出现（部分 provider 需要
 *   `stream_options.include_usage=true`，不支持的会忽略该参数）；
 * - `delta.content` 可能是空串/缺失（工具调用轮、心跳帧）；
 * - `[DONE]` 不一定有（连接先断），所以"流结束"还要以 reader 结束为准。
 */

export interface SseFrame {
  event: string;
  data: string;
}

/**
 * 从缓冲区切出完整帧，返回剩余未完成的尾巴。
 *
 * 事件以空行分隔（`\n\n` 或 `\r\n\r\n`）；同一帧内允许多行 `data:`
 * （SSE 规范：多行按 `\n` 拼接）。注释行（`:` 开头，常见心跳）忽略。
 */
export function parseSseFrames(buffer: string): {
  frames: SseFrame[];
  rest: string;
} {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const rest = parts.pop() ?? "";
  const frames: SseFrame[] = [];

  for (const block of parts) {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.length === 0 || line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (dataLines.length > 0) {
      frames.push({ event, data: dataLines.join("\n") });
    }
  }
  return { frames, rest };
}

export interface StreamToolCallDelta {
  /** 并行工具调用的序号索引（默认从 0 起）。 */
  index: number;
  /** 工具调用唯一编号（通常仅在首帧出现）。 */
  id?: string;
  /** 目标函数名称（通常在首帧出现，部分端点可能分片下发）。 */
  name?: string;
  /** JSON 参数增量片段。 */
  argumentsDelta?: string;
}

export interface StreamDelta {
  /** 本帧新增的文本（可能为空串）。 */
  text: string;
  /** 本帧新增的思考链文本（reasoning_content / reasoning）。 */
  reasoning?: string;
  /** 本帧携带的工具调用增量（delta.tool_calls）。 */
  toolCallDeltas?: StreamToolCallDelta[];
  /** 上游返回的结束原因（stop / length / tool_calls 等）。 */
  finishReason?: string;
  /** 本帧是否宣告结束（`[DONE]` 或携带终止 finish_reason）。 */
  done: boolean;
  /** 本帧携带的 usage（通常只在最后一帧）。 */
  usage?: { tokensIn: number; tokensOut: number; cachedTokens?: number };
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function extractToolCallDeltas(raw: unknown): StreamToolCallDelta[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const deltas: StreamToolCallDelta[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const index =
      typeof rec.index === "number" &&
      Number.isInteger(rec.index) &&
      rec.index >= 0
        ? rec.index
        : i;
    const id =
      typeof rec.id === "string" && rec.id.length > 0 ? rec.id : undefined;
    const fn =
      rec.function && typeof rec.function === "object"
        ? (rec.function as Record<string, unknown>)
        : undefined;
    const name =
      typeof fn?.name === "string" && fn.name.length > 0 ? fn.name : undefined;
    let argumentsDelta: string | undefined;
    if (typeof fn?.arguments === "string") {
      if (fn.arguments.length > 0) argumentsDelta = fn.arguments;
    } else if (fn?.arguments !== undefined && fn?.arguments !== null) {
      argumentsDelta = JSON.stringify(fn.arguments);
    }
    if (
      id !== undefined ||
      name !== undefined ||
      argumentsDelta !== undefined
    ) {
      deltas.push({
        index,
        ...(id !== undefined ? { id } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(argumentsDelta !== undefined ? { argumentsDelta } : {}),
      });
    }
  }
  return deltas;
}

/** 解析一帧 `data:` 的载荷；不认识/畸形 → null（忽略而不中断整条流）。 */
export function parseStreamDelta(json: string): StreamDelta | null {
  const text = (json ?? "").trim();
  if (!text) return null;
  if (text === "[DONE]") return { text: "", done: true };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  // 业务错误帧（DashScope 等在流中回错误是常见形态）
  const error = obj.error as { message?: unknown } | undefined;
  if (error) {
    const msg =
      typeof error.message === "string" ? error.message : "stream error";
    throw new Error(msg);
  }

  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const delta = first?.delta as Record<string, unknown> | undefined;
  const piece = typeof delta?.content === "string" ? delta.content : "";
  const reasoning =
    typeof delta?.reasoning_content === "string" &&
    delta.reasoning_content.length > 0
      ? delta.reasoning_content
      : typeof delta?.reasoning === "string" && delta.reasoning.length > 0
        ? delta.reasoning
        : undefined;
  const toolCallDeltas = extractToolCallDeltas(delta?.tool_calls);
  const finishReason =
    typeof first?.finish_reason === "string" && first.finish_reason.length > 0
      ? first.finish_reason
      : undefined;

  const usageRaw = obj.usage as Record<string, unknown> | undefined;
  const usage = usageRaw
    ? {
        tokensIn: num(usageRaw.prompt_tokens),
        tokensOut: num(usageRaw.completion_tokens),
        ...(() => {
          const details =
            (usageRaw.prompt_tokens_details as
              Record<string, unknown> | undefined) ??
            (usageRaw.input_tokens_details as
              Record<string, unknown> | undefined);
          const cached = num(details?.cached_tokens ?? usageRaw.cached_tokens);
          return cached > 0 ? { cachedTokens: cached } : {};
        })(),
      }
    : undefined;

  return {
    text: piece,
    done:
      finishReason === "stop" ||
      finishReason === "length" ||
      finishReason === "tool_calls",
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(toolCallDeltas.length > 0 ? { toolCallDeltas } : {}),
    ...(finishReason !== undefined ? { finishReason } : {}),
    ...(usage ? { usage } : {}),
  };
}
