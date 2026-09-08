import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NotificationService, AlertChannel } from "./notification.service";
import { ChannelConfigStore } from "./channel-config.store";
import { ChannelDeliveryStatus } from "./channels/base.channel";

export interface NotificationChannel {
  key: string;
  name: string;
  enabled: boolean;
  config: Record<string, string>;
  description: string;
}

@Injectable()
export class NotificationConfigService {
  private logger = new Logger(NotificationConfigService.name);

  private channelDefaults: NotificationChannel[] = [
    {
      key: "email",
      name: "Email",
      enabled: false,
      config: {},
      description: "Send notifications via SMTP email",
    },
    {
      key: "slack",
      name: "Slack",
      enabled: false,
      config: {},
      description: "Send notifications via Slack Webhook",
    },
    {
      key: "dingtalk",
      name: "DingTalk",
      enabled: false,
      config: {},
      description: "Send notifications via DingTalk group bot",
    },
    {
      key: "wecom",
      name: "WeCom",
      enabled: false,
      config: {},
      description: "Send notifications via WeCom group bot",
    },
    {
      // N32 (round-9): webhook joined the configurable enum. Config shape is
      // `{ url }`; at send time the resolution is (N37, round-10): explicit
      // per-request webhookUrl first, then the saved url — but only while
      // the channel is enabled (see WebhookChannel.send).
      key: "webhook",
      name: "Webhook",
      enabled: false,
      config: {},
      description:
        "Generic HTTP webhook (per-request webhookUrl takes precedence; saved url applies only while the channel is enabled)",
    },
    {
      // NF-05: 飞书自定义机器人加入可配置枚举。config 形状 `{ webhookUrl,
      // secret? }`——secret 为可选加签密钥（配置后启用飞书官方加签算法）。
      key: "feishu",
      name: "Feishu",
      enabled: false,
      config: {},
      description:
        "Feishu (Lark) custom bot webhook (text payload; optional signing secret)",
    },
  ];

  // In-memory channel registry (enabled flag + config). V1: the RAW config
  // values are mirrored into ChannelConfigStore — the single source the
  // channels read at send time (config first, env fallback).
  private channelConfigs: Map<string, NotificationChannel> = new Map(
    this.channelDefaults.map((c) => [c.key, { ...c }]),
  );

  constructor(
    private configService: ConfigService,
    private notificationService: NotificationService,
    private store: ChannelConfigStore,
  ) {
    this.loadFromEnv();
  }

  /**
   * V1: publish the raw (unmasked) config of a channel to the send path.
   * N37 (round-10): the enabled flag travels with it — the webhook channel
   * only honors a saved url while the channel is enabled, so the store must
   * see enable/disable transitions too (updateChannel syncs on either).
   */
  private syncStore(key: string) {
    const channel = this.channelConfigs.get(key);
    if (channel) this.store.set(key, channel.config, channel.enabled);
  }

  private loadFromEnv() {
    // Load from environment variables if configured
    const emailEnabled = this.configService.get<boolean>(
      "notification.email.enabled",
    );
    const slackEnabled = this.configService.get<boolean>(
      "notification.slack.enabled",
    );
    const dingtalkEnabled = this.configService.get<boolean>(
      "notification.dingtalk.enabled",
    );
    const wecomEnabled = this.configService.get<boolean>(
      "notification.wecom.enabled",
    );

    if (emailEnabled) {
      const email = this.channelConfigs.get("email")!;
      email.enabled = true;
      email.config = {
        host: this.configService.get<string>("notification.email.host") || "",
        port:
          this.configService.get<string>("notification.email.port") || "587",
        user: this.configService.get<string>("notification.email.user") || "",
        password:
          this.configService.get<string>("notification.email.password") || "",
        from: this.configService.get<string>("notification.email.from") || "",
        to: this.configService.get<string>("notification.email.to") || "",
      };
    }

    if (slackEnabled) {
      const slack = this.channelConfigs.get("slack")!;
      slack.enabled = true;
      slack.config = {
        webhookUrl:
          this.configService.get<string>("notification.slack.webhookUrl") || "",
        channel:
          this.configService.get<string>("notification.slack.channel") ||
          "#alerts",
      };
    }

    if (dingtalkEnabled) {
      const dingtalk = this.channelConfigs.get("dingtalk")!;
      dingtalk.enabled = true;
      dingtalk.config = {
        webhookUrl:
          this.configService.get<string>("notification.dingtalk.webhookUrl") ||
          "",
      };
    }

    if (wecomEnabled) {
      const wecom = this.channelConfigs.get("wecom")!;
      wecom.enabled = true;
      wecom.config = {
        webhookUrl:
          this.configService.get<string>("notification.wecom.webhookUrl") || "",
      };
    }

    // NF-05: 飞书 env 回退（与 slack/dingtalk/wecom 同形态；secret 可选）。
    const feishuEnabled = this.configService.get<boolean>(
      "notification.feishu.enabled",
    );
    if (feishuEnabled) {
      const feishu = this.channelConfigs.get("feishu")!;
      feishu.enabled = true;
      feishu.config = {
        webhookUrl:
          this.configService.get<string>("notification.feishu.webhookUrl") || "",
        secret:
          this.configService.get<string>("notification.feishu.secret") || "",
      };
    }

    // V1: env-loaded configs seed the store too, so the send path has one
    // consistent source of truth (saved config first, env fallback inside the
    // channels). Empty values fall through to the env defaults unchanged.
    for (const key of this.channelConfigs.keys()) {
      this.syncStore(key);
    }
  }

  getAllChannels(): NotificationChannel[] {
    return Array.from(this.channelConfigs.values()).map((c) =>
      this.maskChannel(c),
    );
  }

  getChannel(key: string): NotificationChannel | undefined {
    const channel = this.channelConfigs.get(key);
    return channel ? this.maskChannel(channel) : undefined;
  }

  /**
   * N11: 读面对 password/secret/token 类字段脱敏为 '***'（对应 config 模块
   * 按 isSecret 标记脱敏的做法——渠道 config 是内存对象、无逐键元数据，
   * 故按字段名判定）。返回副本，绝不改动存储中的真实值。
   *
   * N32 (round-9): 字段名规则看不到 URL 值内部——webhook 类 URL 常把凭据
   * 放在 query（?access_token=...）。同一 SECRET_FIELD_RE 因此也套用到 URL
   * query 参数名上：`...?access_token=abc` → `...?access_token=***`，
   * 使 GET/PATCH 响应自然覆盖值内机密。store/渠道侧仍是原值（发送路径不受
   * 影响）。
   */
  private maskChannel(channel: NotificationChannel): NotificationChannel {
    const config: Record<string, string> = {};
    for (const [k, v] of Object.entries(channel.config)) {
      config[k] =
        NotificationConfigService.SECRET_FIELD_RE.test(k) && v
          ? "***"
          : this.maskUrlSecrets(v);
    }
    return { ...channel, config };
  }

  private static readonly SECRET_FIELD_RE = /pass|secret|token/i;

  /** `?param=VALUE` / `&param=VALUE` where the param name is secret-class. */
  private static readonly URL_SECRET_QUERY_RE =
    /([?&][^=&#]*(?:pass|secret|token)[^=&#]*=)[^&#]+/gi;

  /** A read-surface echo: secret-class query param already masked. */
  private static readonly MASKED_URL_QUERY_RE =
    /[?&][^=&#]*(?:pass|secret|token)[^=&#]*=\*\*\*(&|#|$)/i;

  private maskUrlSecrets(value: string): string {
    return value.replace(
      NotificationConfigService.URL_SECRET_QUERY_RE,
      "$1***",
    );
  }

  /**
   * N11 sentinel + N32 masked-URL echo：读面回显的掩码值不得覆盖存储中的
   * 真实机密——既包括 password 类字段的精确 '***'，也包括 URL 值内被掩码
   * 的 secret 类 query 参数（`...?token=***`，admin-web 表单原样提交时）。
   */
  private isMaskedEcho(key: string, value: string): boolean {
    if (
      value === "***" &&
      NotificationConfigService.SECRET_FIELD_RE.test(key)
    ) {
      return true;
    }
    return NotificationConfigService.MASKED_URL_QUERY_RE.test(value);
  }

  updateChannel(
    key: string,
    data: { enabled?: boolean; config?: Record<string, string> },
  ): NotificationChannel {
    const channel = this.channelConfigs.get(key);
    if (!channel) {
      // V4 (round-7): unknown channel keys used to escape as a bare Error →
      // HTTP 500. The key set is a fixed enum (email/slack/dingtalk/wecom/
      // webhook — webhook joined in N32, round-9), so this is a client input
      // error: 400 with the valid keys listed.
      const validKeys = Array.from(this.channelConfigs.keys()).join(", ");
      throw new BadRequestException(
        `Unknown notification channel: ${key}. Valid channels: ${validKeys}`,
      );
    }

    if (data.enabled !== undefined) {
      channel.enabled = data.enabled;
      // N37 (round-10): an enabled-only PATCH must reach the send path too —
      // the webhook channel gates the saved url on this flag.
      this.syncStore(key);
    }
    if (data.config) {
      const merged = { ...channel.config };
      for (const [k, v] of Object.entries(data.config)) {
        // 读面把 secret 字段回显为 '***'（含 URL query 内的掩码）；
        // admin-web 表单会原样提交。哨兵值不得覆盖存储中的真实机密。
        if (this.isMaskedEcho(k, v)) {
          continue;
        }
        merged[k] = v;
      }
      channel.config = merged;
      // V1: publish the merged RAW config so send()/sendTest() actually use
      // what the admin surface saved (read path stays masked).
      this.syncStore(key);
    }

    return this.maskChannel(channel);
  }

  /**
   * R8 (N29): the per-channel "test" button used to fire a full sendAll fan-
   * out, ignore the caller-supplied config AND the returned
   * ChannelDeliveryResults, and unconditionally report success — an SSRF-
   * blocked or failed channel still showed OK (the exact "fake OK" V2 set out
   * to eliminate). Now it tests only the requested channel and reports the
   * real per-channel outcome: success only when the delivery status is `sent`.
   *
   * R2: the optional config override is now passed to the channel's send()
   * as a request-scoped parameter — it is NEVER published to the global
   * ChannelConfigStore. The previous implementation wrote the override into
   * the store for the duration of the test (await up to 33s with retries),
   * which:
   *  - rerouted concurrent production alerts through unsaved admin-form
   *    values for the whole await window,
   *  - on concurrent tests, persisted the LATER override as if it had been
   *    PATCH-saved (the other test's "saved" snapshot was restored on top
   *    of the in-flight override — the wrong one won).
   * The new shape: one channel.send(payload, override) call, override lives
   * only in the call frame. The N37 'webhook enabled gating' rule still
   * applies inside WebhookChannel.send (the saved url is only honored while
   * the channel is enabled); the override url bypasses that gate because it
   * is an explicit per-call argument (matches the sendWebhook semantics).
   */
  async testChannel(
    key: string,
    config?: Record<string, string>,
  ): Promise<{
    success: boolean;
    message: string;
    results?: Record<string, ChannelDeliveryStatus>;
  }> {
    const channel = this.channelConfigs.get(key);
    if (!channel) {
      const validKeys = Array.from(this.channelConfigs.keys()).join(", ");
      throw new BadRequestException(
        `Unknown notification channel: ${key}. Valid channels: ${validKeys}`,
      );
    }

    // Build the per-call override. The N11 '***' masked echo must not
    // reach the channel as a real value — channels now merge override
    // over saved+env, and a '***' for a secret-class key would clobber
    // the saved secret for the duration of the test. Strip those echoes
    // out so the channel falls through to the saved/env value.
    const override: Record<string, string> = {};
    if (config) {
      for (const [k, v] of Object.entries(config)) {
        if (this.isMaskedEcho(k, v)) continue;
        override[k] = v;
      }
    }

    const payload = {
      title: "AutoFlow Test Notification",
      content: `This is a test notification\nTime: ${new Date().toLocaleString()}`,
      level: "info" as const,
    };

    try {
      // R2: invoke the channel directly with the override. The global
      // send path (sendToChannels / sendAll) is intentionally NOT called —
      // those paths have no override and would also publish any change
      // to the store as a side effect of the test.
      const status = await this.notificationService.testChannel(
        payload,
        key as AlertChannel,
        Object.keys(override).length > 0 ? override : undefined,
      );
      const results = { [key]: status };
      if (status === "sent") {
        return {
          success: true,
          message: `Test message sent via ${key}`,
          results,
        };
      }
      const reason =
        status === "skipped"
          ? "channel not configured (no webhook URL / credentials resolved)"
          : `delivery ${status}`;
      return {
        success: false,
        message: `Test notification not delivered via ${key}: ${reason}`,
        results,
      };
    } catch (err: unknown) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async sendTest(data: {
    channels: string[];
    title: string;
    content: string;
  }): Promise<{
    success: boolean;
    message: string;
    results?: Record<string, ChannelDeliveryStatus>;
  }> {
    const { channels, title, content } = data;
    const payload = { title, content, level: "info" as const };

    try {
      // V2 (round-7): channels no longer throw on SSRF blocks / transport
      // errors — they return a status. Collect it per channel and reflect it
      // in success/message so the admin "test" button can't report OK for a
      // blocked or failed delivery.
      const results: Record<string, ChannelDeliveryStatus> = {};
      for (const channel of channels) {
        const config = this.channelConfigs.get(channel);
        if (!config?.enabled) {
          this.logger.warn(`Channel ${channel} is not enabled, skipping`);
          continue;
        }

        let status: ChannelDeliveryStatus | undefined;
        switch (channel) {
          case "email":
            status = (await this.notificationService["email"].send(payload)) as
              ChannelDeliveryStatus | undefined;
            break;
          case "slack":
            status = (await this.notificationService["slack"].send(payload)) as
              ChannelDeliveryStatus | undefined;
            break;
          case "dingtalk":
            status = (await this.notificationService["dingtalk"].send(
              payload,
            )) as ChannelDeliveryStatus | undefined;
            break;
          case "wecom":
            status = (await this.notificationService["wecom"].send(payload)) as
              ChannelDeliveryStatus | undefined;
            break;
          // NF-05: feishu joined the configurable enum — same "fake OK"
          // guard as webhook (N32): a requested+enabled feishu test must
          // report the real delivery status, never a silent no-op.
          case "feishu":
            status = (await this.notificationService["feishu"].send(
              payload,
            )) as ChannelDeliveryStatus | undefined;
            break;
          // N32: webhook joined the configurable enum — without this case a
          // requested+enabled webhook test would silently report "sent" for
          // zero delivery attempts (the N29 "fake OK" class).
          case "webhook":
            status = (await this.notificationService["webhook"].send(
              payload,
            )) as ChannelDeliveryStatus | undefined;
            break;
        }
        results[channel] = status ?? "sent";
      }

      // R8 (N29): every requested channel was disabled/unknown → zero delivery
      // attempts. Reporting success:true for an empty fan-out is the same
      // "fake OK" as the blocked branch — fail explicitly instead.
      if (Object.keys(results).length === 0) {
        return {
          success: false,
          message: `No enabled channels to test (requested: ${channels.join(", ") || "none"}). Enable a channel first.`,
          results,
        };
      }

      const bad = Object.entries(results).filter(
        ([, s]) => s === "blocked" || s === "failed",
      );
      if (bad.length > 0) {
        const detail = bad.map(([c, s]) => `${c}=${s}`).join(", ");
        return {
          success: false,
          message: `Test notification not delivered: ${detail}`,
          results,
        };
      }
      return {
        success: true,
        message: "Test notification sent",
        results,
      };
    } catch (err: unknown) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
