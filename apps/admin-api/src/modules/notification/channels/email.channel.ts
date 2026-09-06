import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as nodemailer from "nodemailer";
import {
  BaseChannel,
  ChannelConfigOverride,
  ChannelDeliveryStatus,
  NotificationPayload,
} from "./base.channel";
import { ChannelConfigStore } from "../channel-config.store";

@Injectable()
export class EmailChannel extends BaseChannel {
  name = "email";
  private logger = new Logger(EmailChannel.name);

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
    // R2: per-call override merged over the saved+env resolution. The
    // override never reaches ChannelConfigStore, so concurrent prod
    // alerts can never see unsaved test data and the global send path
    // cannot be silently rerouted by an in-flight test send.
    const saved = this.store.get("email") ?? {};
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

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });

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
      this.logger.error(`[Email] send failed after retries: ${error.message}`);
      return "failed";
    }
  }
}
