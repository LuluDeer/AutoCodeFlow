import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { BaseChannel, NotificationPayload } from "./base.channel";

@Injectable()
export class WebhookChannel extends BaseChannel {
  name = "webhook";
  private logger = new Logger(WebhookChannel.name);

  constructor(private config: ConfigService) {
    super();
  }

  async send(p: NotificationPayload, url?: string) {
    const webhookUrl = url || this.config.get<string>("notification.webhookUrl");
    if (!webhookUrl) return;

    const body = {
      title: p.title,
      content: p.content,
      level: p.level ?? "info",
      timestamp: new Date().toISOString(),
    };

    try {
      await this.withRetry(async () => {
        await axios.post(webhookUrl, body, {
          timeout: 10_000,
          headers: { "Content-Type": "application/json" },
        });
      });
      this.logger.log(`[Webhook] sent: ${p.title} → ${webhookUrl}`);
    } catch (error) {
      this.logger.error(`[Webhook] send failed after retries: ${error.message}`);
    }
  }
}
