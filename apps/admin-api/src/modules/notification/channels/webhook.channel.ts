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
    // key configuration.ts never defined — dead code, removed.
    // N32 (round-9): "webhook" joined the PATCH-able channel enum with
    // config shape `{ url }`, so the store branch V2 §7.1 flagged as
    // unreachable is now live. Resolution matches every other channel's
    // V1 config-first rule: the SAVED channel url wins; the per-request
    // url argument (/send body.webhookUrl, task alarmWebhook, sendWebhook)
    // is the fallback. Signature unchanged.
    const webhookUrl = this.store.get("webhook")?.url || url;
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
