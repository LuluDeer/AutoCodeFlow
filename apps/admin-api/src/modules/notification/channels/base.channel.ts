export interface NotificationPayload {
  title: string;
  content: string;
  level?: "info" | "warning" | "error" | "critical";
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

export abstract class BaseChannel {
  abstract name: string;
  abstract send(payload: NotificationPayload): Promise<ChannelDeliveryStatus>;

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

        if (attempt < config.maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay *= config.backoffMultiplier;
        }
      }
    }

    throw lastError || new Error("Retry failed");
  }
}
