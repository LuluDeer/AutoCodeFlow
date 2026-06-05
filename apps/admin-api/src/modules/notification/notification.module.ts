import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NotificationService } from './notification.service';
import { NotificationConfigService } from './notification-config.service';
import { NotificationConfigController } from './notification-config.controller';
import { WecomChannel } from './channels/wecom.channel';
import { DingtalkChannel } from './channels/dingtalk.channel';
import { EmailChannel } from './channels/email.channel';
import { SlackChannel } from './channels/slack.channel';

@Module({
  imports: [ConfigModule],
  controllers: [NotificationConfigController],
  providers: [NotificationService, NotificationConfigService, WecomChannel, DingtalkChannel, EmailChannel, SlackChannel],
  exports: [NotificationService, NotificationConfigService],
})
export class NotificationModule {}
