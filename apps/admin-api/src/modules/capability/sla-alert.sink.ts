/**
 * N22 / ADR-044：SLA 告警的生产 sink 适配器。
 *
 * 把 SlaAlertConsumer 的受控消息转成现有 NotificationService.sendAll 调用。
 * 注意：中台 managed 渠道目标（channel id / URL / 密钥）由配置层持有，本适配器
 * 只把 consumer 已裁决好的 channels 透传，不读项目 enabled、不拼接外部 URL，
 * 保持"项目关不掉中台告警"的引擎级语义。无配置时 fail-closed 不发包。
 */
import type { NotificationPayload } from "../notification/channels/base.channel";
import type { AlertSink, SlaAlertMessage } from "./sla-alert.consumer";

export interface SlaNotificationSender {
  sendAll(payload: NotificationPayload): Promise<unknown>;
}

export class SlaNotificationSink implements AlertSink {
  constructor(private readonly sender: SlaNotificationSender | null) {}

  async send(message: SlaAlertMessage): Promise<void> {
    if (!this.sender) return; // fail-closed：无通知后端时不发包（consumer 已写失败审计）
    // channels 只含中台 managed 固定目标；projectReceivers 与审计元数据由 consumer
    // 合入 payload.vars（NotificationPayload 只有 title/content/level/vars 四字段）。
    const payload: NotificationPayload = {
      title: message.payload.title,
      content: message.payload.content,
      level: message.payload.level,
      vars: message.payload.vars,
    };
    await this.sender.sendAll(payload);
  }
}
