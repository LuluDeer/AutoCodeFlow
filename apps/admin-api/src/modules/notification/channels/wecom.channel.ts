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
    // Q9: add timeout to prevent indefinite hang
    await axios.post(url, { msgtype: 'markdown', markdown: { content: `## ${p.title}
${p.content}` } }, { timeout: 10_000 });
  }
}
