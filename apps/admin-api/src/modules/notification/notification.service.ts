import { Injectable, Logger } from '@nestjs/common';
import { WecomChannel } from './channels/wecom.channel';
import { DingtalkChannel } from './channels/dingtalk.channel';
import { EmailChannel } from './channels/email.channel';
import { SlackChannel } from './channels/slack.channel';
import { NotificationPayload } from './channels/base.channel';

@Injectable()
export class NotificationService {
  private logger = new Logger(NotificationService.name);
  constructor(
    private wecom: WecomChannel,
    private dingtalk: DingtalkChannel,
    private email: EmailChannel,
    private slack: SlackChannel,
  ) {}

  async sendAll(payload: NotificationPayload) {
    const results = await Promise.allSettled([
      this.wecom.send(payload),
      this.dingtalk.send(payload),
      this.email.send(payload),
      this.slack.send(payload),
    ]);

    const channelNames = ['wecom', 'dingtalk', 'email', 'slack'];
    const failures: string[] = [];
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.logger.error(`${channelNames[i]} notification failed: ${msg}`, result.reason instanceof Error ? result.reason.stack : undefined);
        failures.push(`${channelNames[i]}: ${msg}`);
      }
    });

    if (failures.length > 0) {
      throw new Error(`Notification failed on channel(s): ${failures.join('; ')}`);
    }
  }

  notifyFailure(taskName: string, execId: string, error: string, aiAnalysis?: string) {
    return this.sendAll({
      title: `任务失败: ${taskName}`,
      content: `执行ID: ${execId}\n错误: ${error}${aiAnalysis ? `\n\nAI分析:\n${aiAnalysis}` : ''}`,
      level: 'error',
    });
  }

  async notifyFailureWithConfig(
    taskName: string, execId: string, error: string, aiAnalysis: string,
    alarmEmail?: string, alarmChannels?: string[],
  ) {
    // 无任务级配置时降级为全局默认
    if (!alarmChannels || alarmChannels.length === 0) {
      return this.notifyFailure(taskName, execId, error, aiAnalysis);
    }
    const payload: NotificationPayload = {
      title: `任务失败: ${taskName}`,
      content: `执行ID: ${execId}\n错误: ${error}${aiAnalysis ? `\n\nAI分析:\n${aiAnalysis}` : ''}${alarmEmail ? `\n收件人: ${alarmEmail}` : ''}`,
      level: 'error',
    };

    const entries: Array<{ name: string; promise: Promise<any> }> = [];
    if (alarmChannels.includes('email')) entries.push({ name: 'email', promise: this.email.send(payload) });
    if (alarmChannels.includes('slack')) entries.push({ name: 'slack', promise: this.slack.send(payload) });
    if (alarmChannels.includes('dingtalk')) entries.push({ name: 'dingtalk', promise: this.dingtalk.send(payload) });
    if (alarmChannels.includes('wecom')) entries.push({ name: 'wecom', promise: this.wecom.send(payload) });

    const results = await Promise.allSettled(entries.map(e => e.promise));
    const failures: string[] = [];
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.logger.error(`${entries[i].name} notification failed: ${msg}`, result.reason instanceof Error ? result.reason.stack : undefined);
        failures.push(`${entries[i].name}: ${msg}`);
      }
    });

    if (failures.length > 0) {
      throw new Error(`Notification failed on channel(s): ${failures.join('; ')}`);
    }
  }
}
