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
export class DingtalkChannel extends BaseChannel {
  name = "dingtalk";
  private logger = new Logger(DingtalkChannel.name);

  constructor(
    private config: ConfigService,
    private store: ChannelConfigStore,
  ) {
    super();
  }

  async send(p: NotificationPayload): Promise<ChannelDeliveryStatus> {
    // V1 (round-7): saved channel config first, env (DINGTALK_WEBHOOK) as
    // fallback default only.
    const url =
      this.store.get("dingtalk")?.webhookUrl ||
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
          { timeout: 10_000 },
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
