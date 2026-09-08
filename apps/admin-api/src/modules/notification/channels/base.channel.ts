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
