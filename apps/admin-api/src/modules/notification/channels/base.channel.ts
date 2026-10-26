export interface NotificationPayload {
  title: string;
  content: string;
  level?: "info" | "warning" | "error" | "critical";
  /**
   * FEAT-10: template variables for per-channel title/content templates
   * (titleTemplate / contentTemplate in the channel's saved config). Only
   * senders that know the alert context populate this — when present,
   * NotificationService.sendToChannels renders each channel's copy through
   * renderTemplate (single-pass, 8KB cap, fail-open). Absent → payloads flow
   * to channels exactly as before (zero breakage).
   */
  vars?: Record<string, string | number | null | undefined>;
}

/**
 * V2 (round-7): per-channel delivery outcome. Channels keep their fail-open
 * posture (they never throw for SSRF blocks or transport errors), but they
 * now REPORT what happened so the fan-out layer can surface it in the API
 * response instead of hiding it in server logs:
 *  - "sent"    — request accepted by the remote endpoint
 *  - "blocked" — rejected by the SSRF guard (assertSafeHttpUrl)
 *  - "failed"  — transport/API error after retries
 *  - "skipped" — channel not configured (no URL/credentials available)
 */
export type ChannelDeliveryStatus = "sent" | "blocked" | "failed" | "skipped";

export interface RetryConfig {
  maxRetries: number;
  delayMs: number;
  backoffMultiplier: number;
}

/**
 * R150-A1（出站面审计 · 轴2）：投递失败的**原因分类**（仅用于日志/排障）。
 *
 * 契约面 ChannelDeliveryStatus 只有 4 值，网络故障、4xx、5xx、超时全部折叠成
 * "failed"——这是刻意的（DTO / 指标 / 前端契约稳定，见 dto/notification-send
 * 的 results 值域），不该为了排障改契约。但**日志**没有理由同样折叠：运维
 * 需要从一行日志区分
 *   · http_4xx/http_3xx → 配置问题（URL/凭据/重定向），改配置才有用；
 *   · http_5xx          → 对端故障，等恢复（重试已耗尽）；
 *   · timeout/network    → 网络/DNS/TLS，查链路；
 * 而不是看到 6 个渠道都写 "failed" 再去翻堆栈。
 *
 * 纯函数、无依赖，六个渠道共用一份判定（避免"这个渠道分了、那个没分"）。
 * 结构化落到指标/审计需要给 ChannelDeliveryStatus 加维度（跨 DTO、指标注册
 * 表、admin-web 契约），不在本轮范围——已在报告里列为遗留项。
 */
export type DeliveryFailureKind =
  | "http_3xx_redirect"
  | "http_4xx"
  | "http_5xx"
  | "timeout"
  | "network"
  | "unknown";

export function classifyDeliveryFailure(error: unknown): DeliveryFailureKind {
  const status = (
    error as { response?: { status?: number } } | undefined | null
  )?.response?.status;
  if (typeof status === "number" && Number.isFinite(status)) {
    if (status >= 300 && status < 400) return "http_3xx_redirect";
    if (status >= 400 && status < 500) return "http_4xx";
    if (status >= 500 && status < 600) return "http_5xx";
  }
  const code = (error as { code?: unknown } | undefined | null)?.code;
  if (typeof code === "string") {
    if (/^(ECONNABORTED|ETIMEDOUT|ESOCKETTIMEDOUT)$/.test(code))
      return "timeout";
    if (
      /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|ERR_NETWORK|ERR_BAD_RESPONSE|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)$/.test(
        code,
      )
    ) {
      return "network";
    }
  }
  // axios 的 timeout 走 message 标记（"timeout of 10000ms exceeded"，无 code）
  const msg = error instanceof Error ? error.message : String(error ?? "");
  if (/timeout/i.test(msg)) return "timeout";
  if (/network error|socket hang up|ECONN|ENOTFOUND|EAI_AGAIN/i.test(msg)) {
    return "network";
  }
  return "unknown";
}

/**
 * R2: per-call unsaved config override. Channels accept this as a second
 * argument to send(); it is merged over the saved+env resolution for the
 * DURATION of one call only — never published to ChannelConfigStore, so
 * concurrent prod alerts can never see unsaved test data and the global
 * send path cannot be silently rerouted by an in-flight test send.
 */
export type ChannelConfigOverride = Record<string, string>;

export abstract class BaseChannel {
  abstract name: string;
  abstract send(
    payload: NotificationPayload,
    configOverride?: ChannelConfigOverride,
  ): Promise<ChannelDeliveryStatus>;

  /** QA5: 3xx (redirect refused by the R3 maxRedirects:0 posture) and 4xx
   *  are deterministic remote verdicts — retrying them only burns the
   *  backoff budget. Only transport errors and 5xx are worth retrying. */
  private static isDeterministicHttpReject(error: unknown): boolean {
    const status = (error as { response?: { status?: number } } | undefined)
      ?.response?.status;
    return typeof status === "number" && status < 500;
  }

  protected async withRetry<T>(
    operation: () => Promise<T>,
    config: RetryConfig = {
      maxRetries: 3,
      delayMs: 1000,
      backoffMultiplier: 2,
    },
  ): Promise<T> {
    let lastError: Error | undefined;
    let delay = config.delayMs;

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (BaseChannel.isDeterministicHttpReject(error)) break;
        if (attempt < config.maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay *= config.backoffMultiplier;
        }
      }
    }

    throw lastError || new Error("Retry failed");
  }
}
