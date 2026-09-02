import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { BaseChannel, NotificationPayload } from "./base.channel";
import { assertSafeHttpUrl } from "../../../common/utils/safe-http.util";

@Injectable()
export class SlackChannel extends BaseChannel {
  name = "slack";
  private logger = new Logger(SlackChannel.name);

  constructor(private config: ConfigService) {
    super();
  }

  async send(p: NotificationPayload) {
    const webhook = this.config.get<string>("notification.slackWebhook");
    if (!webhook) return;

    // F-3: SSRF chokepoint (NOTIF-001), fail-open like WebhookChannel.
    try {
      await assertSafeHttpUrl(webhook);
    } catch (err: unknown) {
      this.logger.warn(
        `[Slack] SSRF-blocked URL ${webhook}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    try {
      await this.withRetry(async () => {
        await axios.post(
          webhook,
          {
            text: `*${p.title}*`,
            blocks: [
              { type: "header", text: { type: "plain_text", text: p.title } },
              {
                type: "section",
                text: { type: "mrkdwn", text: p.content.slice(0, 3000) },
              },
            ],
          },
          { timeout: 10_000 },
        );
      });
      this.logger.log(`[Slack] sent: ${p.title}`);
    } catch (error) {
      this.logger.error(`[Slack] send failed after retries: ${error.message}`);
    }
  }
}
