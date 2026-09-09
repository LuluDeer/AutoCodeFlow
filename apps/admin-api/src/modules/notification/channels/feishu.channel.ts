import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import * as crypto from "crypto";
import {
  BaseChannel,
  ChannelConfigOverride,
  ChannelDeliveryStatus,
  NotificationPayload,
} from "./base.channel";
import { assertSafeHttpUrl } from "../../../common/utils/safe-http.util";
import { ChannelConfigStore } from "../channel-config.store";

/**
 * NF-05: 飞书（Lark）自定义机器人渠道（open.feishu.cn 自定义机器人 webhook）。
 *
 * - payload 形态：text 消息 `{ msg_type: "text", content: { text } }`，
 *   text = title + 换行 + content（对齐 dingtalk/wecom 的"标题+正文"语义，
 *   飞书 text 消息不支持独立标题字段——故平铺拼接，slack 才有 blocks 面板）。
 * - 可选加签（secret 配置时启用）：飞书官方加签算法——
 *   `string_to_sign = "${timestamp}\n${secret}"`，sign =
 *   base64(HMAC-SHA256，KEY=string_to_sign，空消息体)。签名与 timestamp
 *   随 payload 一起发送（timestamp/sign 顶层字段），1 小时窗口内有效。
 *   secret 未配置时不加签（payload 不带 timestamp/sign 字段）——机器人
 *   侧未开启加签校验时两种形态均可送达。
 * - URL 保守声明为 https：飞书自定义机器人官方端点是 open.feishu.cn 的
 *   https 地址；assertSafeHttpUrl 同时做 scheme + SSRF 双校验。
 *   （SSRF 守卫面与 webhook/dingtalk/wecom/slack 渠道完全同源——
 *   assertSafeHttpUrl 首跳校验 + maxRedirects:0 拒绝改道。）
 */
@Injectable()
export class FeishuChannel extends BaseChannel {
  name = "feishu";
  private logger = new Logger(FeishuChannel.name);

  constructor(
    private config: ConfigService,
    private store: ChannelConfigStore,
  ) {
    super();
  }

  /**
   * 飞书加签：官方算法是「以 string_to_sign 本身作为 HMAC key、消息体为空」
   * （与常见 `HMAC(secret, msg)` 习惯相反，参照
   * https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot 侧
   * 示例实现）。secret 未配置返回 undefined——调用方省略这两个字段。
   */
  private buildSignature(
    secret: string,
  ): { timestamp: string; sign: string } | undefined {
    if (!secret) return undefined;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const hmac = crypto
      .createHmac("sha256", `${timestamp}\n${secret}`)
      .update("") // 飞书官方约定：消息体为空，key=string_to_sign
      .digest();
    return { timestamp, sign: hmac.toString("base64") };
  }

  async send(
    p: NotificationPayload,
    configOverride?: ChannelConfigOverride,
  ): Promise<ChannelDeliveryStatus> {
    // R2: override merged over saved (override wins). Never publishes to
    // the global store — concurrent prod alerts can never see test data.
    const saved = this.store.get("feishu") ?? {};
    const override = configOverride ?? {};
    const url =
      override.webhookUrl ||
      saved.webhookUrl ||
      this.config.get<string>("notification.feishuWebhook");
    if (!url) return "skipped";

    // F-3: SSRF chokepoint (NOTIF-001), fail-open like WebhookChannel /
    // dingtalk / wecom / slack. V2: report the block instead of swallowing.
    try {
      await assertSafeHttpUrl(url);
    } catch (err: unknown) {
      this.logger.warn(
        `[Feishu] SSRF-blocked URL ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return "blocked";
    }

    // 可选加签 secret：override > saved > env（与 URL 同一解析链）。
    const secret =
      override.secret ||
      saved.secret ||
      this.config.get<string>("notification.feishuSecret") ||
      "";
    const signed = this.signSafely(secret, url);

    try {
      await this.withRetry(async () => {
        await axios.post(
          url,
          {
            ...(signed ?? {}),
            msg_type: "text",
            content: { text: `${p.title}\n${p.content}` },
          },
          // R3: maxRedirects=0 — refuse 3xx so the assertSafeHttpUrl
          // check on the first hop is the only check applied.
          { timeout: 10_000, maxRedirects: 0 },
        );
      });
      this.logger.log(`[Feishu] sent: ${p.title}`);
      return "sent";
    } catch (error) {
      this.logger.error(`[Feishu] send failed after retries: ${error.message}`);
      return "failed";
    }
  }

  /**
   * 加签失败（如 secret 含非法字符被 crypto 拒绝）fail-open 为不加签发送，
   * 与渠道整体 fail-open 姿态一致——缺签 Robot 可能拒收（返回 error 码），
   * 此时走 withRetry → "failed"，主链不受影响；warn 提示配置者修正。
   */
  private signSafely(secret: string, url: string) {
    try {
      return this.buildSignature(secret);
    } catch (err: unknown) {
      this.logger.warn(
        `[Feishu] sign failed for ${url} — falling back to unsigned mode: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }
}
