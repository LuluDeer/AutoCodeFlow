import { Injectable, Logger } from "@nestjs/common";
import axios from "axios";
import { BaseChannel, NotificationPayload } from "./base.channel";
import { assertSafeHttpUrl } from "../../../common/utils/safe-http.util";
import { ChannelConfigStore } from "../channel-config.store";

@Injectable()
export class WebhookChannel extends BaseChannel {
  name = "webhook";
  private logger = new Logger(WebhookChannel.name);

  constructor(private store: ChannelConfigStore) {
    super();
  }

  async send(p: NotificationPayload, url?: string) {
    // V5 (round-7): the old env fallback read `notification.webhookUrl`, a
    // key configuration.ts never defined — dead code, removed. Design intent
    // for this channel: the target comes from the per-request url argument
    // (/send webhookUrl, task alarmWebhook, sendWebhook) or, V1, from a
    // saved channel config; there is no global env default.
    const webhookUrl = url || this.store.get("webhook")?.webhookUrl;
    if (!webhookUrl) return "skipped";

    // NOTIF-001: reject SSRF (private / loopback / link-local / cloud-metadata)
    const url_ = webhookUrl;
    // V2: report the block instead of swallowing it silently.
    try {
      await assertSafeHttpUrl(url_);
    } catch (err: unknown) {
      this.logger.warn(
        `[Webhook] SSRF-blocked URL ${url_}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return "blocked";
    }

    const body = {
      title: p.title,
      content: p.content,
      level: p.level ?? "info",
      timestamp: new Date().toISOString(),
    };

    try {
      await this.withRetry(async () => {
        await axios.post(url_, body, {
          timeout: 10_000,
          headers: { "Content-Type": "application/json" },
        });
      });
      this.logger.log(`[Webhook] sent: ${p.title} → ${url_}`);
      return "sent";
    } catch (error) {
      this.logger.error(
        `[Webhook] send failed after retries: ${error.message}`,
      );
      return "failed";
    }
  }
}
