import {
  Controller,
  Get,
  Patch,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  Logger,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiBody,
  ApiResponse,
  ApiOkResponse,
  ApiCreatedResponse,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AuthUser } from "../../common/interfaces/auth-user.interface";
import { Roles } from "../../common/decorators/roles.decorator";
import { UserRole } from "../users/entities/user.entity";
import { NotificationConfigService } from "./notification-config.service";
import { NotificationSilenceService } from "./notification-silence.service";
import {
  AlertChannel,
  AlertLevel,
  NotificationService,
} from "./notification.service";
import {
  SendNotificationDto,
  SendNotificationResultDto,
  SendTestDto,
} from "./dto/send-notification.dto";
// P3-5（PK-19 收尾）：createSilence 请求体 class DTO（校验器已挂到类上，
// 运行时 @Body() 即本类，恢复全站 whitelist 纪律）。
import { CreateSilenceDto } from "./dto/create-silence.dto";
// P2-3（F-53 残留清理）：updateChannel 请求体 class DTO（值必须 string +
// 键数/长度护栏，详见该 DTO 头注）。
import { UpdateChannelDto } from "./dto/update-channel.dto";
import { NotificationPayload } from "./channels/base.channel";
// D3-B-P2-2: 渠道/静默增删审计落证。
import { AuditService } from "../audit/audit.service";
// F-53（UIAUDIT P2-2）：testChannel 的动态键覆盖体形状管道（键集随渠道类型
// 变化，封闭 class DTO 不适用，见管道头注）。
import { ChannelConfigOverridePipe } from "./channel-config-override.pipe";
// ARCH-23 / N-12（2026-10-07 A1 批）：通知配置域响应契约。
import {
  ChannelTestResponseDto,
  NotificationChannelDto,
  NotificationSilenceDto,
} from "./dto/notification-response.dto";

@ApiTags("Notification Config")
@ApiBearerAuth("JWT")
@UseGuards(JwtAuthGuard)
@Controller("notification")
export class NotificationConfigController {
  private readonly logger = new Logger(NotificationConfigController.name);

  constructor(
    private readonly configService: NotificationConfigService,
    private readonly notificationService: NotificationService,
    private readonly silenceService: NotificationSilenceService,
    // D3-B-P2-2: 渠道/静默增删审计落证。
    private readonly audit: AuditService,
  ) {}

  // N11: channel configs carry SMTP credentials (password field) and webhook
  // URLs — infrastructure config, admin only. The global RolesGuard reads the
  // metadata; no extra @UseGuards entry is needed (same pattern as audit).
  @Get("channels")
  @ApiOkResponse({ type: [NotificationChannelDto] })
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "获取所有通知渠道配置" })
  getChannels() {
    return this.configService.getAllChannels();
  }

  // P2-3（2026-10-25 审计，F-53 残留清理）：body 从内联类型改 class DTO
  // （UpdateChannelDto）——此前 metatype=Object 使全局 ValidationPipe 整体
  // 跳过，非 string config 值写穿 DB 后 maskChannel 对其 replace → PATCH 500
  // 且 GET /channels 持续 500（hydrateFromPersisted 回灌坏值）。
  @Patch("channels/:key")
  @ApiOkResponse({ type: NotificationChannelDto })
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "更新通知渠道配置" })
  @ApiBody({ type: UpdateChannelDto, description: "渠道配置更新体" })
  async updateChannel(
    @Param("key") key: string,
    @Body() dto: UpdateChannelDto,
    @CurrentUser() user: AuthUser,
  ) {
    const result = this.configService.updateChannel(key, dto);
    // D3-B-P2-2: 渠道配置变更落证（不落 config 明文——仅 key/enabled 差量）。
    // A-4: 变更已生效后才写审计——审计库故障时 best-effort 吞掉（对齐
    // task.service R-28 先例），不再让已生效的配置变更反向吃 500。
    try {
      await this.audit.log({
        username: user.username,
        action: "notification.channel.update",
        resource: "notification_channel",
        resourceId: key,
        detail: { enabledChanged: dto.enabled !== undefined },
      });
    } catch (err: unknown) {
      this.logger.warn(
        `notification channel audit write failed for ${key} (best-effort, ignored): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return result;
  }

  /**
   * R8 (N29): the channel key is now honored (it used to be dropped — the
   * endpoint fanned out to ALL channels regardless), the optional body is
   * treated as an unsaved config override for the tested channel, and the
   * response reflects the real per-channel delivery result instead of an
   * unconditional success:true.
   *
   * R2: testChannel is admin-only — it triggers an actual outbound
   * delivery using the override config and the response carries the
   * SSRF/transport verdict. A non-admin caller could probe the network
   * path or exfiltrate config through the same endpoint. The global
   * RolesGuard reads the @Roles metadata; no extra @UseGuards entry is
   * needed (same pattern as the channel-config PATCH above).
   */
  @Post("channels/:key/test")
  @ApiCreatedResponse({ type: ChannelTestResponseDto })
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "测试通知渠道" })
  // F-53（UIAUDIT P2-2）：此前裸 Record<string, string>（metatype=Object，
  // 全局管道跳过）——任意形状 JSON 直达渠道 override。键集是动态的（随渠道
  // 类型变化），封闭 class DTO 不适用，改挂形状管道（值必须 string + 数量/
  // 长度护栏，非法 400 VALIDATION_FAILED 形态）。
  testChannel(
    @Param("key") key: string,
    @Body(new ChannelConfigOverridePipe()) body: Record<string, string>,
  ) {
    return this.configService.testChannel(key, body);
  }

  /**
   * R2: sendTest is admin-only — same rationale as testChannel above; the
   * fan-out hits every requested enabled channel and the response leaks
   * their actual delivery outcomes (sent/blocked/failed). Limiting it to
   * ADMIN matches the audit/notification-config posture (N11).
   */
  @Post("test")
  @ApiCreatedResponse({ type: ChannelTestResponseDto })
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "向渠道发送测试通知" })
  // F-53（UIAUDIT P2-2）：内联类型换 class DTO（SendTestDto），全局
  // whitelist+forbidNonWhitelisted 纪律生效；channels 走渠道枚举白名单。
  sendTest(@Body() body: SendTestDto) {
    return this.configService.sendTest(body);
  }

  /**
   * N22: task-side notification reporting endpoint consumed by the
   * autocodeflow-notify SDK (POST /api/notification/send).
   *
   * A-3: 收紧为 ADMIN-only。原 `@WriteGuard(scope:"authenticated")` 让任意
   * 登录用户可向全部渠道广播任意内容、并可携带 webhookUrl 借道外发——与同
   * 文件 testChannel/sendTest 锁 ADMIN 的理由（触发真实外发 + 泄露渠道投递
   * 结果）完全一致，"authenticated" 的登记是错误档位。任务侧 SDK 的通知仍
   * 走 notifyFailure/notifySuccess/notifyTimeout 的服务内路径，不依赖本
   * HTTP 端点。Payload is converted to NotificationPayload and routed
   * through NotificationService.sendAll / sendToChannels, which keep the
   * NOTIF-002 sanitized digest logging (raw content never hits the log).
   *
   * V2 (round-7): the response body carries the per-channel delivery results
   * (`sent`/`blocked`/`failed`/`skipped`). The HTTP status stays 2xx even
   * when individual channels fail — a broken alarm must never 500 a task
   * callback — but the caller is no longer blind to SSRF blocks or send
   * errors that used to be visible only in server logs.
   */
  @Post("send")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "从任务代码发送通知（SDK，仅管理员）" })
  @ApiResponse({
    status: 201,
    type: SendNotificationResultDto,
    description:
      "无论各渠道结果如何均返回 2xx；各渠道投递情况见 `results`（sent | blocked | failed | skipped）。",
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

  // FEAT-01: 通知静默规则 CRUD（ADMIN-only，与渠道配置同一 RBAC 姿态）。
  // 规则持久化到 notification_silences 并写穿 NotificationService 内存态，
  // 重启后由 onModuleInit 回灌——静默不再是重启即丢的内存态。

  @Get("silences")
  @ApiOkResponse({ type: [NotificationSilenceDto] })
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "列出通知静默（已持久化）" })
  @ApiResponse({ status: 200, description: "全部静默规则" })
  listSilences() {
    return this.silenceService.listAll();
  }

  @Post("silences")
  @ApiCreatedResponse({ type: NotificationSilenceDto })
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "创建通知静默" })
  @ApiResponse({ status: 201, description: "已创建的静默规则" })
  // P3-5（2026-10-25 审计，PK-19 收尾）：body 从内联对象类型改 class DTO
  // （CreateSilenceDto 挂上校验器）——此前 metatype=Object 使全局 whitelist/
  // forbidNonWhitelisted 对本面整体跳过，多余字段静默收下；现按全站纪律
  // 400。scope/level/durationMinutes 等口径与 silenceService.create 同源，
  // service 内部校验保持不动（它还是内部调用方的唯一闸）。
  @ApiBody({ type: CreateSilenceDto, description: "静默规则创建体" })
  async createSilence(@Body() dto: CreateSilenceDto) {
    const row = await this.silenceService.create(dto);
    // ARCH-31: 同步进 NotificationService 的内存热路径——此前只落 DB，
    // isSilenced 看不到本规则（要等进程重启回灌才生效）。
    this.notificationService.adoptPersistedSilence(row);
    // D3-B-P2-2: 静默规则创建落证。A-4: 静默已落库+已 adopt（变更已生效），
    // 审计写失败 best-effort（对齐 R-28），不再反向 500。
    try {
      await this.audit.log({
        action: "notification.silence.create",
        resource: "notification_silence",
        resourceId: row.id,
        detail: { scope: dto.scope },
      });
    } catch (err: unknown) {
      this.logger.warn(
        `notification silence audit write failed for ${row.id} (best-effort, ignored): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return row;
  }

  @Delete("silences/:id")
  @ApiOkResponse({
    description: "removed=false = 该 id 不存在（幂等语义）",
    schema: { type: "boolean" },
  })
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "移除通知静默" })
  async removeSilence(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    // ARCH-31: 内存 + DB 双删（内存态由 NotificationService 持有，DB 行由
    // silenceService 负责——forgetSilence 只清内存，避免重复删库）。
    this.notificationService.forgetSilence(id);
    const removed = await this.silenceService.remove(id);
    // D3-B-P2-2: 静默规则删除落证。A-4: 内存+DB 双删已生效，审计写失败
    // best-effort（对齐 R-28），不再反向 500。
    try {
      await this.audit.log({
        username: user.username,
        action: "notification.silence.delete",
        resource: "notification_silence",
        resourceId: id,
      });
    } catch (err: unknown) {
      this.logger.warn(
        `notification silence delete audit write failed for ${id} (best-effort, ignored): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return removed;
  }
}
