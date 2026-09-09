import { Injectable, Logger } from "@nestjs/common";
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
export class WebhookChannel extends BaseChannel {
  name = "webhook";
  private logger = new Logger(WebhookChannel.name);

  constructor(private store: ChannelConfigStore) {
    super();
  }

  async send(
    p: NotificationPayload,
    url?: string | ChannelConfigOverride,
    configOverride?: ChannelConfigOverride,
  ): Promise<ChannelDeliveryStatus> {
    // BaseChannel.send's contract passes the per-call override as the SECOND
    // argument; this channel's own callers (sendToChannels / sendWebhook)
    // pass an explicit webhook URL there. Accept both shapes so the
    // override is honored regardless of who calls: a string is the url, an
    // object is the override.
    const explicitUrl = typeof url === "string" ? url : undefined;
    const callOverride =
      typeof url === "string" ? configOverride : (url ?? configOverride);
    // V5 (round-7): the old env fallback read `notification.webhookUrl`, a
    // key configuration.ts never defined — dead code, removed. There is
    // therefore no env tier for this channel; the chain below ends at "no
    // url → skipped".
    // N32 (round-9) made "webhook" PATCH-able (config shape `{ url }`) and
    // flipped resolution to store-first; N37 (round-10) corrects that flip:
    // an explicit per-request `webhookUrl` (POST /notification/send body,
    // sendWebhook) must NOT be silently rerouted to the saved url, and a
    // saved url only takes effect while the channel is ENABLED.
    // R2: a per-call config override (testChannel's unsaved values) wins
    // over the saved url and is NEVER published to the store. The saved
    // url is still gated on the channel being enabled (N37).
    const savedUrl = this.store.isEnabled("webhook")
      ? this.store.get("webhook")?.url
      : undefined;
    const overrideUrl = callOverride?.url;
    const webhookUrl = explicitUrl || overrideUrl || savedUrl;
    if (!webhookUrl) return "skipped";

    // NOTIF-001: reject SSRF (private / loopback / link-local / cloud-metadata)
    const url_ = webhookUrl;
    // V2: report the block instead of swallowing it silently.
    try {
      await assertSafeHttpUrl(url_);
    } catch (err: unknown) {
      this.logger.warn(
        `[Webhook] SSRF-blocked URL ${url_}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return "blocked";
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
          // R3: assertSafeHttpUrl only validates the first-hop URL; axios
          // would otherwise follow 3xx up to 5 hops to whatever the
          // remote chooses — a 302 to 169.254.169.254 or 127.0.0.1
          // reaches admin-api's own metadata/loopback. Refuse redirects
          // outright so the validated first hop is the only hop.
          maxRedirects: 0,
          headers: { "Content-Type": "application/json" },
        });
      });
      this.logger.log(`[Webhook] sent: ${p.title} → ${url_}`);
      return "sent";
    } catch (error) {
      // QA5: with maxRedirects:0 a 3xx lands here as a deterministic reject —
      // say so explicitly instead of a bare "delivery failed", so an operator
      // with a short-link / http→https redirect webhook knows the fix.
      const status = (error as { response?: { status?: number } } | undefined)
        ?.response?.status;
      const reason =
        typeof status === "number" && status >= 300 && status < 400
          ? `redirect refused by SSRF policy (maxRedirects=0) — configure the final URL directly (HTTP ${status})`
          : error.message;
      this.logger.error(`[Webhook] send failed after retries: ${reason}`);
      return "failed";
    }
  }
}
