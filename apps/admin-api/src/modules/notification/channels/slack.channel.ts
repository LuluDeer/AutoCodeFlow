import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { BaseChannel, NotificationPayload } from './base.channel';

@Injectable()
export class SlackChannel extends BaseChannel {
  name = 'slack';
  private logger = new Logger(SlackChannel.name);

  constructor(private config: ConfigService) {
    super();
  }

  async send(p: NotificationPayload) {
    const webhook = this.config.get<string>('notification.slackWebhook');
    if (!webhook) return;
    try {
      await axios.post(webhook, {
        text: `*${p.title}*`,
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: p.title } },
          { type: 'section', text: { type: 'mrkdwn', text: p.content.slice(0, 3000) } },
        ],
      });
      this.logger.log(`[Slack] sent: ${p.title}`);
    } catch (e) {
      this.logger.error(`[Slack] send failed: ${e.message}`);
    }
  }
}
