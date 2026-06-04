import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { BaseChannel, NotificationPayload } from './base.channel';

@Injectable()
export class WecomChannel extends BaseChannel {
  name = 'wecom';
  constructor(private config: ConfigService) { super(); }
  async send(p: NotificationPayload) {
    const url = this.config.get<string>('notification.wecomWebhook');
    if (!url) return;
    await axios.post(url, { msgtype: 'markdown', markdown: { content: `## ${p.title}\n${p.content}` } });
  }
}
