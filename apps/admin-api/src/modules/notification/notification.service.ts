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
    await Promise.allSettled([
      this.wecom.send(payload).catch(e => this.logger.warn(`wecom: ${e.message}`)),
      this.dingtalk.send(payload).catch(e => this.logger.warn(`dingtalk: ${e.message}`)),
      this.email.send(payload).catch(e => this.logger.warn(`email: ${e.message}`)),
      this.slack.send(payload).catch(e => this.logger.warn(`slack: ${e.message}`)),
    ]);
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
    const sends: Promise<any>[] = [];
    if (alarmChannels.includes('email')) sends.push(this.email.send(payload).catch(e => this.logger.warn(`email: ${e.message}`)));
    if (alarmChannels.includes('slack')) sends.push(this.slack.send(payload).catch(e => this.logger.warn(`slack: ${e.message}`)));
    if (alarmChannels.includes('dingtalk')) sends.push(this.dingtalk.send(payload).catch(e => this.logger.warn(`dingtalk: ${e.message}`)));
    if (alarmChannels.includes('wecom')) sends.push(this.wecom.send(payload).catch(e => this.logger.warn(`wecom: ${e.message}`)));
    await Promise.allSettled(sends);
  }
}
