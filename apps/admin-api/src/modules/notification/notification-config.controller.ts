import {
  Controller,
  Get,
  Patch,
  Post,
  Body,
  Param,
  UseGuards,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { UserRole } from "../users/entities/user.entity";
import { NotificationConfigService } from "./notification-config.service";
import {
  AlertChannel,
  AlertLevel,
  NotificationService,
} from "./notification.service";
import {
  SendNotificationDto,
  SendNotificationResultDto,
} from "./dto/send-notification.dto";
import { NotificationPayload } from "./channels/base.channel";

@ApiTags("Notification Config")
@ApiBearerAuth("JWT")
@UseGuards(JwtAuthGuard)
@Controller("notification")
export class NotificationConfigController {
  constructor(
    private readonly configService: NotificationConfigService,
    private readonly notificationService: NotificationService,
  ) {}

  // N11: channel configs carry SMTP credentials (password field) and webhook
  // URLs — infrastructure config, admin only. The global RolesGuard reads the
  // metadata; no extra @UseGuards entry is needed (same pattern as audit).
  @Get("channels")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Get all notification channel configs" })
  getChannels() {
    return this.configService.getAllChannels();
  }

  @Patch("channels/:key")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Update notification channel config" })
  updateChannel(
    @Param("key") key: string,
    @Body() body: { enabled?: boolean; config?: Record<string, string> },
  ) {
    return this.configService.updateChannel(key, body);
  }

  @Post("channels/:key/test")
  @ApiOperation({ summary: "Test notification channel" })
  testChannel(@Body() body: Record<string, string>) {
    return this.configService.testChannel(body);
  }

  @Post("test")
  @ApiOperation({ summary: "Send test notification to channel" })
  sendTest(
    @Body() body: { channels: string[]; title: string; content: string },
  ) {
    return this.configService.sendTest(body);
  }

  /**
   * N22: task-side notification reporting endpoint consumed by the
   * autocodeflow-notify SDK (POST /api/notification/send). Guard posture
   * matches the other send surface in this controller (testChannel /
   * sendTest): JwtAuthGuard login state, no extra @Roles. Payload is
   * converted to NotificationPayload and routed through
   * NotificationService.sendAll / sendToChannels, which keep the NOTIF-002
   * sanitized digest logging (raw content never hits the log).
   *
   * V2 (round-7): the response body carries the per-channel delivery results
   * (`sent`/`blocked`/`failed`/`skipped`). The HTTP status stays 2xx even
   * when individual channels fail — a broken alarm must never 500 a task
   * callback — but the caller is no longer blind to SSRF blocks or send
   * errors that used to be visible only in server logs.
   */
  @Post("send")
  @ApiOperation({ summary: "Send notification from task code (SDK)" })
  @ApiResponse({
    status: 201,
    type: SendNotificationResultDto,
    description:
      "2xx regardless of individual channel outcomes; inspect `results` " +
      "for per-channel delivery (sent | blocked | failed | skipped).",
  })
  async send(@Body() dto: SendNotificationDto) {
    const level = dto.level ?? AlertLevel.INFO;
    const payload: NotificationPayload = {
      title: dto.title ?? `[${level.toUpperCase()}] ${dto.taskName ?? "task"}`,
      content: dto.content,
      level,
    };

    const channels = [...(dto.channels ?? [])];
    if (dto.webhookUrl && !channels.includes(AlertChannel.WEBHOOK)) {
      channels.push(AlertChannel.WEBHOOK);
    }

    const results =
      channels.length > 0
        ? await this.notificationService.sendToChannels(
            payload,
            channels,
            dto.webhookUrl,
          )
        : await this.notificationService.sendAll(payload);
    return { success: true, results };
  }
}
