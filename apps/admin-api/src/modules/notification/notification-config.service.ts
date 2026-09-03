import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NotificationService } from "./notification.service";
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

  /** V1: publish the raw (unmasked) config of a channel to the send path. */
  private syncStore(key: string) {
    const channel = this.channelConfigs.get(key);
    if (channel) this.store.set(key, channel.config);
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
   */
  private maskChannel(channel: NotificationChannel): NotificationChannel {
    const config: Record<string, string> = {};
    for (const [k, v] of Object.entries(channel.config)) {
      config[k] =
        NotificationConfigService.SECRET_FIELD_RE.test(k) && v ? "***" : v;
    }
    return { ...channel, config };
  }

  private static readonly SECRET_FIELD_RE = /pass|secret|token/i;

  updateChannel(
    key: string,
    data: { enabled?: boolean; config?: Record<string, string> },
  ): NotificationChannel {
    const channel = this.channelConfigs.get(key);
    if (!channel) {
      // V4 (round-7): unknown channel keys used to escape as a bare Error →
      // HTTP 500. The key set is a fixed enum (email/slack/dingtalk/wecom —
      // webhook is per-request only and intentionally absent), so this is a
      // client input error: 400 with the valid keys listed.
      const validKeys = Array.from(this.channelConfigs.keys()).join(", ");
      throw new BadRequestException(
        `Unknown notification channel: ${key}. Valid channels: ${validKeys}`,
      );
    }

    if (data.enabled !== undefined) {
      channel.enabled = data.enabled;
    }
    if (data.config) {
      const merged = { ...channel.config };
      for (const [k, v] of Object.entries(data.config)) {
        // 读面把 secret 字段回显为 '***'；admin-web 表单会原样提交。
        // 哨兵值不得覆盖存储中的真实机密。
        if (v === "***" && NotificationConfigService.SECRET_FIELD_RE.test(k)) {
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

  async testChannel(
    _config: Record<string, string>,
  ): Promise<{ success: boolean; message: string }> {
    try {
      await this.notificationService.sendAll({
        title: "AutoFlow Test Notification",
        content: `This is a test notification\nTime: ${new Date().toLocaleString()}`,
        level: "info",
      });
      return { success: true, message: "Test message sent successfully" };
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
              | ChannelDeliveryStatus
              | undefined;
            break;
          case "slack":
            status = (await this.notificationService["slack"].send(payload)) as
              | ChannelDeliveryStatus
              | undefined;
            break;
          case "dingtalk":
            status = (await this.notificationService["dingtalk"].send(
              payload,
            )) as ChannelDeliveryStatus | undefined;
            break;
          case "wecom":
            status = (await this.notificationService["wecom"].send(payload)) as
              | ChannelDeliveryStatus
              | undefined;
            break;
        }
        results[channel] = status ?? "sent";
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
