import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import {
  BaseChannel,
  ChannelConfigOverride,
  ChannelDeliveryStatus,
  NotificationPayload,
} from "./base.channel";
import { assertSafeHttpUrl } from "../../../common/utils/safe-http.util";
import { ChannelConfigStore } from "../channel-config.store";

@Injectable()
export class SlackChannel extends BaseChannel {
  name = "slack";
  private logger = new Logger(SlackChannel.name);

  constructor(
    private config: ConfigService,
    private store: ChannelConfigStore,
  ) {
    super();
  }

  async send(
    p: NotificationPayload,
    configOverride?: ChannelConfigOverride,
  ): Promise<ChannelDeliveryStatus> {
    // R2: override merged over saved (override wins). Never publishes to
    // the global store — concurrent prod alerts can never see test data.
    const saved = this.store.get("slack") ?? {};
    const override = configOverride ?? {};
    const webhook =
      override.webhookUrl ||
      saved.webhookUrl ||
      this.config.get<string>("notification.slackWebhook");
    if (!webhook) return "skipped";

    // F-3: SSRF chokepoint (NOTIF-001), fail-open like WebhookChannel.
    // V2: report the block instead of swallowing it silently.
    try {
      await assertSafeHttpUrl(webhook);
    } catch (err: unknown) {
      this.logger.warn(
        `[Slack] SSRF-blocked URL ${webhook}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return "blocked";
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
          // R3: maxRedirects=0 — the assertSafeHttpUrl check only covers
          // the first hop; refuse 3xx so a redirect cannot bypass the
          // SSRF guard into 169.254.169.254 or loopback.
          { timeout: 10_000, maxRedirects: 0 },
        );
      });
      this.logger.log(`[Slack] sent: ${p.title}`);
      return "sent";
    } catch (error) {
      this.logger.error(`[Slack] send failed after retries: ${error.message}`);
      return "failed";
    }
  }
}
