import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationService } from './notification.service';

interface NotificationChannel {
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
      key: 'email',
      name: '邮件',
      enabled: false,
      config: {},
      description: '通过 SMTP 发送邮件通知',
    },
    {
      key: 'slack',
      name: 'Slack',
      enabled: false,
      config: {},
      description: '通过 Slack Webhook 发送通知',
    },
    {
      key: 'dingtalk',
      name: '钉钉',
      enabled: false,
      config: {},
      description: '通过钉钉群机器人发送通知',
    },
    {
      key: 'wecom',
      name: '企业微信',
      enabled: false,
      config: {},
      description: '通过企业微信群机器人发送通知',
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
    const emailEnabled = this.configService.get<boolean>('notification.email.enabled');
    const slackEnabled = this.configService.get<boolean>('notification.slack.enabled');
    const dingtalkEnabled = this.configService.get<boolean>('notification.dingtalk.enabled');
    const wecomEnabled = this.configService.get<boolean>('notification.wecom.enabled');

    if (emailEnabled) {
      const email = this.channelConfigs.get('email')!;
      email.enabled = true;
      email.config = {
        host: this.configService.get<string>('notification.email.host') || '',
        port: this.configService.get<string>('notification.email.port') || '587',
        user: this.configService.get<string>('notification.email.user') || '',
        password: this.configService.get<string>('notification.email.password') || '',
        from: this.configService.get<string>('notification.email.from') || '',
        to: this.configService.get<string>('notification.email.to') || '',
      };
    }

    if (slackEnabled) {
      const slack = this.channelConfigs.get('slack')!;
      slack.enabled = true;
      slack.config = {
        webhookUrl: this.configService.get<string>('notification.slack.webhookUrl') || '',
        channel: this.configService.get<string>('notification.slack.channel') || '#alerts',
      };
    }

    if (dingtalkEnabled) {
      const dingtalk = this.channelConfigs.get('dingtalk')!;
      dingtalk.enabled = true;
      dingtalk.config = {
        webhookUrl: this.configService.get<string>('notification.dingtalk.webhookUrl') || '',
      };
    }

    if (wecomEnabled) {
      const wecom = this.channelConfigs.get('wecom')!;
      wecom.enabled = true;
      wecom.config = {
        webhookUrl: this.configService.get<string>('notification.wecom.webhookUrl') || '',
      };
    }
  }

  getAllChannels(): NotificationChannel[] {
    return Array.from(this.channelConfigs.values());
  }

  getChannel(key: string): NotificationChannel | undefined {
    return this.channelConfigs.get(key);
  }

  updateChannel(key: string, data: { enabled?: boolean; config?: Record<string, string> }): NotificationChannel {
    const channel = this.channelConfigs.get(key);
    if (!channel) {
      throw new Error(`Unknown notification channel: ${key}`);
    }

    if (data.enabled !== undefined) {
      channel.enabled = data.enabled;
    }
    if (data.config) {
      channel.config = { ...channel.config, ...data.config };
    }

    return channel;
  }

  async testChannel(config: Record<string, string>): Promise<{ success: boolean; message: string }> {
    try {
      await this.notificationService.sendAll({
        title: 'AutoFlow 测试通知',
        content: `这是一条测试通知\n时间: ${new Date().toLocaleString()}`,
        level: 'info',
        config,
      });
      return { success: true, message: '测试消息发送成功' };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  async sendTest(data: { channels: string[]; title: string; content: string }): Promise<{ success: boolean; message: string }> {
    const { channels, title, content } = data;
    const payload = { title, content, level: 'info' as const };

    try {
      for (const channel of channels) {
        const config = this.channelConfigs.get(channel);
        if (!config?.enabled) {
          this.logger.warn(`Channel ${channel} is not enabled, skipping`);
          continue;
        }

        switch (channel) {
          case 'email':
            await this.notificationService['email'].send(payload);
            break;
          case 'slack':
            await this.notificationService['slack'].send(payload);
            break;
          case 'dingtalk':
            await this.notificationService['dingtalk'].send(payload);
            break;
          case 'wecom':
            await this.notificationService['wecom'].send(payload);
            break;
        }
      }
      return { success: true, message: '测试通知已发送' };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }
}
