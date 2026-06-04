import { Injectable, Logger } from '@nestjs/common';
import { BaseChannel, NotificationPayload } from './base.channel';

@Injectable()
export class EmailChannel extends BaseChannel {
  name = 'email';
  private logger = new Logger(EmailChannel.name);
  async send(p: NotificationPayload) {
    // TODO: 接入 nodemailer
    this.logger.log(`[Email] ${p.title}: ${p.content}`);
  }
}
