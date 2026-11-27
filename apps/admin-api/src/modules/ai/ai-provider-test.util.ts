import { sanitizeSecrets } from "../../common/utils/sanitize-secrets.util";
import { AppError } from "../../common/errors/app-error";
import type { AiPurpose } from "./ai-providers";
import type { RouteResolution } from "./ai-route";
import type {
  MultimodalRequest,
  MultimodalResponse,
  ToolCall,
  ToolSchema,
} from "./ai.service";

export interface TestAiProviderOptions {
  providerId?: string;
  purpose?: AiPurpose;
  testStreaming?: boolean;
  testTools?: boolean;
}

export interface TestAiProviderResult {
  ok: boolean;
  provider: string | null;
  model: string | null;
  purpose: AiPurpose;
  latencyMs: number;
  message: string;
  errorCode: string | null;
  preview: string | null;
}

export const AI_TEST_PROBE_PROMPT = "请仅回复 OK，用于连通性检查。";

export const AI_TEST_PROBE_TOOLS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "ping_check",
      description: "用于校验模型端点是否支持工具声明透传（无需执行真实动作）",
      parameters: {
        type: "object",
        properties: {
          echo: { type: "string", description: "可选回显文本" },
        },
      },
    },
  },
];

type RouteErrorReason = Extract<RouteResolution, { status: "error" }>["reason"];

const ROUTE_REASON_TO_CODE: Record<RouteErrorReason, string> = {
  disabled: "AI_ROUTE_DISABLED",
  unknown_provider: "AI_ROUTE_UNKNOWN_PROVIDER",
  provider_disabled: "AI_ROUTE_PROVIDER_DISABLED",
  provider_denied: "AI_ROUTE_PROVIDER_DENIED",
  capability_missing: "AI_ROUTE_CAPABILITY_MISSING",
  missing_key: "AI_ROUTE_MISSING_KEY",
  invalid_config: "AI_ROUTE_INVALID_CONFIG",
};

export function routeReasonToErrorCode(reason: RouteErrorReason): string {
  return ROUTE_REASON_TO_CODE[reason] ?? "AI_ROUTE_ERROR";
}

function truncateText(text: string, maxLen = 240): string {
  const cleaned = sanitizeSecrets(text).replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen)}…` : cleaned;
}

/** 构造预览文本：优先正文，其次工具调用摘要，其次思考链。 */
export function formatTestPreview(
  content: string,
  toolCalls?: ToolCall[],
  reasoning?: string,
): string | null {
  const textPreview = truncateText(content);
  if (textPreview) return textPreview;
  if (toolCalls && toolCalls.length > 0) {
    const names = toolCalls.map((c) => c.function.name).join("、");
    return truncateText(`模型触发工具调用：${names}`);
  }
  if (reasoning) {
    const reasoningPreview = truncateText(reasoning);
    if (reasoningPreview) return reasoningPreview;
  }
  return null;
}

function extractUpstreamErrorDetail(data: unknown): string {
  if (!data) return "";
  if (typeof data === "string") return truncateText(data, 200);
  if (typeof data === "object") {
    const rec = data as Record<string, unknown>;
    const nestedError = rec.error;
    if (typeof nestedError === "string") return truncateText(nestedError, 200);
    if (nestedError && typeof nestedError === "object") {
      const msg = (nestedError as Record<string, unknown>).message;
      if (typeof msg === "string" && msg.trim()) return truncateText(msg, 200);
    }
    if (typeof rec.message === "string" && rec.message.trim()) {
      return truncateText(rec.message, 200);
    }
    if (typeof rec.detail === "string" && rec.detail.trim()) {
      return truncateText(rec.detail, 200);
    }
  }
  return "";
}

/**
 * 将上游 HTTP / 超时 / 网络 / 策略异常归一化为结构化诊断信息（不吞错、且脱敏）。
 */
export function classifyAiTestError(
  err: unknown,
  timeoutMs?: number,
): { errorCode: string; message: string } {
  if (err instanceof AppError) {
    return {
      errorCode: err.errorCode,
      message: truncateText(err.message, 300) || "模型配置校验未通过",
    };
  }
  const rec = (err && typeof err === "object" ? err : {}) as {
    errorCode?: unknown;
    code?: unknown;
    message?: unknown;
    response?: { status?: unknown; data?: unknown };
  };
  if (typeof rec.errorCode === "string" && rec.errorCode) {
    return {
      errorCode: rec.errorCode,
      message:
        truncateText(typeof rec.message === "string" ? rec.message : "", 300) ||
        "模型配置校验未通过",
    };
  }

  const status =
    typeof rec.response?.status === "number" ? rec.response.status : undefined;
  const rawMsg =
    err instanceof Error
      ? err.message
      : typeof rec.message === "string"
        ? rec.message
        : String(err);
  const safeMsg = truncateText(rawMsg, 240);

  if (status !== undefined) {
    const detail = extractUpstreamErrorDetail(rec.response?.data);
    const suffix = detail ? `：${detail}` : safeMsg ? `：${safeMsg}` : "";
    if (status === 401) {
      return {
        errorCode: "AI_HTTP_401_UNAUTHORIZED",
        message: `鉴权失败（HTTP 401）${suffix || "，请检查密钥是否有效"}`,
      };
    }
    if (status === 403) {
      return {
        errorCode: "AI_HTTP_403_FORBIDDEN",
        message: `访问被拒绝（HTTP 403）${suffix || "，请检查账号权限或模型配额"}`,
      };
    }
    if (status === 404) {
      return {
        errorCode: "AI_HTTP_404_NOT_FOUND",
        message: `接口或模型不存在（HTTP 404）${suffix || "，请检查基础地址与模型名称"}`,
      };
    }
    if (status === 429) {
      return {
        errorCode: "AI_HTTP_429_RATE_LIMITED",
        message: `触发限流或配额不足（HTTP 429）${suffix || "，请稍后重试"}`,
      };
    }
    if (status >= 500) {
      return {
        errorCode: "AI_HTTP_5XX",
        message: `上游服务异常（HTTP ${status}）${suffix}`,
      };
    }
    return {
      errorCode: "AI_HTTP_4XX",
      message: `上游拒绝请求（HTTP ${status}）${suffix}`,
    };
  }

  const code = typeof rec.code === "string" ? rec.code : "";
  if (
    code === "ECONNABORTED" ||
    code === "ETIMEDOUT" ||
    /timeout/i.test(rawMsg)
  ) {
    const budget = timeoutMs ? `（超时上限 ${timeoutMs}ms）` : "";
    return {
      errorCode: "AI_TIMEOUT",
      message: `请求超时${budget}${safeMsg ? `：${safeMsg}` : ""}`,
    };
  }
  if (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EHOSTUNREACH" ||
    code === "ECONNRESET" ||
    code === "ERR_NETWORK"
  ) {
    return {
      errorCode: "AI_NETWORK_ERROR",
      message: `网络连接失败（${code}）${safeMsg ? `：${safeMsg}` : ""}`,
    };
  }

  return {
    errorCode: "AI_REQUEST_FAILED",
    message: `调用失败${safeMsg ? `：${safeMsg}` : ""}`,
  };
}
