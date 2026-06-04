import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NotificationService } from './notification.service';
import { WecomChannel } from './channels/wecom.channel';
import { DingtalkChannel } from './channels/dingtalk.channel';
import { EmailChannel } from './channels/email.channel';
import { SlackChannel } from './channels/slack.channel';

@Module({
  imports: [ConfigModule],
  providers: [NotificationService, WecomChannel, DingtalkChannel, EmailChannel, SlackChannel],
  exports: [NotificationService],
})
export class NotificationModule {}
