import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import {
  BaseChannel,
  ChannelConfigOverride,
  ChannelDeliveryStatus,
  NotificationPayload,
} from "./base.channel";
import {
  assertAndPinHttpUrl,
  PinnedHttpTarget,
  pinnedAxiosConfig,
} from "../../../common/utils/safe-http.util";
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

  async send(
    p: NotificationPayload,
    configOverride?: ChannelConfigOverride,
  ): Promise<ChannelDeliveryStatus> {
    // R2: override merged over saved (override wins). Never publishes to
    // the global store — concurrent prod alerts can never see test data.
    const saved = this.store.get("wecom") ?? {};
    const override = configOverride ?? {};
    const url =
      override.webhookUrl ||
      saved.webhookUrl ||
      this.config.get<string>("notification.wecomWebhook");
    if (!url) return "skipped";

    // F-3: SSRF chokepoint (NOTIF-001) + DNS pinning (SEC-NEW): rewrite the
    // target to the validated IP so a rebinding host can't swap the address
    // between validation and connection. Fail-open like WebhookChannel.
    // V2: report the block instead of swallowing it silently.
    let pinned: PinnedHttpTarget;
    try {
      pinned = await assertAndPinHttpUrl(url, {
        allowPrivateNetwork:
          this.config.get<boolean>("notification.allowPrivateNetwork") === true,
      });
    } catch (err: unknown) {
      this.logger.warn(
        `[Wecom] SSRF-blocked URL ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return "blocked";
    }

    try {
      await this.withRetry(async () => {
        const pinCfg = pinnedAxiosConfig(pinned);
        // 原始 URL 原样（new URL 归一化会加尾部斜杠）；pin 由 agent.lookup 完成。
        await axios.post(
          url,
          {
            msgtype: "markdown",
            markdown: { content: `## ${p.title}\n${p.content}` },
          },
          // R3: maxRedirects=0 — refuse 3xx so the validated first hop
          // is the only hop applied.
          {
            timeout: 10_000,
            maxRedirects: 0,
            ...pinCfg,
          },
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
