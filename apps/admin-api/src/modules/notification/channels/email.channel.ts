import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as nodemailer from "nodemailer";
import { createHash } from "node:crypto";
import {
  BaseChannel,
  // R150-A1（轴2）：失败原因分类（仅进日志，不改状态契约）
  classifyDeliveryFailure,
  ChannelConfigOverride,
  ChannelDeliveryStatus,
  NotificationPayload,
} from "./base.channel";
import { ChannelConfigStore } from "../channel-config.store";

@Injectable()
export class EmailChannel extends BaseChannel implements OnModuleDestroy {
  name = "email";
  private logger = new Logger(EmailChannel.name);

  /**
   * SMTP 连接池缓存：key = 连接配置的稳定 SHA256（不含收件人/邮件正文），
   * value = pool:true 的 transporter。同一配置反复发信复用同一池，避免每封
   * 告警都新建 TCP+TLS+登录；配置变化（host/port/secure/auth/from）时按新
   * hash 建池并关闭旧池。from 只影响邮件信封，不参与连接身份，故不进 key。
   */
  private readonly transporterCache = new Map<
    string,
    nodemailer.Transporter
  >();

  constructor(
    private config: ConfigService,
    private store: ChannelConfigStore,
  ) {
    super();
  }

  /** 关闭一个池：真实 transporter 有 close，测试替身可能只提供 sendMail。 */
  private closeTransporter(transporter: nodemailer.Transporter): void {
    try {
      if (typeof transporter.close === "function") transporter.close();
    } catch (err) {
      this.logger.warn(
        `[Email] 关闭连接池失败（忽略）: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  onModuleDestroy(): void {
    for (const transporter of this.transporterCache.values()) {
      this.closeTransporter(transporter);
    }
    this.transporterCache.clear();
  }

  /**
   * 连接配置的稳定指纹：字段顺序固定，SHA256 十六进制。凭据明文只进哈希，
   * 不进日志；相同配置（含密码轮换前后）产生不同 key ⇒ 旧池被关闭。
   */
  private configFingerprint(opts: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string | undefined;
  }): string {
    const canonical = JSON.stringify([
      opts.host,
      opts.port,
      opts.secure,
      opts.user,
      opts.pass ?? "",
    ]);
    return createHash("sha256").update(canonical).digest("hex");
  }

  /** 取（或按新配置重建）连接池；配置指纹变化时关闭并移除旧池。 */
  private getTransporter(opts: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string | undefined;
  }): nodemailer.Transporter {
    const key = this.configFingerprint(opts);
    const cached = this.transporterCache.get(key);
    if (cached) return cached;

    for (const [oldKey, old] of this.transporterCache) {
      this.transporterCache.delete(oldKey);
      this.closeTransporter(old);
    }

    const transporter = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.secure,
      auth: { user: opts.user, pass: opts.pass },
      // 进程内复用：多封告警共享同一组 SMTP 连接，配置变更时由上方关闭。
      pool: true,
    });
    this.transporterCache.set(key, transporter);
    return transporter;
  }

  async send(
    p: NotificationPayload,
    configOverride?: ChannelConfigOverride,
  ): Promise<ChannelDeliveryStatus> {
    // R2: per-call override merged over the saved+env resolution. The
    // override never reaches ChannelConfigStore, so concurrent prod
    // alerts can never see unsaved test data and the global send path
    // cannot be silently rerouted by an in-flight test send.
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
    const saved = this.store.isEnabled("email")
      ? (this.store.get("email") ?? {})
      : {};
    const override = configOverride ?? {};
    const host =
      override.host ||
      saved.host ||
      this.config.get<string>("notification.email.host");
    const user =
      override.user ||
      saved.user ||
      this.config.get<string>("notification.email.user");
    const to =
      override.to ||
      saved.to ||
      this.config.get<string>("notification.email.to");
    // Q8: skip silently when email is not configured
    if (!host || !user || !to) return "skipped";

    const portSrc = override.port ?? saved.port;
    const savedPort = Number(portSrc);
    const port =
      portSrc && !Number.isNaN(savedPort)
        ? savedPort
        : (this.config.get<number>("notification.email.port") ?? 465);
    const secureSrc = override.secure ?? saved.secure;
    const secure =
      secureSrc !== undefined && secureSrc !== ""
        ? secureSrc === "true"
        : (this.config.get<boolean>("notification.email.secure") ?? true);
    // The config surface stores the SMTP password under `password`
    // (loadFromEnv / admin-web form); accept `pass` too for symmetry with env.
    // R2 + N11: the override may legitimately be a masked echo ("***");
    // when it is, fall through to the saved/env value instead of clobbering
    // the real secret with the sentinel.
    const overrideMasked =
      typeof override.password === "string" && override.password === "***";
    const pass =
      (!overrideMasked && override.password) ||
      (!overrideMasked && override.pass) ||
      saved.password ||
      saved.pass ||
      this.config.get<string>("notification.email.pass");
    const from =
      override.from ||
      saved.from ||
      this.config.get<string>("notification.email.from") ||
      user;

    const transporter = this.getTransporter({ host, port, secure, user, pass });

    try {
      await this.withRetry(async () => {
        await transporter.sendMail({
          from,
          to,
          subject: p.title,
          text: p.content,
        });
      });
      this.logger.log(`[Email] sent: ${p.title} -> ${to}`);
      return "sent";
    } catch (error) {
      // R150-A1（轴2）：括号里是失败原因分类（http_4xx/http_5xx/3xx/timeout/
      // network/unknown）——状态契约仍是 "failed"，但日志必须能区分"该改配置"
      // 与"该等对端恢复"与"该查链路"。
      this.logger.error(
        `[Email] send failed after retries (${classifyDeliveryFailure(error)}): ${error instanceof Error ? error.message : String(error)}`,
      );
      return "failed";
    }
  }
}
