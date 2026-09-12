import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ConfigModule } from "@nestjs/config";
import { NotificationService } from "./notification.service";
import { NotificationConfigService } from "./notification-config.service";
import { NotificationConfigController } from "./notification-config.controller";
import { AlertsController } from "./alerts.controller"; // OBS-02
import { NotificationSilence } from "./entities/notification-silence.entity";
// ARCH-31: 渠道配置共享持久化载体（迁移 1790000000014）。
import { NotificationChannelConfig } from "./entities/notification-channel-config.entity";
import { NotificationSilenceService } from "./notification-silence.service";
import { ChannelConfigStore } from "./channel-config.store";
import { WecomChannel } from "./channels/wecom.channel";
import { DingtalkChannel } from "./channels/dingtalk.channel";
import { EmailChannel } from "./channels/email.channel";
import { SlackChannel } from "./channels/slack.channel";
import { WebhookChannel } from "./channels/webhook.channel";
// NF-05: 飞书自定义机器人渠道（注册表第五类 webhook 渠道，payload text 版）
import { FeishuChannel } from "./channels/feishu.channel";
// ARCH-21: 执行终态事件监听器——Task 仓储用于回查告警配置（alarmEmail/
// alarmChannels/runbook，与迁移前 task.service.notifyCallbackFailure 同款只读
// 查询）。顺带闭合 OBS-02 AlertsController 一直缺 provider 的注入面（同一
// forFeature 注册，此前仅 spec mock 装配掩盖了缺口）。AuditModule 供
// NOTIFICATION_FAILED 审计兜底（迁移自 task.service，同样依赖）。
import { Task } from "../task/entities/task.entity";
import { AuditModule } from "../audit/audit.module";
import { ExecutionEventsListener } from "./execution-events.listener";

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([
      NotificationSilence,
      NotificationChannelConfig,
      Task,
    ]),
    AuditModule,
  ],
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
    FeishuChannel,
    ExecutionEventsListener,
  ],
  exports: [
    NotificationService,
    NotificationConfigService,
    ChannelConfigStore,
    NotificationSilenceService,
  ],
})
export class NotificationModule {}
