import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { WecomChannel } from "./channels/wecom.channel";
import { DingtalkChannel } from "./channels/dingtalk.channel";
import { EmailChannel } from "./channels/email.channel";
import { SlackChannel } from "./channels/slack.channel";
import { WebhookChannel } from "./channels/webhook.channel";
import {
  ChannelDeliveryStatus,
  NotificationPayload,
} from "./channels/base.channel";
// 可观测性补齐轮：通知投递结果计数埋点入口（模块级纯内存自增，无模块环，
// 见 metrics/runtime-metrics-entry.ts 注释）。
import { recordRuntime } from "../metrics/runtime-metrics-entry";

/** NOTIF-003: 静默规则数量上限，防止通过 API 无限添加导致内存缓慢泄漏。 */
export const MAX_ALERT_SILENCES = 1000;
/** NOTIF-003: 过期静默规则的定时清理间隔。 */
const SILENCE_CLEANUP_INTERVAL_MS = 60_000;

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
  WEBHOOK = "webhook",
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

/**
 * V2 (round-7): per-channel delivery outcomes of one fan-out. The HTTP status
 * stays 2xx even when individual channels fail or are SSRF-blocked (a failed
 * notification must never 500 a task callback), but the response body now
 * tells the caller exactly what happened on each channel instead of hiding it
 * in server logs.
 */
export type ChannelDeliveryResults = Record<string, ChannelDeliveryStatus>;

@Injectable()
export class NotificationService implements OnModuleInit, OnModuleDestroy {
  private logger = new Logger(NotificationService.name);
  // NOTIF-003: 静默规则是内存态（Map），重启即失效。
  // 这是有意的可接受降级：通知静默是短时操作（通常几分钟到几小时），
  // 引入 Redis/DB 持久化会为低频功能增加额外依赖与多实例一致性复杂度；
  // 静默丢失的最坏后果只是重复收到告警，不影响业务正确性。
  private silences: Map<string, AlertSilence> = new Map();
  private silenceCleanupTimer?: NodeJS.Timeout;

  constructor(
    private wecom: WecomChannel,
    private dingtalk: DingtalkChannel,
    private email: EmailChannel,
    private slack: SlackChannel,
    private webhook: WebhookChannel,
  ) {}

  /**
   * NOTIF-002: 构建 sendAll 日志用的脱敏摘要。
   * 只保留内容长度与前 80 字符，并剥离 token/密钥样式字符串
   * （思路同 ai 模块 sanitizeLogs：env 赋值、Bearer token、长 hex/base64），
   * 避免任务日志片段、错误堆栈或 AI 分析中的敏感数据进入日志。
   */
  private buildContentDigest(content: string | undefined): string {
    const len = content?.length ?? 0;
    if (len === 0) return "[0 chars]";
    const sanitized = (content ?? "")
      // env var assignments: KEY=value
      .replace(/([A-Z_]{3,}\s*=\s*)[^\s\n]+/g, "$1[REDACTED]")
      // Bearer / token headers
      .replace(/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, "$1[REDACTED]")
      // long hex strings (>=32 chars — likely keys/tokens)
      .replace(/[0-9a-fA-F]{32,}/g, "[REDACTED_HEX]")
      // long base64-like strings (>=40 chars)
      .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, "[REDACTED_B64]");
    const truncated =
      sanitized.length > 80 ? `${sanitized.slice(0, 80)}...` : sanitized;
    // 换行折叠成空格，防止长堆栈把日志行拆碎
    return `[${len} chars] ${truncated.replace(/\s+/g, " ")}`;
  }

  /**
   * NOTIF-003: 启动时开启过期静默规则的定时清理。
   * timer.unref() 保证清理定时器不会阻止 Node 进程正常退出。
   */
  onModuleInit() {
    this.silenceCleanupTimer = setInterval(() => {
      try {
        this.cleanExpiredSilences();
      } catch (e) {
        this.logger.warn(
          `silence cleanup failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }, SILENCE_CLEANUP_INTERVAL_MS);
    this.silenceCleanupTimer.unref();
  }

  onModuleDestroy() {
    if (this.silenceCleanupTimer) {
      clearInterval(this.silenceCleanupTimer);
      this.silenceCleanupTimer = undefined;
    }
  }

  async sendAll(payload: NotificationPayload): Promise<ChannelDeliveryResults> {
    // NOTIF-002: 日志只记渠道类型 + 内容长度 + 前 80 字符脱敏摘要，不记原文
    const channels: AlertChannel[] = [
      AlertChannel.EMAIL,
      AlertChannel.SLACK,
      AlertChannel.DINGTALK,
      AlertChannel.WECOM,
      AlertChannel.WEBHOOK,
    ];
    this.logger.log(
      `[sendAll] channels=${channels.join(",")} title=${payload.title} level=${payload.level} content=${this.buildContentDigest(payload.content)}`,
    );
    // Fan out to all channels; individual failures are caught inside sendToChannels
    return this.sendToChannels(payload, channels);
  }

  async sendToChannels(
    payload: NotificationPayload,
    channels: AlertChannel[],
    webhookUrl?: string,
  ): Promise<ChannelDeliveryResults> {
    const entries: Array<{
      name: string;
      promise: Promise<ChannelDeliveryStatus | void>;
    }> = [];
    if (channels.includes(AlertChannel.EMAIL))
      entries.push({ name: "email", promise: this.email.send(payload) });
    if (channels.includes(AlertChannel.SLACK))
      entries.push({ name: "slack", promise: this.slack.send(payload) });
    if (channels.includes(AlertChannel.DINGTALK))
      entries.push({ name: "dingtalk", promise: this.dingtalk.send(payload) });
    if (channels.includes(AlertChannel.WECOM))
      entries.push({ name: "wecom", promise: this.wecom.send(payload) });
    if (channels.includes(AlertChannel.WEBHOOK))
      entries.push({
        name: "webhook",
        promise: this.webhook.send(payload, webhookUrl),
      });

    const results = await Promise.allSettled(entries.map((e) => e.promise));
    // V2 (round-7): surface the per-channel outcome to the caller. Rejected
    // promises stay "failed"; fulfilled ones carry the channel's own status
    // (mocked/legacy channels returning undefined count as "sent").
    const delivery: ChannelDeliveryResults = {};
    const failures: string[] = [];
    results.forEach((result, i) => {
      const name = entries[i].name;
      // 可观测性补齐：per-channel 投递结果计数（success/failure）。判定口径：
      // promise rejected（渠道异常）计 failure，其余（含 mocked/blocked——
      // SSRF 拦截是策略结果而非投递故障）计 success。fail-open 语义不变：
      // 只记计数，不影响返回值与控制流。
      recordRuntime("autoflow_notification_delivery_total", {
        channel: name,
        result: result.status === "rejected" ? "failure" : "success",
      });
      if (result.status === "rejected") {
        const msg =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        this.logger.error(
          `${name} notification failed: ${msg}`,
          result.reason instanceof Error ? result.reason.stack : undefined,
        );
        failures.push(`${name}: ${msg}`);
        delivery[name] = "failed";
      } else {
        const status = (result.value ?? "sent") as ChannelDeliveryStatus;
        delivery[name] = status;
        if (status === "blocked") {
          this.logger.warn(
            `${name} notification blocked by SSRF guard — see channel log for the URL`,
          );
        }
      }
    });

    if (failures.length > 0) {
      this.logger.warn(
        `Notification failed on channel(s): ${failures.join("; ")} — continuing without interrupting main flow`,
      );
    }
    return delivery;
  }

  /**
   * R2: dispatch exactly one channel's send() with an optional per-call
   * config override. Used by NotificationConfigService.testChannel to
   * validate unsaved admin-form values without publishing them to the
   * global ChannelConfigStore. The override NEVER reaches
   * sendToChannels / sendAll and therefore cannot affect any other
   * in-flight or future notification.
   *
   * Fail-open posture preserved: an SSRF block returns "blocked" instead
   * of throwing, matching the existing fan-out contract.
   */
  async testChannel(
    payload: NotificationPayload,
    channel: AlertChannel,
    configOverride?: Record<string, string>,
  ): Promise<ChannelDeliveryStatus> {
    switch (channel) {
      case AlertChannel.EMAIL:
        return this.email.send(payload, configOverride);
      case AlertChannel.SLACK:
        return this.slack.send(payload, configOverride);
      case AlertChannel.DINGTALK:
        return this.dingtalk.send(payload, configOverride);
      case AlertChannel.WECOM:
        return this.wecom.send(payload, configOverride);
      case AlertChannel.WEBHOOK:
        return this.webhook.send(payload, undefined, configOverride);
      default:
        return "skipped";
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
    // NOTIF-003: size 上限——超限拒绝新增（4xx 语义），防止 API 被滥用造成内存泄漏
    if (this.silences.size >= MAX_ALERT_SILENCES) {
      this.logger.warn(
        `addSilence rejected: silence count reached limit ${MAX_ALERT_SILENCES}`,
      );
      throw new BadRequestException(
        `Too many alert silences (max ${MAX_ALERT_SILENCES}). Remove expired ones first.`,
      );
    }
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
      title: `Task failed: ${taskName}`,
      content: `Execution ID: ${execId}\nError: ${error}${aiAnalysis ? `\n\nAI Analysis:\n${aiAnalysis}` : ""}`,
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
      title: `Task succeeded: ${taskName}`,
      content: `Execution ID: ${execId}\nDuration: ${durationMs}ms`,
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
      title: `Task timed out: ${taskName}`,
      content: `Execution ID: ${execId}\nTimeout: ${timeoutSec}s`,
      level: "warning",
    });
  }

  async notifyExecutorOffline(executorName: string, address: string) {
    if (this.isSilenced(undefined, AlertLevel.WARNING)) {
      this.logger.debug(`Executor offline alert silenced`);
      return;
    }

    return this.sendAll({
      title: `Executor offline: ${executorName}`,
      content: `Address: ${address}\nTime: ${new Date().toLocaleString()}`,
      level: "warning",
    });
  }

  async notifyExecutorOnline(executorName: string, address: string) {
    if (this.isSilenced(undefined, AlertLevel.INFO)) {
      this.logger.debug(`Executor online alert silenced`);
      return;
    }

    return this.sendAll({
      title: `Executor online: ${executorName}`,
      content: `Address: ${address}\nTime: ${new Date().toLocaleString()}`,
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
    webhookUrl?: string,
    taskId?: string,
  ) {
    const taskChannels =
      (alarmChannels?.map((c) => c.toLowerCase()) as AlertChannel[]) || [];

    // 补传 taskId：修复原先 isSilenced(undefined,...) 使任务级静默窗口对本路径
    // 失效的问题，与 notifyFailure 保持一致（taskId 缺省时行为不变）。
    if (this.isSilenced(taskId, AlertLevel.ERROR)) {
      this.logger.debug(`Failure alert silenced for task ${taskName}`);
      return;
    }

    if (!alarmChannels || alarmChannels.length === 0) {
      return this.notifyFailure(taskName, execId, error, aiAnalysis, taskId);
    }
    const payload: NotificationPayload = {
      title: `Task failed: ${taskName}`,
      content: `Execution ID: ${execId}\nError: ${error}${aiAnalysis ? `\n\nAI Analysis:\n${aiAnalysis}` : ""}${alarmEmail ? `\nRecipient: ${alarmEmail}` : ""}`,
      level: "error",
    };

    return this.sendToChannels(payload, taskChannels, webhookUrl);
  }

  /**
   * Send a one-off outbound webhook notification to a specific URL.
   * Useful for per-task webhook callbacks configured by the user.
   *
   * V2 (round-7): unlike the fan-out paths (which stay fail-open so a broken
   * alarm never interrupts task flows), this direct-call path must make an
   * SSRF block visible to its caller — the URL was supplied explicitly in
   * the request, so a rejection is an input error: BadRequestException (400).
   *
   * N37 (round-10): the explicit `url` is also the resolution winner inside
   * WebhookChannel.send (explicit argument > saved enabled config > env),
   * so the 400 below always reports the very URL the caller passed — the
   * saved channel config can never reroute this path behind the caller's
   * back (the round-9 store-first flip was the bug).
   */
  async sendWebhook(
    payload: NotificationPayload,
    url: string,
  ): Promise<ChannelDeliveryStatus> {
    const status = await this.webhook.send(payload, url);
    if (status === "blocked") {
      throw new BadRequestException(
        `Webhook URL rejected by SSRF policy (private/loopback/link-local/benchmark/CGNAT targets are not allowed): ${url}`,
      );
    }
    return status;
  }
}
