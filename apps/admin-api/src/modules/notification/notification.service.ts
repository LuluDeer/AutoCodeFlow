import {
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
// A-1: 「全部渠道失败」的 NOTIFICATION_FAILED 审计兜底（渠道自身把异常吞成
// "failed" 返回值，listener 的抛错兜底永远看不到渠道级故障——见 sendToChannels）。
// @Optional 先例同 silenceStore：存量测试模块未装配 AuditModule 时降级为仅日志。
import { AuditService } from "../audit/audit.service";
// A-5: 出站正文脱敏（与 ai.service sanitizeLogs 同源正则，见 util 头注）
import { sanitizeNotificationText } from "./sanitize-notification-text.util";
// LANG-ERR-01: 用户可见报错改为稳定错误码（文案由前端按用户语言渲染）。
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";

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

/**
 * R33-A1: `autoflow_notification_delivery_total` 的 result 标签值域。
 *
 * 为什么不是 {success, failure} 二值：渠道有四种**语义不同**的投递结局，
 * 把它们折叠成二值会让看板/告警说出错误的话——
 *  - success  — 渠道真的投出去了（"sent"；以及 mock/legacy 渠道返回 undefined
 *               的历史契约，见下方 sendToChannels 的 `?? "sent"`）；
 *  - failure  — 传输/API 故障（渠道自报 "failed"，或 promise rejected）；
 *  - blocked  — 被 SSRF 策略拦截（assertSafeHttpUrl 拒绝）：一种**策略决定**，
 *               不是传输故障，也不代表目标不可达；
 *  - skipped  — 渠道未配置（无 URL/凭据，零次尝试）：既不是投递成功，也不是
 *               投递失败，把它计入 failure 会伪造出一条渠道故障。
 *
 * 加性变更：success / failure 两个老值语义不变（仅口径变严——self-reported
 * 'failed' 从 success 迁出，见 R33-A1 报告），blocked / skipped 是新增 series，
 * 老看板与告警规则里的 `result="failure"` 表达式无需改动即可继续工作。
 */
export type DeliveryMetricResult =
  "success" | "failure" | "blocked" | "skipped";

/**
 * R33-A1: 把一次逐渠道投递结局映射成指标 result label。
 *
 * 这曾是缺陷所在：旧实现用 `result.status === "rejected" ? "failure" : "success"`
 * 直接判 promise 状态，完全绕过了渠道自报的 ChannelDeliveryStatus。生产常态恰恰
 * 是渠道把传输失败吞成返回值 'failed'（重试耗尽，见各 channel.send 的 catch），
 * 于是「没投出去」被 100% 记成 success，看板与告警系统性低估投递失败。
 * 单一事实来源必须是 delivery status 本身（与同函数 A-1 审计兜底、DTO 口径一致）。
 */
export function mapDeliveryResultLabel(
  status: ChannelDeliveryStatus,
): DeliveryMetricResult {
  switch (status) {
    case "failed":
      return "failure";
    case "blocked":
      return "blocked";
    case "skipped":
      return "skipped";
    case "sent":
    default:
      return "success";
  }
}

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
    // A-1: 渠道级故障的审计兜底（sendToChannels 全失败时落证）。@Optional
    // 同上——NotificationModule 生产装配 imports AuditModule，存量测试模块
    // 未提供时审计整体旁路（仅日志+指标，既有行为）。
    @Optional()
    @Inject(AuditService)
    private readonly auditService?: AuditService,
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
    // A-5: 出站脱敏单一收口点——errorSummary/日志原文里的 env 赋值、Bearer
    // token、长 hex/base64 密钥进 IM/邮件前掩码（模板渲染副本在
    // applyChannelTemplates 内同款处理）；普通文本逐字保留。
    const base = this.sanitizeOutbound(payload);
    const rendered = this.applyChannelTemplates(base, channels);

    const entries: Array<{
      name: string;
      promise: Promise<ChannelDeliveryStatus | void>;
    }> = [];
    if (channels.includes(AlertChannel.EMAIL))
      entries.push({
        name: "email",
        promise: this.email.send(rendered.email ?? base),
      });
    if (channels.includes(AlertChannel.SLACK))
      entries.push({
        name: "slack",
        promise: this.slack.send(rendered.slack ?? base),
      });
    if (channels.includes(AlertChannel.DINGTALK))
      entries.push({
        name: "dingtalk",
        promise: this.dingtalk.send(rendered.dingtalk ?? base),
      });
    if (channels.includes(AlertChannel.WECOM))
      entries.push({
        name: "wecom",
        promise: this.wecom.send(rendered.wecom ?? base),
      });
    if (channels.includes(AlertChannel.WEBHOOK))
      entries.push({
        name: "webhook",
        promise: this.webhook.send(rendered.webhook ?? base, webhookUrl),
      });
    // NF-05: 飞书渠道扇出（与既有五渠道同语义——rendered 优先，缺省原 payload）
    if (channels.includes(AlertChannel.FEISHU))
      entries.push({
        name: "feishu",
        promise: this.feishu.send(rendered.feishu ?? base),
      });

    // R150-A1（出站面审计 · 轴2）：未注册渠道名 = 告警静默消失。
    //
    // 现场：`Task.alarmChannels` 是**自由字符串数组**（task DTO 只挂 @IsArray，
    // 没有 @IsIn(Object.values(AlertChannel))），到这里的两个入口
    // （notifyFailureWithConfig / notifyTimeout）把它小写后直接 `as AlertChannel[]`
    // 强转，然后靠上面六条 `if` 逐个匹配。一个名字都匹配不上时 entries 为空：
    // 零投递（对）、零日志（错）、零指标（错），而且下方「全部渠道失败落审计」
    // 的判据是 `entries.length > 0 && ...`——空扇出恰好绕过它。结果是该任务的
    // 每一次失败告警都不留任何痕迹地消失：看板没有 failure series、审计没有
    // NOTIFICATION_FAILED 行、日志一行 warn 都没有，运维无从知道告警没发出去。
    //
    // 处置：路由错配必须在日志与审计上留证。部分名字无效不发审计（有渠道真的
    // 投出去了，fail-open 语义与"不放大审计噪声"不变）。
    const knownChannels = new Set<string>(Object.values(AlertChannel));
    const unknownChannels = channels.filter((c) => !knownChannels.has(c));
    if (unknownChannels.length > 0) {
      this.logger.warn(
        `[sendToChannels] ignoring unregistered channel name(s): ${unknownChannels.join(", ")} (known: ${[...knownChannels].join(", ")}) — ${entries.length} channel(s) actually attempted`,
      );
    }

    const results = await Promise.allSettled(entries.map((e) => e.promise));
    // V2 (round-7): surface the per-channel outcome to the caller. Rejected
    // promises stay "failed"; fulfilled ones carry the channel's own status
    // (mocked/legacy channels returning undefined count as "sent").
    const delivery: ChannelDeliveryResults = {};
    const failures: string[] = [];
    results.forEach((result, i) => {
      const name = entries[i].name;
      // R33-A1: 先把「这次投递的真实结局」算成一个 ChannelDeliveryStatus，
      // 再让指标、日志、返回值、审计全部读同一个值——单一事实来源。
      // 旧实现反过来：指标直接看 promise 状态（非 rejected 即 success），
      // 于是渠道自报的 'failed'/'blocked'/'skipped' 全被记成 success，
      // 与下方返回值和 A-1 审计兜底（按 'failed' 判未投递）自相矛盾。
      const status: ChannelDeliveryStatus =
        result.status === "rejected"
          ? "failed"
          : ((result.value ?? "sent") as ChannelDeliveryStatus);
      // 可观测性补齐：per-channel 投递结果计数。fail-open 语义不变：
      // 只记计数，不影响返回值与控制流。
      recordRuntime("autoflow_notification_delivery_total", {
        channel: name,
        result: mapDeliveryResultLabel(status),
      });
      delivery[name] = status;
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
      } else if (status === "blocked") {
        this.logger.warn(
          `${name} notification blocked by SSRF guard — see channel log for the URL`,
        );
      }
    });

    if (failures.length > 0) {
      this.logger.warn(
        `Notification failed on channel(s): ${failures.join("; ")} — continuing without interrupting main flow`,
      );
    }

    // A-1: 「全部请求渠道都失败」时补 NOTIFICATION_FAILED 审计。渠道把异常
    // 吞成 "failed" 返回值（wecom/dingtalk/slack/email 同型），此前只记日志
    // +指标；listener 的 NOTIFICATION_FAILED 兜底只在 notify 链路**抛错**时
    // 触发——渠道级故障（重试 3 次退避耗尽）永不落审计，告警静默丢失后运维
    // 在审计面零痕迹可查。部分失败仍只走日志+指标（既有 fail-open 语义不变，
    // 不放大审计噪声）。审计写失败自身 try/catch——兜底路径绝不允许二次炸
    // 主链。不做死信表：重放依赖审计行 + 人工/上游重触发（记录在本注释）。
    // R32-A2: 判据必须是**逐渠道投递结果**，不是 promise 有没有 reject。
    // 真实渠道把传输失败吞成 status='failed'（见上方 failures.push 只在
    // rejected 分支——即本兜底此前只在"渠道实现违反了 fail-open 契约、真的
    // 抛错"时才触发），于是 A-1 声称消灭的盲区在生产原样存在：全部渠道
    // status='failed' 时一条审计都没有。这里按结果判定：
    //   · 全部请求渠道都是 'failed' → 落审计（无论它来自 reject 还是返回值）；
    //   · 'blocked' 是策略结果、'skipped' 是未配置，均不算投递故障（既有
    //     spec 已钉住 blocked/skipped 不落审计），部分失败仍只走日志+指标，
    //     不放大审计噪声。
    const failedEverywhere =
      entries.length > 0 && entries.every((e) => delivery[e.name] === "failed");
    // R150-A1：`entries.length === 0 && channels.length > 0` = 请求了渠道但一个
    // 都没路由上（名字未注册）。它不是"没有渠道要发"（channels 为空），而是
    // "以为发了、其实一条都没发"——与 failedEverywhere 同等严重，必须落审计。
    const routedNothing = entries.length === 0 && channels.length > 0;
    if (failedEverywhere || routedNothing) {
      try {
        await this.auditService?.log({
          action: "NOTIFICATION_FAILED",
          resource: "notification_fanout",
          detail: {
            title: base.title,
            level: base.level,
            channels: entries.map((e) => e.name),
            // R150-A1: 请求侧原样留证——路由错配时 channels 为空、只有这里能
            // 看出"调用方到底要求发给谁"。
            requestedChannels: channels,
            ...(unknownChannels.length > 0 ? { unknownChannels } : {}),
            results: delivery,
            // rejection 的异常文本更具体；纯 status='failed' 的渠道没有异常
            // 可摘，据实写明"渠道自报 failed"，不让审计里出现空数组。
            // 零路由时 entries 为空，改按请求的渠道名逐条写明原因。
            failures:
              failures.length > 0
                ? failures
                : entries.length > 0
                  ? entries.map(
                      (e) =>
                        `${e.name}: delivery failed (channel reported 'failed')`,
                    )
                  : channels.map(
                      (c) => `${c}: unregistered channel name — not routed`,
                    ),
          },
        });
      } catch {
        /* audit is best-effort */
      }
    }
    return delivery;
  }

  /**
   * A-5: 出站载荷脱敏（title/content 同源掩码，vars 不出站无需处理）。
   * sendToChannels 与 applyChannelTemplates 的渲染副本统一走这里。
   */
  private sanitizeOutbound(p: NotificationPayload): NotificationPayload {
    return {
      ...p,
      title: sanitizeNotificationText(p.title),
      content: sanitizeNotificationText(p.content),
    };
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
          // A-5: 模板渲染副本同样出站脱敏（{{content}} 等变量可能夹带日志原文）
          next.title = sanitizeNotificationText(
            renderTemplate(config!.titleTemplate, payload.vars),
          );
        }
        if (config!.contentTemplate) {
          next.content = sanitizeNotificationText(
            renderTemplate(config!.contentTemplate, payload.vars),
          );
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

  /**
   * NETOPT-5①: isSilenced 现按 scope 判定匹配范围。
   *
   * 此前匹配只看 taskId+level+时间窗，完全忽略 scope/applicationId——
   * scope=application（无 taskId）的规则因 `!silence.taskId` 恒真而匹配
   * 一切任务的通知，等于「应用级静默 = 全平台消音」，方向是吞告警（最危险）。
   * 现语义：
   * - scope=task → 仅匹配该 taskId；
   * - scope=application → 仅匹配 applicationId 等于该规则 applicationId 的
   *   任务通知（无 applicationId 上下文的通知，如 executor 上下线拨测，
   *   不属于任何应用，不匹配——静默缺证时放行告警，fail-open）；
   * - scope=global / 未标记 scope 的存量内存规则 → 沿用既有字段回退语义
   *   （设了 taskId 按任务匹配，否则全局），存量行为零漂移。
   *
   * channelType 有意不参与判定：本方法在渠道扇出前同步调用，届时无法知道
   * 各渠道的投递结果，按渠道裁剪属于造假实现。channelType 仅作范围记录
   * （与 admin-web NotificationSettingsPage 的「scope=task/application 均以
   * taskId 判定，channelType 仅作范围记录」注释一致），见实体注释。
   */
  isSilenced(
    taskId?: string,
    level?: AlertLevel,
    applicationId?: string,
  ): boolean {
    const now = new Date();

    for (const silence of this.silences.values()) {
      let matchesScope: boolean;
      if (silence.scope === "application") {
        matchesScope =
          !!silence.applicationId && applicationId === silence.applicationId;
      } else if (silence.scope === "task") {
        matchesScope = !!silence.taskId && silence.taskId === taskId;
      } else {
        // global（含存量未标记 scope 的内存规则）
        matchesScope = !silence.taskId || silence.taskId === taskId;
      }
      const matchesLevel = !silence.level || silence.level === level;

      const isActive =
        (!silence.startTime || silence.startTime <= now) &&
        (!silence.endTime || silence.endTime >= now);

      if (matchesScope && matchesLevel && isActive) {
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
      throw new AppError(ErrorCode.NOTIFICATION_SILENCE_TOO_MANY, {
        max: MAX_ALERT_SILENCES,
      });
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
    // NETOPT-5①: 应用上下文透传，供 scope=application 静默判定
    applicationId?: string,
  ) {
    if (this.isSilenced(taskId, level, applicationId)) {
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
    // NETOPT-5①: 应用上下文透传，供 scope=application 静默判定
    applicationId?: string,
  ) {
    if (this.isSilenced(taskId, AlertLevel.ERROR, applicationId)) {
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
    // NETOPT-5①: 应用上下文透传，供 scope=application 静默判定
    applicationId?: string,
  ) {
    if (this.isSilenced(taskId, AlertLevel.INFO, applicationId)) {
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
    // NETOPT-5①: 应用上下文透传，供 scope=application 静默判定
    applicationId?: string,
    // A-11: 任务级告警渠道路由（与失败告警 notifyFailureWithConfig 同源）。
    // 此前恒 sendAll 全渠道——配置了 alarmChannels 的任务超时时预警仍广播到
    // 全局所有渠道，与失败告警的按任务路由不一致。缺省/空数组回落 sendAll
    // （存量行为零漂移）。
    alarmChannels?: string[],
  ) {
    if (this.isSilenced(taskId, AlertLevel.WARNING, applicationId)) {
      this.logger.debug(`Timeout alert silenced for task ${taskName}`);
      return;
    }

    const payload: NotificationPayload = {
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
    };

    if (alarmChannels && alarmChannels.length > 0) {
      return this.sendToChannels(
        payload,
        alarmChannels.map((c) => c.toLowerCase()) as AlertChannel[],
      );
    }
    return this.sendAll(payload);
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
    // NETOPT-5①: 应用上下文透传（调用方 execution-events.listener 已持有
    // Task 实体，applicationId 可直接带来），供 scope=application 静默判定
    applicationId?: string,
    // DEEP-AUDIT B·1.6: 汇总标题覆写（通知聚合窗到期时调用方传「任务失败
    // 汇总」类标题，替代单次失败的 "Task failed:"）。缺省 undefined 时
    // 标题与既有行为逐字节一致，存量调用方零影响。
    titleOverride?: string,
  ) {
    const taskChannels =
      (alarmChannels?.map((c) => c.toLowerCase()) as AlertChannel[]) || [];

    // 补传 taskId：修复原先 isSilenced(undefined,...) 使任务级静默窗口对本路径
    // 失效的问题，与 notifyFailure 保持一致（taskId 缺省时行为不变）。
    if (this.isSilenced(taskId, AlertLevel.ERROR, applicationId)) {
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
        applicationId,
      );
    }
    const payload: NotificationPayload = {
      title: titleOverride ?? `Task failed: ${taskName}`,
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
      throw new AppError(ErrorCode.NOTIFICATION_WEBHOOK_BLOCKED, { url });
    }
    return status;
  }
}
