import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NotificationService } from "./notification.service";

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

  // In-memory config (in production, persist to database)
  private channelConfigs: Map<string, NotificationChannel> = new Map(
    this.channelDefaults.map((c) => [c.key, { ...c }]),
  );

  constructor(
    private configService: ConfigService,
    private notificationService: NotificationService,
  ) {
    this.loadFromEnv();
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
      throw new Error(`Unknown notification channel: ${key}`);
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
    }

    return this.maskChannel(channel);
  }

  async testChannel(
    config: Record<string, string>,
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
  }): Promise<{ success: boolean; message: string }> {
    const { channels, title, content } = data;
    const payload = { title, content, level: "info" as const };

    try {
      for (const channel of channels) {
        const config = this.channelConfigs.get(channel);
        if (!config?.enabled) {
          this.logger.warn(`Channel ${channel} is not enabled, skipping`);
          continue;
        }

        switch (channel) {
          case "email":
            await this.notificationService["email"].send(payload);
            break;
          case "slack":
            await this.notificationService["slack"].send(payload);
            break;
          case "dingtalk":
            await this.notificationService["dingtalk"].send(payload);
            break;
          case "wecom":
            await this.notificationService["wecom"].send(payload);
            break;
        }
      }
      return { success: true, message: "Test notification sent" };
    } catch (err: unknown) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
