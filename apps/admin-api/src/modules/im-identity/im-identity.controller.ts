import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  Optional,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import type { Request } from "express";
import { Public } from "../../common/decorators/public.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { WriteGuard } from "../../common/decorators/write-guard.decorator";
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";
import { verifyWebhookSignature } from "../../common/utils/webhook-hmac.util";
import { UserRole } from "../users/entities/user.entity";
import { ImIntakeDto, ImIntakeResultDto } from "./dto/im-intake.dto";
import { ImWebhookBodyDto } from "./dto/im-webhook.dto";
import { ImIdentityViewDto } from "./dto/im-identity-view.dto";
import { ImInjectionScanResultDto } from "./dto/scan-result.dto";
import { ScanTextDto } from "./dto/scan-text.dto";
import { VerifyBindDto } from "./dto/verify-bind.dto";
import { IM_PLATFORMS, ImIdentity } from "./entities/im-identity.entity";
import type { ImInjectionScanResult } from "./injection-guard";
import { ImIdentityService } from "./im-identity.service";
import { ImIntakeService } from "./im-intake.service";
import {
  buildChallengeResponse,
  extractImMessage,
  isChallengeRequest,
  type ImWebhookQuery,
} from "./im-webhook.adapter";

/**
 * IM webhook 验签失败的统一出口：与 task / application / alerts webhook 的
 * `authFail` 同口径——所有失败分支抛同一个 401 码，具体原因只进服务端日志，
 * 避免响应差异泄露签名头/时间戳/平台信息。
 */
const imWebhookAuthFail = (): AppError =>
  new AppError(ErrorCode.APP_WEBHOOK_AUTH_FAILED);

/**
 * N6：IM 入口的只读管理面 + 最小绑定面（全部走全局 JwtAuthGuard）。
 *
 *  GET  /api/im-identity                 列表（ADMIN）
 *  POST /api/im-identity/verify-bind     验签名并绑定（ADMIN，写端点靠 @Roles 门控）
 *  POST /api/im-identity/scan            群聊消息注入自检（ADMIN，纯校验不落库）
 *  POST /api/im-identity/intake          N6 Intake 编排（ADMIN，只预览不落库；供未来 webhook adapter 调用）
 *  POST /api/im-identity/webhook/:platform  N6 IM 平台入站（机器面，HMAC 验签替代 JWT）
 *
 * 管理面写端点只用 @Roles(ADMIN)，不叠加 @WriteGuard（route-authz-matrix 禁止两者共存）。
 * webhook 是唯一的机器入站例外：@Public + @WriteGuard("im-identity", {scope:"public"})。
 * 签名头名沿用 webhook-hmac.util 的 WEBHOOK_SIGNATURE_HEADER /
 * WEBHOOK_TIMESTAMP_HEADER（Express 已小写化 header key）。
 */
@ApiTags("IM Identity")
@ApiBearerAuth("JWT")
@Controller("im-identity")
export class ImIdentityController {
  private readonly logger = new Logger(ImIdentityController.name);

  constructor(
    private readonly svc: ImIdentityService,
    private readonly intakeSvc: ImIntakeService,
    // @Optional 仅为兼容直接 new 的极简单测；生产由全局 ConfigModule 注入。
    // 缺席 ⇒ secret 为空 ⇒ 验签 fail-closed（绝不把「无密钥」当成放行）。
    @Optional() private readonly config?: ConfigService,
  ) {}

  @Get()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "列出 IM 身份绑定（ADMIN）" })
  @ApiOkResponse({ type: [ImIdentityViewDto] })
  list(): Promise<ImIdentity[]> {
    return this.svc.list();
  }

  @Post("verify-bind")
  @HttpCode(200)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "校验网关发送方签名并绑定平台用户（ADMIN）" })
  @ApiOkResponse({ type: ImIdentityViewDto })
  verifyBind(
    @Body() dto: VerifyBindDto,
    @Headers("x-hub-signature-256") signature?: string,
    @Headers("x-autocodeflow-timestamp") timestamp?: string,
    @Req() req?: Request & { rawBody?: Buffer },
    @CurrentUser() user?: { id: number; username: string },
  ): Promise<ImIdentity> {
    return this.svc.verifyAndBind(
      dto,
      { signature, timestamp, rawBody: req?.rawBody },
      user,
    );
  }

  @Post("scan")
  @HttpCode(200)
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: "群聊 @bot 消息 prompt-injection 自检（ADMIN，纯校验）",
  })
  @ApiOkResponse({ type: ImInjectionScanResultDto })
  scan(@Body() dto: ScanTextDto): ImInjectionScanResult {
    return this.svc.scan(dto.text);
  }

  @Post("intake")
  @HttpCode(200)
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary:
      "IM 消息入站编排：注入扫描→身份校验→ProjectRole→方案卡预览（ADMIN，只预览不落库）",
  })
  @ApiOkResponse({ type: ImIntakeResultDto })
  intake(@Body() dto: ImIntakeDto): Promise<ImIntakeResultDto> {
    return this.intakeSvc.intake(dto);
  }

  /**
   * N6 · IM 平台机器入站 webhook（企微 / 飞书）。
   *
   * **验签即身份**：本端点不加 @Roles(ADMIN)——IM 平台拿不到用户会话，加了
   * 会直接 401；身份由 verifyWebhookSignature 对 rawBody + 签名头 + 时间戳头
   * 做 HMAC（±5min）校验替代。验签之后，注入扫描 / sender→平台 user 绑定 /
   * ProjectRole 判定全部交给 intakeSvc.intake（ImIntakeService 的四眼语义），
   * 本层只做消息→ImIntakeDto 的装配，不重写任何一层校验。
   * 与上面的 ADMIN 手动 `POST intake` 并存，不替换。
   */
  @Public()
  @WriteGuard("im-identity", {
    scope: "public",
    reason:
      "IM 平台机器入站，凭 HMAC 验签替代 JWT 身份；其后 intake 做 sender→平台 user 绑定校验",
  })
  @Post("webhook/:platform")
  @HttpCode(200)
  @ApiOperation({
    summary:
      "IM 平台 webhook 入站：验签→challenge 回显→方案卡预览（机器入站，验签即身份）",
    description:
      "签名头 X-Hub-Signature-256 与时间戳头 X-AutoCodeFlow-Timestamp 必带，验签失败统一 401；challenge 回显也在验签之后。平台只取 URL 路径参数，body 自报平台一律忽略。",
  })
  @ApiParam({
    name: "platform",
    enum: IM_PLATFORMS,
    description: "IM 平台（wecom / feishu），由平台调用方在 URL 路径上声明",
  })
  @ApiBody({
    type: ImWebhookBodyDto,
    description: "企微 / 飞书原始 payload；只列出 adapter 实际消费的字段",
  })
  @ApiOkResponse({
    type: ImIntakeResultDto,
    description: "正常消息返回方案卡预览；challenge 分支回显纯文本校验串",
  })
  webhook(
    @Param("platform") platform: string,
    @Query() query: ImWebhookQuery,
    @Body() body: unknown,
    @Headers("x-hub-signature-256") signature?: string,
    @Headers("x-autocodeflow-timestamp") timestamp?: string,
    @Req() req?: Request & { rawBody?: Buffer },
  ): Promise<ImIntakeResultDto> | string {
    // ① 验签优先且不可绕过：challenge 也在验签之后，避免未验签回显被滥用。
    // secret 缺失与签名失败走同一个 authFail，不向调用方透露任何细节。
    const secret = this.config?.get<string>("IM_SIGNING_SECRET") ?? "";
    const failure = verifyWebhookSignature(
      { rawBody: req?.rawBody, signature, timestamp },
      secret,
    );
    if (!secret || failure) {
      this.logger.warn(
        `IM webhook: signature verification failed (${
          failure ?? "secret_not_configured"
        }) platform=${platform}`,
      );
      throw imWebhookAuthFail();
    }

    // ② challenge 只回显、不进 intake；畸形 challenge 由 adapter fail-closed。
    if (isChallengeRequest(query)) {
      const echo = buildChallengeResponse(query);
      if (echo === null) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, {
          detail: "IM challenge 回显串缺失或非法",
        });
      }
      return echo;
    }

    // ③ 平台来源只认路径参数：body 自报的 platform / imSenderId 一律不采信。
    if (!(IM_PLATFORMS as readonly string[]).includes(platform)) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        detail: "不支持的 IM 平台",
      });
    }

    // ④ 消息提取 → 装配 ImIntakeDto → intake。detect/preview/身份/角色的
    //    四步语义全在 ImIntakeService 内部；adapter 未产出 cadence，按既有
    //    三档枚举取确定性默认 monthly（不是业务判断，不触碰四眼语义）。
    const message = extractImMessage(platform, body);
    if (!message) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        detail: "IM 消息 payload 无法提取 senderId 或正文",
      });
    }
    const dto: ImIntakeDto = {
      platform: message.platform,
      imSenderId: message.senderId,
      message: message.text,
      cadence: "monthly",
    };
    return this.intakeSvc.intake(dto);
  }
}
