import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { BaseChannel, NotificationPayload } from './base.channel';

@Injectable()
export class WecomChannel extends BaseChannel {
  name = 'wecom';
  private logger = new Logger(WecomChannel.name);

  constructor(private config: ConfigService) { super(); }

  async send(p: NotificationPayload) {
    const url = this.config.get<string>('notification.wecomWebhook');
    if (!url) return;

    try {
      await this.withRetry(async () => {
        await axios.post(url, { 
          msgtype: 'markdown', 
          markdown: { content: `## ${p.title}\n${p.content}` } 
        }, { timeout: 10_000 });
      });
      this.logger.log(`[Wecom] sent: ${p.title}`);
    } catch (error) {
      this.logger.error(`[Wecom] send failed after retries: ${error.message}`);
    }
  }
}
