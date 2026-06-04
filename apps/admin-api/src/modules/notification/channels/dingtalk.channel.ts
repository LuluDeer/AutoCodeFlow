import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { BaseChannel, NotificationPayload } from './base.channel';

@Injectable()
export class DingtalkChannel extends BaseChannel {
  name = 'dingtalk';
  constructor(private config: ConfigService) { super(); }
  async send(p: NotificationPayload) {
    const url = this.config.get<string>('notification.dingtalkWebhook');
    if (!url) return;
    // Q9: add timeout to prevent indefinite hang
    await axios.post(url, { msgtype: 'markdown', markdown: { title: p.title, text: `## ${p.title}\n${p.content}` } }, { timeout: 10_000 });
  }
}
