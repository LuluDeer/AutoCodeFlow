import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import {
  BaseChannel,
  // R150-A1（轴2）：失败原因分类（仅进日志，不改状态契约）
  classifyDeliveryFailure,
  ChannelConfigOverride,
  ChannelDeliveryStatus,
  NotificationPayload,
} from "./base.channel";
import {
  assertAndPinHttpUrl,
  PinnedHttpTarget,
  pinnedAxiosConfig,
} from "../../../common/utils/safe-http.util";
import { ChannelConfigStore } from "../channel-config.store";
// A-6: markdown 注入防护（title/content 剥离链接语法字符后再拼 markdown）
import { escapeMarkdownText } from "./markdown-escape.util";
import { redactUrlForLog } from "./log-safe-url.util";

@Injectable()
export class WecomChannel extends BaseChannel {
  name = "wecom";
  private logger = new Logger(WecomChannel.name);

  constructor(
    private config: ConfigService,
    private store: ChannelConfigStore,
  ) {
    super();
  }

  async send(
    p: NotificationPayload,
    configOverride?: ChannelConfigOverride,
  ): Promise<ChannelDeliveryStatus> {
    // R2: override merged over saved (override wins). Never publishes to
    // the global store — concurrent prod alerts can never see test data.
    // R150-A1（轴3）: 与 WebhookChannel 同款 enabled 闸。ChannelConfigStore 的
    // 契约头注写着「a disabled channel's config must not take effect」，管理台
    // 开关也确实 PATCH { enabled:false } 并 toast 成功——但此前全模块只有
    // webhook 一处读过 isEnabled，其余五个渠道无视开关继续用已保存配置投递：
    // 用户点「关闭此渠道」、界面报成功、告警照发。
    //
    // 只闸**已保存配置**这一层：env 兜底（SLACK_WEBHOOK 等）是部署态配置而不是
    // 管理台开关，一并闸掉会让"只配 env"的部署在启动瞬间静默失联
    // （loadFromEnv 把各渠道的 enabled 默认发布成 false）。
    // isEnabled 对"从未发布过开关"的 fixture 返回 true（`?? true`），既有
    // 直接 seed 配置的测试语义不变。
    const saved = this.store.isEnabled("wecom")
      ? (this.store.get("wecom") ?? {})
      : {};
    const override = configOverride ?? {};
    const url =
      override.webhookUrl ||
      saved.webhookUrl ||
      this.config.get<string>("notification.wecomWebhook");
    if (!url) return "skipped";

    // F-3: SSRF chokepoint (NOTIF-001) + DNS pinning (SEC-NEW): rewrite the
    // target to the validated IP so a rebinding host can't swap the address
    // between validation and connection. Fail-open like WebhookChannel.
    // V2: report the block instead of swallowing it silently.
    let pinned: PinnedHttpTarget;
    try {
      pinned = await assertAndPinHttpUrl(url, {
        allowPrivateNetwork:
          this.config.get<boolean>("notification.allowPrivateNetwork") === true,
      });
    } catch (err: unknown) {
      this.logger.warn(
        `[Wecom] SSRF-blocked URL ${redactUrlForLog(url)}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return "blocked";
    }

    try {
      await this.withRetry(async () => {
        const pinCfg = pinnedAxiosConfig(pinned);
        // 原始 URL 原样（new URL 归一化会加尾部斜杠）；pin 由 agent.lookup 完成。
        await axios.post(
          url,
          {
            msgtype: "markdown",
            // A-6: title/content 先剥离 [ ] ( ) < > 与控制字符，防注入钓鱼链接
            markdown: {
              content: `## ${escapeMarkdownText(p.title)}\n${escapeMarkdownText(p.content)}`,
            },
          },
          // R3: maxRedirects=0 — refuse 3xx so the validated first hop
          // is the only hop applied.
          {
            timeout: 10_000,
            maxRedirects: 0,
            ...pinCfg,
          },
        );
      });
      this.logger.log(`[Wecom] sent: ${p.title}`);
      return "sent";
    } catch (error) {
      // R150-A1（轴2）：括号里是失败原因分类（http_4xx/http_5xx/3xx/timeout/
      // network/unknown）——状态契约仍是 "failed"，但日志必须能区分"该改配置"
      // 与"该等对端恢复"与"该查链路"。
      this.logger.error(
        `[Wecom] send failed after retries (${classifyDeliveryFailure(error)}): ${error instanceof Error ? error.message : String(error)}`,
      );
      return "failed";
    }
  }
}
