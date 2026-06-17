import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as nodemailer from "nodemailer";
import { BaseChannel, NotificationPayload } from "./base.channel";

@Injectable()
export class EmailChannel extends BaseChannel {
  name = "email";
  private logger = new Logger(EmailChannel.name);

  constructor(private config: ConfigService) {
    super();
  }

  async send(p: NotificationPayload) {
    const host = this.config.get<string>("notification.email.host");
    const user = this.config.get<string>("notification.email.user");
    const to = this.config.get<string>("notification.email.to");
    // Q8: skip silently when email is not configured
    if (!host || !user || !to) return;

    const transporter = nodemailer.createTransport({
      host,
      port: this.config.get<number>("notification.email.port") ?? 465,
      secure: this.config.get<boolean>("notification.email.secure") ?? true,
      auth: {
        user,
        pass: this.config.get<string>("notification.email.pass"),
      },
    });

    try {
      await this.withRetry(async () => {
        await transporter.sendMail({
          from: this.config.get<string>("notification.email.from") || user,
          to,
          subject: p.title,
          text: p.content,
        });
      });
      this.logger.log(`[Email] sent: ${p.title} -> ${to}`);
    } catch (error) {
      this.logger.error(`[Email] send failed after retries: ${error.message}`);
    }
  }
}
