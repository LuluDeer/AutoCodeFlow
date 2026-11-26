import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Req,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import type { Request } from "express";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { UserRole } from "../users/entities/user.entity";
import { ImIdentity } from "./entities/im-identity.entity";
import { ImIdentityService } from "./im-identity.service";
import { ImIntakeService } from "./im-intake.service";
import { VerifyBindDto } from "./dto/verify-bind.dto";
import { ScanTextDto } from "./dto/scan-text.dto";
import { ImIntakeDto, ImIntakeResultDto } from "./dto/im-intake.dto";
import { ImIdentityViewDto } from "./dto/im-identity-view.dto";
import { ImInjectionScanResultDto } from "./dto/scan-result.dto";
import type { ImInjectionScanResult } from "./injection-guard";

/**
 * N6：IM 入口的只读管理面 + 最小绑定面（全部走全局 JwtAuthGuard）。
 *
 *  GET  /api/im-identity                 列表（ADMIN）
 *  POST /api/im-identity/verify-bind     验签名并绑定（ADMIN，写端点靠 @Roles 门控）
 *  POST /api/im-identity/scan            群聊消息注入自检（ADMIN，纯校验不落库）
 *  POST /api/im-identity/intake          N6 Intake 编排（ADMIN，只预览不落库；供未来 webhook adapter 调用）
 *
 * 写端点只用 @Roles(ADMIN)，不叠加 @WriteGuard（route-authz-matrix 禁止两者共存）。
 * 签名头名沿用 webhook-hmac.util 的 WEBHOOK_SIGNATURE_HEADER /
 * WEBHOOK_TIMESTAMP_HEADER（Express 已小写化 header key）。
 */
@ApiTags("IM Identity")
@ApiBearerAuth("JWT")
@Controller("im-identity")
export class ImIdentityController {
  constructor(
    private readonly svc: ImIdentityService,
    private readonly intakeSvc: ImIntakeService,
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
}
