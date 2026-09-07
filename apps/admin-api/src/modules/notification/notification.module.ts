import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ConfigModule } from "@nestjs/config";
import { NotificationService } from "./notification.service";
import { NotificationConfigService } from "./notification-config.service";
import { NotificationConfigController } from "./notification-config.controller";
import { AlertsController } from "./alerts.controller"; // OBS-02
import { NotificationSilence } from "./entities/notification-silence.entity";
import { NotificationSilenceService } from "./notification-silence.service";
import { ChannelConfigStore } from "./channel-config.store";
import { WecomChannel } from "./channels/wecom.channel";
import { DingtalkChannel } from "./channels/dingtalk.channel";
import { EmailChannel } from "./channels/email.channel";
import { SlackChannel } from "./channels/slack.channel";
import { WebhookChannel } from "./channels/webhook.channel";

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([NotificationSilence])],
  controllers: [NotificationConfigController, AlertsController],
  providers: [
    NotificationService,
    NotificationSilenceService,
    NotificationConfigService,
    ChannelConfigStore,
    WecomChannel,
    DingtalkChannel,
    EmailChannel,
    SlackChannel,
    WebhookChannel,
  ],
  exports: [
    NotificationService,
    NotificationConfigService,
    ChannelConfigStore,
    NotificationSilenceService,
  ],
})
export class NotificationModule {}
