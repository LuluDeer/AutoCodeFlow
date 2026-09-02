import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { BaseChannel, NotificationPayload } from "./base.channel";
import { assertSafeHttpUrl } from "../../../common/utils/safe-http.util";

@Injectable()
export class WebhookChannel extends BaseChannel {
  name = "webhook";
  private logger = new Logger(WebhookChannel.name);

  constructor(private config: ConfigService) {
    super();
  }

  async send(p: NotificationPayload, url?: string) {
    const webhookUrl =
      url || this.config.get<string>("notification.webhookUrl");
    if (!webhookUrl) return;

    // NOTIF-001: reject SSRF (private / loopback / link-local / cloud-metadata)
    const url_ = webhookUrl;
    try {
      await assertSafeHttpUrl(url_);
    } catch (err: unknown) {
      this.logger.warn(
        `[Webhook] SSRF-blocked URL ${url_}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
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
    } catch (error) {
      this.logger.error(
        `[Webhook] send failed after retries: ${error.message}`,
      );
    }
  }
}
