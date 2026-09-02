import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { BaseChannel, NotificationPayload } from "./base.channel";
import { assertSafeHttpUrl } from "../../../common/utils/safe-http.util";

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

    // F-3: the webhook URL is operator/user-configured — apply the same SSRF
    // chokepoint as WebhookChannel (NOTIF-001). Fail-open: skip the send
    // instead of raising, matching the WebhookChannel behavior.
    try {
      await assertSafeHttpUrl(url);
    } catch (err: unknown) {
      this.logger.warn(
        `[Dingtalk] SSRF-blocked URL ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

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
