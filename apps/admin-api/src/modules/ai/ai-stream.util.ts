import {
  parseSseFrames,
  parseStreamDelta,
  type StreamToolCallDelta,
} from "./ai-sse";
import { normalizeToolCalls } from "./llm-response";
import type { ToolCall } from "./ai.service";

export interface MultimodalStreamHandlers {
  onDelta?: (text: string) => void;
  onReasoningDelta?: (text: string) => void;
  onToolCallDelta?: (delta: StreamToolCallDelta) => void;
  signal?: AbortSignal;
}

export interface StreamedCompletionResult {
  content: string;
  reasoning: string;
  toolCalls?: ToolCall[];
  finishReason?: string;
  usage: { tokensIn: number; tokensOut: number; cachedTokens?: number };
}

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** 构造标准 AbortError（保留 AbortError 名称以便调用方按名称分流中止与真失败）。 */
export function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error && reason.name === "AbortError") {
    return reason;
  }
  const message =
    typeof reason === "string" && reason.trim().length > 0
      ? reason.trim()
      : "流式推理请求已中止";
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

/** 按 index 累加流式工具调用增量片段。 */
export function accumulateToolCallDelta(
  acc: Map<number, PendingToolCall>,
  delta: StreamToolCallDelta,
): void {
  let entry = acc.get(delta.index);
  if (!entry) {
    entry = { id: "", name: "", arguments: "" };
    acc.set(delta.index, entry);
  }
  if (delta.id && !entry.id) {
    entry.id = delta.id;
  }
  if (delta.name) {
    if (!entry.name) {
      entry.name = delta.name;
    } else if (entry.name !== delta.name) {
      entry.name += delta.name;
    }
  }
  if (delta.argumentsDelta) {
    entry.arguments += delta.argumentsDelta;
  }
}

/** 将按 index 累加的片段转为与同步 `chatMultimodal` 同口径的 `ToolCall[]`。 */
export function finalizeStreamToolCalls(
  acc: Map<number, PendingToolCall>,
): ToolCall[] | undefined {
  if (acc.size === 0) return undefined;
  const raw = Array.from(acc.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, entry]) => ({
      id: entry.id || undefined,
      type: "function" as const,
      function: {
        name: entry.name,
        arguments: entry.arguments.length > 0 ? entry.arguments : undefined,
      },
    }));
  return normalizeToolCalls(raw);
}

function safeDestroyStream(stream: NodeJS.ReadableStream): void {
  const destroyable = stream as NodeJS.ReadableStream & {
    destroy?: () => void;
  };
  if (typeof destroyable.destroy === "function") {
    try {
      destroyable.destroy();
    } catch {
      /* 忽略流销毁过程中的次生错误 */
    }
  }
}

/**
 * 消费 OpenAI 兼容 SSE 流：聚合正文、思考链、并行工具调用增量与用量，
 * 并在 `handlers.signal` 触发时立即销毁底层流并抛出 AbortError。
 */
export async function consumeOpenAiSseStream(
  stream: NodeJS.ReadableStream,
  handlers: MultimodalStreamHandlers = {},
): Promise<StreamedCompletionResult> {
  if (handlers.signal?.aborted) {
    safeDestroyStream(stream);
    throw createAbortError(handlers.signal.reason);
  }

  let content = "";
  let reasoning = "";
  let finishReason: string | undefined;
  let usage: { tokensIn: number; tokensOut: number; cachedTokens?: number } = {
    tokensIn: 0,
    tokensOut: 0,
  };
  const toolCallAcc = new Map<number, PendingToolCall>();

  const applyFrames = (
    frames: ReturnType<typeof parseSseFrames>["frames"],
  ): void => {
    for (const frame of frames) {
      const delta = parseStreamDelta(frame.data);
      if (!delta) continue;
      if (delta.usage) usage = delta.usage;
      if (delta.finishReason) finishReason = delta.finishReason;
      if (delta.reasoning) {
        reasoning += delta.reasoning;
        try {
          handlers.onReasoningDelta?.(delta.reasoning);
        } catch {
          // 下游回调异常不中断已开始的模型推理流
        }
      }
      if (delta.toolCallDeltas && delta.toolCallDeltas.length > 0) {
        for (const tcDelta of delta.toolCallDeltas) {
          accumulateToolCallDelta(toolCallAcc, tcDelta);
          try {
            handlers.onToolCallDelta?.(tcDelta);
          } catch {
            // 下游回调异常不中断工具调用聚合
          }
        }
      }
      if (delta.text) {
        content += delta.text;
        try {
          handlers.onDelta?.(delta.text);
        } catch {
          // 下游（HTTP 连接）断了不该中断已产生的推理——继续收完
        }
      }
    }
  };

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const signal = handlers.signal;

    const cleanup = () => {
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };

    const fail = (err: unknown, destroy = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (destroy) safeDestroyStream(stream);
      reject(err);
    };

    const onAbort = () => {
      fail(createAbortError(signal?.reason), true);
    };

    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      try {
        const parsedFrames = parseSseFrames(buffer);
        buffer = parsedFrames.rest;
        applyFrames(parsedFrames.frames);
      } catch (err) {
        fail(err, true);
      }
    };

    const onEnd = () => {
      if (settled) return;
      if (buffer.trim().length > 0) {
        try {
          const trailing = parseSseFrames(`${buffer}\n\n`);
          applyFrames(trailing.frames);
        } catch (err) {
          fail(err, false);
          return;
        }
      }
      settled = true;
      cleanup();
      resolve();
    };

    const onError = (err: Error) => {
      if (signal?.aborted) {
        fail(createAbortError(signal.reason), false);
        return;
      }
      fail(err, false);
    };

    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    }
  });

  const toolCalls = finalizeStreamToolCalls(toolCallAcc);
  return {
    content,
    reasoning,
    ...(toolCalls ? { toolCalls } : {}),
    ...(finishReason ? { finishReason } : {}),
    usage,
  };
}
