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
export class DingtalkChannel extends BaseChannel {
  name = "dingtalk";
  private logger = new Logger(DingtalkChannel.name);

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
    const saved = this.store.get("dingtalk") ?? {};
    const override = configOverride ?? {};
    const url =
      override.webhookUrl ||
      saved.webhookUrl ||
      this.config.get<string>("notification.dingtalkWebhook");
    if (!url) return "skipped";

    // F-3: the webhook URL is operator/user-configured — apply the same SSRF
    // chokepoint as WebhookChannel (NOTIF-001). Fail-open: skip the send
    // instead of raising, matching the WebhookChannel behavior.
    // V2: report the block instead of swallowing it silently.
    try {
      await assertSafeHttpUrl(url);
    } catch (err: unknown) {
      this.logger.warn(
        `[Dingtalk] SSRF-blocked URL ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return "blocked";
    }

    try {
      await this.withRetry(async () => {
        await axios.post(
          url,
          {
            msgtype: "markdown",
            markdown: { title: p.title, text: `## ${p.title}\n${p.content}` },
          },
          // R3: maxRedirects=0 — refuse 3xx so the assertSafeHttpUrl
          // check on the first hop is the only check applied.
          { timeout: 10_000, maxRedirects: 0 },
        );
      });
      this.logger.log(`[Dingtalk] sent: ${p.title}`);
      return "sent";
    } catch (error) {
      this.logger.error(
        `[Dingtalk] send failed after retries: ${error.message}`,
      );
      return "failed";
    }
  }
}
