import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as nodemailer from "nodemailer";
import {
  BaseChannel,
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

  async send(p: NotificationPayload): Promise<ChannelDeliveryStatus> {
    // V1 (round-7): the SMTP config saved via PATCH /notification/channels/email
    // takes precedence per field; env (EMAIL_*) is only the fallback default.
    // The store holds RAW values (N11 masking applies to the read API only),
    // so the real password reaches the transporter here.
    const saved = this.store.get("email") ?? {};
    const host =
      saved.host || this.config.get<string>("notification.email.host");
    const user =
      saved.user || this.config.get<string>("notification.email.user");
    const to = saved.to || this.config.get<string>("notification.email.to");
    // Q8: skip silently when email is not configured
    if (!host || !user || !to) return "skipped";

    const savedPort = Number(saved.port);
    const port =
      saved.port && !Number.isNaN(savedPort)
        ? savedPort
        : (this.config.get<number>("notification.email.port") ?? 465);
    const secure =
      saved.secure !== undefined && saved.secure !== ""
        ? saved.secure === "true"
        : (this.config.get<boolean>("notification.email.secure") ?? true);
    // The config surface stores the SMTP password under `password`
    // (loadFromEnv / admin-web form); accept `pass` too for symmetry with env.
    const pass =
      saved.password ||
      saved.pass ||
      this.config.get<string>("notification.email.pass");
    const from =
      saved.from || this.config.get<string>("notification.email.from") || user;

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
