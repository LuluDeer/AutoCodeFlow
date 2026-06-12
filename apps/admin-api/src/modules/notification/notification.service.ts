import { Injectable, Logger } from "@nestjs/common";
import { WecomChannel } from "./channels/wecom.channel";
import { DingtalkChannel } from "./channels/dingtalk.channel";
import { EmailChannel } from "./channels/email.channel";
import { SlackChannel } from "./channels/slack.channel";
import { NotificationPayload } from "./channels/base.channel";

export enum AlertLevel {
  INFO = "info",
  WARNING = "warning",
  ERROR = "error",
  CRITICAL = "critical",
}

export enum AlertChannel {
  EMAIL = "email",
  DINGTALK = "dingtalk",
  WECOM = "wecom",
  SLACK = "slack",
}

export interface AlertSilence {
  id?: string;
  taskId?: string;
  level?: AlertLevel;
  durationMinutes: number;
  startTime?: Date;
  endTime?: Date;
  createdAt?: Date;
}

@Injectable()
export class NotificationService {
  private logger = new Logger(NotificationService.name);
  private silences: Map<string, AlertSilence> = new Map();

  constructor(
    private wecom: WecomChannel,
    private dingtalk: DingtalkChannel,
    private email: EmailChannel,
    private slack: SlackChannel,
  ) {}

  async sendAll(payload: NotificationPayload) {
    this.logger.log(
      `[sendAll] title=${payload.title} level=${payload.level} content=${payload.content}`,
    );
    // Fan out to all four channels; individual failures are caught inside sendToChannels
    await this.sendToChannels(payload, [
      AlertChannel.EMAIL,
      AlertChannel.SLACK,
      AlertChannel.DINGTALK,
      AlertChannel.WECOM,
    ]);
  }

  async sendToChannels(payload: NotificationPayload, channels: AlertChannel[]) {
    const entries: Array<{ name: string; promise: Promise<any> }> = [];
    if (channels.includes(AlertChannel.EMAIL))
      entries.push({ name: "email", promise: this.email.send(payload) });
    if (channels.includes(AlertChannel.SLACK))
      entries.push({ name: "slack", promise: this.slack.send(payload) });
    if (channels.includes(AlertChannel.DINGTALK))
      entries.push({ name: "dingtalk", promise: this.dingtalk.send(payload) });
    if (channels.includes(AlertChannel.WECOM))
      entries.push({ name: "wecom", promise: this.wecom.send(payload) });

    const results = await Promise.allSettled(entries.map((e) => e.promise));
    const failures: string[] = [];
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        const msg =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        this.logger.error(
          `${entries[i].name} notification failed: ${msg}`,
          result.reason instanceof Error ? result.reason.stack : undefined,
        );
        failures.push(`${entries[i].name}: ${msg}`);
      }
    });

    if (failures.length > 0) {
      this.logger.warn(
        `Notification failed on channel(s): ${failures.join("; ")} — continuing without interrupting main flow`,
      );
    }
  }

  isSilenced(taskId?: string, level?: AlertLevel): boolean {
    const now = new Date();

    for (const silence of this.silences.values()) {
      const matchesTask = !silence.taskId || silence.taskId === taskId;
      const matchesLevel = !silence.level || silence.level === level;

      const isActive =
        (!silence.startTime || silence.startTime <= now) &&
        (!silence.endTime || silence.endTime >= now);

      if (matchesTask && matchesLevel && isActive) {
        return true;
      }
    }

    return false;
  }

  addSilence(silence: Omit<AlertSilence, "id" | "createdAt">): string {
    const id = `silence-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newSilence: AlertSilence = {
      ...silence,
      id,
      createdAt: new Date(),
    };

    if (silence.durationMinutes > 0 && !silence.endTime) {
      newSilence.endTime = new Date(
        Date.now() + silence.durationMinutes * 60 * 1000,
      );
    }

    this.silences.set(id, newSilence);
    return id;
  }

  removeSilence(id: string): boolean {
    return this.silences.delete(id);
  }

  getSilences(): AlertSilence[] {
    return Array.from(this.silences.values());
  }

  cleanExpiredSilences(): number {
    const now = new Date();
    let removedCount = 0;

    for (const [id, silence] of this.silences) {
      if (silence.endTime && silence.endTime < now) {
        this.silences.delete(id);
        removedCount++;
      }
    }

    return removedCount;
  }

  async notify(
    taskName: string,
    message: string,
    level: AlertLevel = AlertLevel.INFO,
    taskId?: string,
    channels?: AlertChannel[],
  ) {
    if (this.isSilenced(taskId, level)) {
      this.logger.debug(
        `Alert silenced for task ${taskName} (level: ${level})`,
      );
      return;
    }

    const payload: NotificationPayload = {
      title: `[${level.toUpperCase()}] ${taskName}`,
      content: message,
      level,
    };

    if (channels && channels.length > 0) {
      await this.sendToChannels(payload, channels);
    } else {
      await this.sendAll(payload);
    }
  }

  async notifyFailure(
    taskName: string,
    execId: string,
    error: string,
    aiAnalysis?: string,
    taskId?: string,
  ) {
    if (this.isSilenced(taskId, AlertLevel.ERROR)) {
      this.logger.debug(`Failure alert silenced for task ${taskName}`);
      return;
    }

    return this.sendAll({
      title: `任务失败: ${taskName}`,
      content: `执行ID: ${execId}\n错误: ${error}${aiAnalysis ? `\n\nAI分析:\n${aiAnalysis}` : ""}`,
      level: "error",
    });
  }

  async notifySuccess(
    taskName: string,
    execId: string,
    durationMs: number,
    taskId?: string,
  ) {
    if (this.isSilenced(taskId, AlertLevel.INFO)) {
      this.logger.debug(`Success alert silenced for task ${taskName}`);
      return;
    }

    return this.sendAll({
      title: `任务成功: ${taskName}`,
      content: `执行ID: ${execId}\n耗时: ${durationMs}ms`,
      level: "info",
    });
  }

  async notifyTimeout(
    taskName: string,
    execId: string,
    timeoutSec: number,
    taskId?: string,
  ) {
    if (this.isSilenced(taskId, AlertLevel.WARNING)) {
      this.logger.debug(`Timeout alert silenced for task ${taskName}`);
      return;
    }

    return this.sendAll({
      title: `任务超时: ${taskName}`,
      content: `执行ID: ${execId}\n超时时间: ${timeoutSec}秒`,
      level: "warning",
    });
  }

  async notifyExecutorOffline(executorName: string, address: string) {
    if (this.isSilenced(undefined, AlertLevel.WARNING)) {
      this.logger.debug(`Executor offline alert silenced`);
      return;
    }

    return this.sendAll({
      title: `执行器离线: ${executorName}`,
      content: `地址: ${address}\n时间: ${new Date().toLocaleString()}`,
      level: "warning",
    });
  }

  async notifyExecutorOnline(executorName: string, address: string) {
    if (this.isSilenced(undefined, AlertLevel.INFO)) {
      this.logger.debug(`Executor online alert silenced`);
      return;
    }

    return this.sendAll({
      title: `执行器上线: ${executorName}`,
      content: `地址: ${address}\n时间: ${new Date().toLocaleString()}`,
      level: "info",
    });
  }

  async notifyFailureWithConfig(
    taskName: string,
    execId: string,
    error: string,
    aiAnalysis: string,
    alarmEmail?: string,
    alarmChannels?: string[],
  ) {
    const taskChannels =
      (alarmChannels?.map((c) => c.toLowerCase()) as AlertChannel[]) || [];

    if (this.isSilenced(undefined, AlertLevel.ERROR)) {
      this.logger.debug(`Failure alert silenced for task ${taskName}`);
      return;
    }

    if (!alarmChannels || alarmChannels.length === 0) {
      return this.notifyFailure(taskName, execId, error, aiAnalysis);
    }
    const payload: NotificationPayload = {
      title: `任务失败: ${taskName}`,
      content: `执行ID: ${execId}\n错误: ${error}${aiAnalysis ? `\n\nAI分析:\n${aiAnalysis}` : ""}${alarmEmail ? `\n收件人: ${alarmEmail}` : ""}`,
      level: "error",
    };

    return this.sendToChannels(payload, taskChannels);
  }
}
