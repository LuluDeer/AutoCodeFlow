import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { WecomChannel } from "./channels/wecom.channel";
import { DingtalkChannel } from "./channels/dingtalk.channel";
import { EmailChannel } from "./channels/email.channel";
import { SlackChannel } from "./channels/slack.channel";
import { WebhookChannel } from "./channels/webhook.channel";
// NF-05: 飞书自定义机器人渠道（渠道白名单第六类，AlertChannel 同步扩展）
import { FeishuChannel } from "./channels/feishu.channel";
import { NotificationSilenceService } from "./notification-silence.service";
import { ChannelConfigStore } from "./channel-config.store";
import {
  ChannelDeliveryStatus,
  NotificationPayload,
} from "./channels/base.channel";
// 可观测性补齐轮：通知投递结果计数埋点入口（模块级纯内存自增，无模块环，
// 见 metrics/runtime-metrics-entry.ts 注释）。
import { recordRuntime } from "../metrics/runtime-metrics-entry";
// FEAT-10: 渠道级模板渲染（单 pass 替换 + 8KB 上限 + 未知变量保留原文）
import {
  renderTemplate,
  hasChannelTemplate,
} from "../../common/utils/render-template.util";

/** NOTIF-003: 静默规则数量上限，防止通过 API 无限添加导致内存缓慢泄漏。 */
export const MAX_ALERT_SILENCES = 1000;
/** NOTIF-003: 过期静默规则的定时清理间隔。 */
const SILENCE_CLEANUP_INTERVAL_MS = 60_000;
/**
 * ARCH-31: 静默规则的跨实例读穿刷新间隔（默认 15s）。静默是低频人写、高频
 * 热读的状态，TTL 收敛（无需 Redis pub/sub）即可把「实例 A 创建的静默在
 * 实例 B 不生效」的窗口压到秒级；周期可由 env `SILENCE_REFRESH_MS` 调整。
 */
const SILENCE_REFRESH_INTERVAL_MS = 15_000;

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
  // NF-05: 飞书自定义机器人（open.feishu.cn webhook，text payload + 可选加签）
  FEISHU = "feishu",
}

export interface AlertSilence {
  id?: string;
  /** FEAT-01：静默范围（默认 global，兼容存量内存态） */
  scope?: "global" | "task" | "application";
  /** FEAT-01：仅静默该渠道（空=全渠道） */
  channelType?: string;
  applicationId?: string;
  taskId?: string;
  level?: AlertLevel;
  durationMinutes: number;
  startTime?: Date;
  endTime?: Date;
  reason?: string;
  createdAt?: Date;
  /**
   * ARCH-31: 该静默在 DB 中的行 id（写穿成功后回填）。内存 Map 的键始终是
   * `addSilence()` 返回给调用方的那个 id（先例：管理台拿它去 DELETE），
   * 故另存 DB id 供跨实例刷新去重与 `removeSilence` 定位 DB 行。
   */
  dbId?: string;
  /**
   * ARCH-31: 写穿状态。`false` = 已提交写穿但尚未拿到 DB id（在途或写失败），
   * 周期刷新必须保留它（否则一条刚创建、还没落库的静默会被刷新抖掉）。
   */
  persisted?: boolean;
  /**
   * ARCH-31: 该规则是否已被任一周期刷新在 DB 中读到过。只有「确认存在过、
   * 如今消失」才判定为其他实例删除/已过期从而丢弃——避免复制延迟把刚创建
   * 的静默误删。
   */
  observedInDb?: boolean;
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
  /** ARCH-31: 跨实例静默读穿刷新定时器（无持久化层时不启）。 */
  private silenceRefreshTimer?: NodeJS.Timeout;

  constructor(
    private wecom: WecomChannel,
    private dingtalk: DingtalkChannel,
    private email: EmailChannel,
    private slack: SlackChannel,
    private webhook: WebhookChannel,
    // NF-05: 飞书渠道（sendAll 第六路扇出；testChannel switch 同步）
    private feishu: FeishuChannel,
    // FEAT-01: 静默规则持久化写穿层——@Optional 保证存量测试模块与
    // DB 不可用场景都降级回 NOTIF-003 的纯内存语义
    @Optional()
    @Inject(NotificationSilenceService)
    private silenceStore?: NotificationSilenceService,
    // FEAT-10: 渠道级模板读取源（与各渠道同源的 ChannelConfigStore 单例）。
    // @Optional 先例同 silenceStore——存量测试模块未提供时模板整体旁路，
    // 固定拼串行为不变。
    @Optional()
    private channelStore?: ChannelConfigStore,
    // ARCH-27/31: env 一律经 ConfigService；@Optional 同 silenceStore——
    // 存量测试模块未提供时静默刷新周期回落默认值。
    @Optional()
    private readonly configService?: ConfigService,
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
    // FEAT-01: 重启后从 DB 回灌生效中的静默（失败降级内存态）
    void this.restoreSilencesFromStore();
    // ARCH-31: 周期读穿刷新——多实例下「在实例 A 创建的静默」在一个刷新
    // 周期内对实例 B 生效（此前只有 onModuleInit 回灌一次，B 永远看不到）。
    if (this.silenceStore) {
      const intervalMs = this.resolveSilenceRefreshMs();
      this.silenceRefreshTimer = setInterval(() => {
        void this.syncSilencesFromStore();
      }, intervalMs);
      this.silenceRefreshTimer.unref();
    }
  }

  /**
   * ARCH-31: 静默刷新周期（ms）——`notification.silenceRefreshMs`（env
   * `SILENCE_REFRESH_MS`），缺省/非法值回落 15s（下限 1s 防 DB 打爆）。
   */
  private resolveSilenceRefreshMs(): number {
    const configured = this.configService?.get<number>(
      "notification.silenceRefreshMs",
    );
    if (
      typeof configured !== "number" ||
      !Number.isFinite(configured) ||
      configured < 1_000
    ) {
      return SILENCE_REFRESH_INTERVAL_MS;
    }
    return configured;
  }

  /**
   * FEAT-01 + ARCH-31: 把 DB 中生效中的静默同步进内存 Map。
   *
   * - `initial=true`（启动回灌，NOTIF-003 语义）：只补缺失行，不动本地态；
   * - `initial=false`（周期刷新）：DB 是跨实例唯一真相，覆盖式重建内存态，
   *   但保留两类本地项——① 写穿在途/写失败（`persisted === false`）的刚创建
   *   静默；② 键为本地临时 id、DB 行已存在的同一条规则（去重后保留本地键，
   *   使 `addSilence()` 返回给管理台的 id 始终可用）。
   *
   * DB 缺席或查询异常时整体 no-op，保持 NOTIF-003 纯内存语义。
   */
  private async restoreSilencesFromStore(): Promise<void> {
    if (!this.silenceStore) return;
    try {
      const rows = await this.silenceStore.listActive();
      let restored = 0;
      for (const row of rows) {
        if (this.silences.has(row.id)) continue;
        this.silences.set(row.id, this.mapSilenceRow(row));
        restored++;
      }
      if (restored > 0) {
        this.logger.log(
          `[silences] restored ${restored} persisted silence(s) from DB`,
        );
      }
    } catch (e) {
      this.logger.warn(
        `[silences] DB restore failed (memory-only mode): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private async syncSilencesFromStore(): Promise<void> {
    if (!this.silenceStore) return;
    try {
      const rows = await this.silenceStore.listActive();
      const next = new Map<string, AlertSilence>();
      for (const row of rows) {
        next.set(row.id, this.mapSilenceRow(row));
      }
      for (const [id, local] of this.silences) {
        if (next.has(id)) continue;
        // 本地临时键 + DB 同源行：去重后保留本地键（API 返回的 id 仍可删除）
        if (local.dbId && next.has(local.dbId)) {
          next.delete(local.dbId);
          local.observedInDb = true;
          next.set(id, local);
          continue;
        }
        // 写穿在途（未拿到 DB id）或「已落库但尚未被任一刷新读到」：保留。
        // 后者覆盖主从复制延迟 / 读己之写窗口——否则刚创建的静默会在下一次
        // 刷新被自己抖掉。
        if (local.persisted === false || local.observedInDb !== true) {
          next.set(id, local);
          continue;
        }
        // 其余（已被 DB 确认过、如今行已消失 = 其他实例删除或已过期）→ 丢弃
      }
      this.silences = next;
    } catch (e) {
      this.logger.warn(
        `[silences] DB sync failed (memory-only mode): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** FEAT-01/ARCH-31: DB 行 → 内存静默对象（唯一映射点，防双写漂移）。 */
  private mapSilenceRow(row: {
    id: string;
    scope: string;
    channelType: string | null;
    applicationId: string | null;
    taskId: string | null;
    level: string | null;
    reason: string | null;
    startTime: Date | null;
    endTime: Date | null;
    durationMinutes: number | null;
    createdAt: Date;
  }): AlertSilence {
    return {
      id: row.id,
      dbId: row.id,
      persisted: true,
      observedInDb: true,
      scope: row.scope as AlertSilence["scope"],
      channelType: row.channelType ?? undefined,
      applicationId: row.applicationId ?? undefined,
      taskId: row.taskId ?? undefined,
      level: (row.level as AlertLevel | null) ?? undefined,
      reason: row.reason ?? undefined,
      startTime: row.startTime ?? undefined,
      endTime: row.endTime ?? undefined,
      durationMinutes: row.durationMinutes ?? undefined,
      createdAt: row.createdAt,
    };
  }

  onModuleDestroy() {
    if (this.silenceCleanupTimer) {
      clearInterval(this.silenceCleanupTimer);
      this.silenceCleanupTimer = undefined;
    }
    if (this.silenceRefreshTimer) {
      clearInterval(this.silenceRefreshTimer);
      this.silenceRefreshTimer = undefined;
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
      AlertChannel.FEISHU,
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
    // FEAT-10: per-channel template rendering. When the sender attached a
    // template variable table (vars) AND the target channel's saved config
    // declares titleTemplate/contentTemplate, the channel's copy is rendered
    // through the sandboxed renderer (single-pass replacement, 8KB output
    // cap, unknown variables kept verbatim). Fail-open: any rendering error
    // falls back to the original fixed strings with a warn — a broken
    // template must never suppress or 500 a notification. Channels without
    // templates receive the payload unchanged (zero breakage).
    const rendered = this.applyChannelTemplates(payload, channels);

    const entries: Array<{
      name: string;
      promise: Promise<ChannelDeliveryStatus | void>;
    }> = [];
    if (channels.includes(AlertChannel.EMAIL))
      entries.push({
        name: "email",
        promise: this.email.send(rendered.email ?? payload),
      });
    if (channels.includes(AlertChannel.SLACK))
      entries.push({
        name: "slack",
        promise: this.slack.send(rendered.slack ?? payload),
      });
    if (channels.includes(AlertChannel.DINGTALK))
      entries.push({
        name: "dingtalk",
        promise: this.dingtalk.send(rendered.dingtalk ?? payload),
      });
    if (channels.includes(AlertChannel.WECOM))
      entries.push({
        name: "wecom",
        promise: this.wecom.send(rendered.wecom ?? payload),
      });
    if (channels.includes(AlertChannel.WEBHOOK))
      entries.push({
        name: "webhook",
        promise: this.webhook.send(rendered.webhook ?? payload, webhookUrl),
      });
    // NF-05: 飞书渠道扇出（与既有五渠道同语义——rendered 优先，缺省原 payload）
    if (channels.includes(AlertChannel.FEISHU))
      entries.push({
        name: "feishu",
        promise: this.feishu.send(rendered.feishu ?? payload),
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
  /**
   * FEAT-10: build the per-channel rendered payload map. For each requested
   * channel: if its saved config (ChannelConfigStore, published by
   * PATCH /notification/channels/:key) has a non-empty titleTemplate and/or
   * contentTemplate AND the payload carries `vars`, render a channel-local
   * copy. Rendering is wrapped in try/catch — on failure the original
   * payload is used and a warn is logged (fail-open). Payloads without
   * `vars` (e.g. admin "test" sends) bypass templates entirely.
   */
  private applyChannelTemplates(
    payload: NotificationPayload,
    channels: AlertChannel[],
  ): Record<AlertChannel, NotificationPayload> {
    const out = {} as Record<AlertChannel, NotificationPayload>;
    if (!payload.vars) return out;
    for (const channel of channels) {
      try {
        const config = this.channelStore?.get(channel);
        if (!hasChannelTemplate(config)) continue;
        const next: NotificationPayload = { ...payload };
        if (config!.titleTemplate) {
          next.title = renderTemplate(config!.titleTemplate, payload.vars);
        }
        if (config!.contentTemplate) {
          next.content = renderTemplate(config!.contentTemplate, payload.vars);
        }
        // 渲染后的渠道专属副本不再携带 vars（下游渠道不做二次渲染）
        delete next.vars;
        out[channel] = next;
      } catch (e) {
        this.logger.warn(
          `[templates] rendering failed for channel ${channel} — falling back to the default content: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return out;
  }

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
      // NF-05: 飞书测试发送（R2 per-call override 语义与既有 webhook 渠道一致）
      case AlertChannel.FEISHU:
        return this.feishu.send(payload, configOverride);
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
      // ARCH-31: 写穿在途标记——周期刷新据此保留本地项（拿到 DB id 后转 true）
      persisted: this.silenceStore ? false : undefined,
    };

    if (silence.durationMinutes > 0 && !silence.endTime) {
      newSilence.endTime = new Date(
        Date.now() + silence.durationMinutes * 60 * 1000,
      );
    }

    this.silences.set(id, newSilence);
    // FEAT-01: 写穿持久化（异步、失败仅告警——内存态语义不受影响）
    if (this.silenceStore) {
      void this.silenceStore
        .create({
          scope: newSilence.scope ?? (newSilence.taskId ? "task" : "global"),
          channelType: newSilence.channelType ?? null,
          taskId: newSilence.taskId ?? null,
          applicationId: newSilence.applicationId ?? null,
          level: newSilence.level ?? null,
          reason: newSilence.reason ?? null,
          durationMinutes: newSilence.durationMinutes ?? null,
          startTime: newSilence.startTime ?? null,
          endTime: newSilence.endTime ?? null,
        })
        .then((row) => {
          // ARCH-31: 记录 DB 行 id——removeSilence 据此删库、周期刷新据此
          // 去重（内存键仍是返回给调用方的本地 id，故不换键）。
          newSilence.dbId = row.id;
          newSilence.persisted = true;
        })
        .catch((e) => {
          this.logger.warn(
            `[silences] DB persist failed (memory-only): ${e instanceof Error ? e.message : String(e)}`,
          );
        });
    }
    return id;
  }

  /**
   * ARCH-31/FEAT-01: 把「由 API 直接落库」的静默行同步进内存热路径。
   *
   * `POST /notification/silences` 此前只经 NotificationSilenceService 写 DB，
   * 从不喂给 `isSilenced` 读的内存 Map——**规则要等进程重启回灌才生效**（单
   * 实例亦然，属既存缺陷）。管理台创建后立刻 adopt，本实例即时生效；其余
   * 实例在一个读穿刷新周期内生效。
   */
  adoptPersistedSilence(row: {
    id: string;
    scope: string;
    channelType: string | null;
    applicationId: string | null;
    taskId: string | null;
    level: string | null;
    reason: string | null;
    startTime: Date | null;
    endTime: Date | null;
    durationMinutes: number | null;
    createdAt: Date;
  }): AlertSilence {
    const silence = this.mapSilenceRow(row);
    this.silences.set(row.id, silence);
    return silence;
  }

  /**
   * ARCH-31: 只清内存态（用于 `DELETE /notification/silences/:id` 的双删——
   * DB 行由 NotificationSilenceService 负责，这里避免重复删库）。
   */
  forgetSilence(id: string): boolean {
    return this.silences.delete(id);
  }

  removeSilence(id: string): boolean {
    // FEAT-01: 内存 + DB 双删（DB 删除失败不阻断内存语义）
    if (this.silenceStore) {
      // ARCH-31: 用 DB 行 id 删库（内存键可能是本地临时 id，在库里查不到）
      const existing = this.silences.get(id);
      const dbId = existing?.dbId ?? id;
      void this.silenceStore.remove(dbId).catch((e) => {
        this.logger.warn(
          `[silences] DB remove failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    }
    return this.silences.delete(id);
  }

  getSilences(): AlertSilence[] {
    return Array.from(this.silences.values());
  }

  cleanExpiredSilences(): number {
    const now = new Date();
    let removedCount = 0;
    // FEAT-01: DB 侧过期行同步清扫（fire-and-forget，失败仅告警）
    if (this.silenceStore) {
      void this.silenceStore.cleanExpired(now).catch((e) => {
        this.logger.warn(
          `[silences] DB cleanup failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    }

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
      // FEAT-10: template variables for channel-level content templates
      vars: {
        task: taskName,
        taskName,
        taskId: taskId ?? null,
        level,
        content: message,
      },
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
    runbook?: string | null,
  ) {
    if (this.isSilenced(taskId, AlertLevel.ERROR)) {
      this.logger.debug(`Failure alert silenced for task ${taskName}`);
      return;
    }

    return this.sendAll({
      title: `Task failed: ${taskName}`,
      content: `Execution ID: ${execId}\nError: ${error}${aiAnalysis ? `\n\nAI Analysis:\n${aiAnalysis}` : ""}${runbook ? `\n\nRunbook:\n${runbook}` : ""}`,
      level: "error",
      // FEAT-10: template variables for channel-level content templates
      vars: {
        task: taskName,
        taskName,
        taskId: taskId ?? null,
        executionId: execId,
        failedReason: error,
        aiAnalysis: aiAnalysis ?? null,
        runbook: runbook ?? null,
        level: "error",
      },
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
      // FEAT-10: template variables for channel-level content templates
      vars: {
        task: taskName,
        taskName,
        taskId: taskId ?? null,
        executionId: execId,
        duration: durationMs,
        level: "info",
      },
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
      // FEAT-10: template variables for channel-level content templates
      vars: {
        task: taskName,
        taskName,
        taskId: taskId ?? null,
        executionId: execId,
        failedReason: `timeout after ${timeoutSec}s`,
        level: "warning",
      },
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
    runbook?: string | null,
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
      return this.notifyFailure(
        taskName,
        execId,
        error,
        aiAnalysis,
        taskId,
        runbook,
      );
    }
    const payload: NotificationPayload = {
      title: `Task failed: ${taskName}`,
      content: `Execution ID: ${execId}\nError: ${error}${aiAnalysis ? `\n\nAI Analysis:\n${aiAnalysis}` : ""}${alarmEmail ? `\nRecipient: ${alarmEmail}` : ""}${runbook ? `\n\nRunbook:\n${runbook}` : ""}`,
      level: "error",
      // FEAT-10: template variables for channel-level content templates
      vars: {
        task: taskName,
        taskName,
        taskId: taskId ?? null,
        executionId: execId,
        failedReason: error,
        aiAnalysis: aiAnalysis ?? null,
        runbook: runbook ?? null,
        level: "error",
      },
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
