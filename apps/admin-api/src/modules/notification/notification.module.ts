import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { NotificationService } from "./notification.service";
import { NotificationConfigService } from "./notification-config.service";
import { NotificationConfigController } from "./notification-config.controller";
import { ChannelConfigStore } from "./channel-config.store";
import { WecomChannel } from "./channels/wecom.channel";
import { DingtalkChannel } from "./channels/dingtalk.channel";
import { EmailChannel } from "./channels/email.channel";
import { SlackChannel } from "./channels/slack.channel";
import { WebhookChannel } from "./channels/webhook.channel";

@Module({
  imports: [ConfigModule],
  controllers: [NotificationConfigController],
  providers: [
    NotificationService,
    NotificationConfigService,
    ChannelConfigStore,
    WecomChannel,
    DingtalkChannel,
    EmailChannel,
    SlackChannel,
    WebhookChannel,
  ],
  exports: [NotificationService, NotificationConfigService, ChannelConfigStore],
})
export class NotificationModule {}
