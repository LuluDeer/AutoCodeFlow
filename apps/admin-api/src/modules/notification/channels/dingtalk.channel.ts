import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { BaseChannel, NotificationPayload } from "./base.channel";

@Injectable()
export class DingtalkChannel extends BaseChannel {
  name = "dingtalk";
  private logger = new Logger(DingtalkChannel.name);

  constructor(private config: ConfigService) {
    super();
  }

  async send(p: NotificationPayload) {
    const url = this.config.get<string>("notification.dingtalkWebhook");
    if (!url) return;

    try {
      await this.withRetry(async () => {
        await axios.post(
          url,
          {
            msgtype: "markdown",
            markdown: { title: p.title, text: `## ${p.title}\n${p.content}` },
          },
          { timeout: 10_000 },
        );
      });
      this.logger.log(`[Dingtalk] sent: ${p.title}`);
    } catch (error) {
      this.logger.error(
        `[Dingtalk] send failed after retries: ${error.message}`,
      );
    }
  }
}
