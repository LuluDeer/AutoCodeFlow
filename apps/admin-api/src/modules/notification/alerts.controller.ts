import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Headers,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiExcludeEndpoint } from "@nestjs/swagger";
import { Request } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { ConfigService } from "@nestjs/config";
import { Public } from "../../common/decorators/public.decorator";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Task } from "../task/entities/task.entity";
import { NotificationService } from "./notification.service";
import { NotificationPayload } from "./channels/base.channel";
import {
  AlertmanagerWebhookPayload,
  mapAlertmanagerPayload,
} from "./alert-webhook.mapping";

/**
 * OBS-02: Alertmanager webhook 入站路由——把 Grafana/Alertmanager 的告警
 * 接入平台既有通知渠道（企业微信/钉钉/Slack/邮件），打通"告警通知与平台
 * 通知渠道割裂"的缺口（计划书 §4 主题 B）。
 *
 * 安全姿态（复用 applications 发版 webhook 的 rawBody+HMAC 先例）：
 * - @Public 无 JWT——机器对机器调用方（Alertmanager）不持用户凭证；
 * - HMAC-SHA256 over `${timestamp}.${rawBody}`，header 携带时间戳+签名
 *   （X-AutoCodeFlow-Timestamp / X-Hub-Signature-256，与 applications 一致）；
 * - secret 走 env ALERT_WEBHOOK_SECRET；**未配置时端点 503 拒绝**（安全
 *   缺省：绝不退化为无鉴权接收，否则公网可路由的 /api/alerts/webhook 会
 *   变成告警伪造入口——伪造告警可污染值班渠道甚至诱发误操作）；
 * - 时间戳 ±5 分钟窗 + 常数时间比较，防重放/防时序侧信道，与 applications
 *   同参数。
 *
 * 失败语义：HMAC 校验失败统一 401（消息与 applications 对齐，不泄露具体
 * 原因）；外发失败 fail-open（返回 502 + 投递结果明细，绝不让 Alertmanager
 * 的重试风暴放大为 API 故障——notifications 的 fan-out 层已保证单渠道
 * 失败不抛出）。
 */
@Controller("alerts")
export class AlertsController {
  private logger = new Logger(AlertsController.name);

  constructor(
    private notificationService: NotificationService,
    private configService: ConfigService,
    // FEAT-11: labels.taskId 命中时查 tasks.runbook——只读复用既有实体，
    // 零迁移。Task 实体已在 TypeORM 全局实体扫描内（entities glob），本模块
    // 无需 forFeature 也拿得到仓储；显式注入以保证测试可替换。
    @InjectRepository(Task)
    private taskRepo: Repository<Task>,
  ) {}

  /** HMAC secret 未配置 → 503（安全缺省，见类注释）。 */
  private resolveSecret(): string {
    const secret = this.configService.get<string>("alert.webhookSecret") ?? "";
    if (!secret) {
      this.logger.error(
        "ALERT_WEBHOOK_SECRET is not configured — rejecting alert webhook (secure default)",
      );
      throw new ServiceUnavailableException(
        "Alert webhook is disabled: ALERT_WEBHOOK_SECRET is not configured",
      );
    }
    return secret;
  }

  /**
   * 统一 HMAC 校验（算法/窗口/常数时间比较与 applications webhook 先例
   * 逐参数一致）。失败统一 401，具体原因只进日志。
   */
  private verifySignature(
    rawBody: Buffer | undefined,
    signature: string | undefined,
    timestamp: string | undefined,
    secret: string,
  ): void {
    const authFail = () =>
      new UnauthorizedException("Alert webhook authentication failed");

    if (!signature || !timestamp) {
      this.logger.warn(
        `Alert webhook: missing signature/timestamp header (${!signature ? "no signature" : "no timestamp"})`,
      );
      throw authFail();
    }
    const timestampMs = Number(timestamp);
    if (
      !Number.isFinite(timestampMs) ||
      Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000
    ) {
      this.logger.warn("Alert webhook: stale or invalid timestamp");
      throw authFail();
    }
    if (!rawBody) {
      this.logger.warn("Alert webhook: raw request body is unavailable");
      throw authFail();
    }
    const expected =
      "sha256=" +
      createHmac("sha256", secret)
        .update(Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]))
        .digest("hex");
    const expectedBuf = Buffer.from(expected);
    const receivedBuf = Buffer.from(signature);
    const valid =
      expectedBuf.length === receivedBuf.length &&
      timingSafeEqual(expectedBuf, receivedBuf);
    if (!valid) {
      this.logger.warn("Alert webhook: invalid signature");
      throw authFail();
    }
  }

  /**
   * POST /api/alerts/webhook — Alertmanager v2 webhook receiver。
   *
   * body 为 Alertmanager v2 JSON（alerts[] 带 status/labels/annotations/
   * startsAt）。映射为单条通知（多条告警合并）后走
   * notificationService.sendToChannels 全渠道扇出（渠道配置复用系统既有
   * 通知渠道，不新建渠道类型）。firing → level=error，全 resolved → info。
   */
  @Public()
  @Post("webhook")
  @ApiExcludeEndpoint()
  async webhook(
    @Body() payload: AlertmanagerWebhookPayload,
    @Headers("x-hub-signature-256") signature?: string,
    @Headers("x-autocodeflow-timestamp") timestamp?: string,
    @Req() req?: Request & { rawBody?: Buffer },
  ) {
    const secret = this.resolveSecret();
    this.verifySignature(req?.rawBody, signature, timestamp, secret);

    // labels.taskId 命中 → 查 tasks.runbook（含软删行也无所谓——runbook
    // 只是知识文本；findOne 默认排除软删，保持同一语义）。
    // 先做一次无 runbook 的试映射以拿到 taskId（映射是纯函数，重复调用
    // 成本可忽略），再带上 runbook 做最终映射。
    const probe = mapAlertmanagerPayload(payload);
    if (!probe) {
      throw new BadRequestException(
        "Alertmanager payload has no alerts array (or it is empty)",
      );
    }
    let taskRunbook: string | null = null;
    if (probe.taskId) {
      try {
        const task = await this.taskRepo.findOne({
          where: { id: probe.taskId },
        });
        taskRunbook = task?.runbook ?? null;
      } catch (e) {
        // runbook 拼接是增强而非依赖——查询失败降级为无 runbook 段，
        // 不阻断告警外发（fail-open）。
        this.logger.warn(
          `Alert webhook: failed to load runbook for task ${probe.taskId}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    const mapped = mapAlertmanagerPayload(payload, { taskRunbook });
    if (!mapped) {
      // 理论不可达（probe 已挡空数组），防御性兜底保持类型收窄。
      throw new BadRequestException("Alertmanager payload mapped to nothing");
    }

    const notificationPayload: NotificationPayload = {
      title: mapped.title,
      content: mapped.content,
      level: mapped.level,
    };

    this.logger.log(
      `Alert webhook: ${mapped.alertCount} alert(s), status=${mapped.level === "error" ? "firing" : "resolved"}, taskId=${probe.taskId ?? "n/a"} — fanning out to notification channels`,
    );
    const results = await this.notificationService.sendAll(notificationPayload);

    // 通知渠道全 skipped（一个渠道都没配置）——告警没人收到，按失败报
    // （502 让 Alertmanager 重试），但仍返回明细供排障。
    const delivered = Object.values(results).filter(
      (s) => s === "sent",
    ).length;
    if (delivered === 0) {
      this.logger.error(
        `Alert webhook: notification delivered to 0 channels: ${JSON.stringify(results)}`,
      );
      throw new BadGatewayException({
        message: "Alert received but not delivered to any notification channel",
        results,
      });
    }

    return { ok: true, delivered, results };
  }
}
