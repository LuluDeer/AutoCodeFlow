import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import {
  BaseChannel,
  ChannelDeliveryStatus,
  NotificationPayload,
} from "./base.channel";
import { assertSafeHttpUrl } from "../../../common/utils/safe-http.util";
import { ChannelConfigStore } from "../channel-config.store";

@Injectable()
export class WecomChannel extends BaseChannel {
  name = "wecom";
  private logger = new Logger(WecomChannel.name);

  constructor(
    private config: ConfigService,
    private store: ChannelConfigStore,
  ) {
    super();
  }

  async send(p: NotificationPayload): Promise<ChannelDeliveryStatus> {
    // V1 (round-7): the config saved via PATCH /notification/channels/wecom
    // takes precedence; the env webhook (WECOM_WEBHOOK) is only the fallback
    // default when nothing was saved.
    const url =
      this.store.get("wecom")?.webhookUrl ||
      this.config.get<string>("notification.wecomWebhook");
    if (!url) return "skipped";

    // F-3: SSRF chokepoint (NOTIF-001), fail-open like WebhookChannel.
    // V2: report the block instead of swallowing it silently.
    try {
      await assertSafeHttpUrl(url);
    } catch (err: unknown) {
      this.logger.warn(
        `[Wecom] SSRF-blocked URL ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return "blocked";
    }

    try {
      await this.withRetry(async () => {
        await axios.post(
          url,
          {
            msgtype: "markdown",
            markdown: { content: `## ${p.title}\n${p.content}` },
          },
          { timeout: 10_000 },
        );
      });
      this.logger.log(`[Wecom] sent: ${p.title}`);
      return "sent";
    } catch (error) {
      this.logger.error(`[Wecom] send failed after retries: ${error.message}`);
      return "failed";
    }
  }
}
