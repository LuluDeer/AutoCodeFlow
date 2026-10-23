import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
// LANG-ERR-01（后端错误码化）：用户面抛出统一走 AppError（带稳定码，前端按
// 用户语言渲染）。AppError 按状态码挂到对应内置异常原型上。
import { AppError } from "../../common/errors/app-error";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
  ApiOkResponse,
  ApiCreatedResponse,
} from "@nestjs/swagger";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  Contains,
} from "class-validator";
import { Transform } from "class-transformer";
import { ApiKeysService } from "./api-keys.service";
// ARCH-23 / N-12（2026-10-07 A1 批）：API Key 域响应契约。
import {
  ApiKeyCreateResponseDto,
  ApiKeyRevokeResponseDto,
  ApiKeyViewDto,
} from "./dto/api-key-response.dto";
import { API_KEY_SCOPES, API_KEY_PLAINTEXT_PREFIX } from "./api-key.util";
import { ApiKeyScope } from "./entities/api-key.entity";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AuthUser } from "../../common/interfaces/auth-user.interface";
import type { Request } from "express";
import { WriteGuard } from "../../common/decorators/write-guard.decorator";

export class CreateApiKeyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @IsIn(API_KEY_SCOPES as unknown as string[])
  scope: ApiKeyScope;

  /**
   * NF-01: optional extra narrow-domain scopes (space-separated word list).
   * Only `task:trigger` is accepted today — it allows the key to call
   * POST /tasks/:id/trigger (single-task trigger) in addition to the
   * legacy tier's surface, for CI/script dispatch without a user JWT.
   */
  @IsOptional()
  @Transform(({ value }) =>
    Array.isArray(value) ? value.join(" ") : String(value ?? ""),
  )
  @Contains("task:trigger", {
    message: "scopes 仅支持 task:trigger（空格分隔词表；当前无其他扩展域）",
  })
  @MaxLength(128)
  scopes?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  expiresInDays?: number;
}

/**
 * AUTH-03: API Key management — **JWT-only surface**.
 *
 * The global guard refuses API-Key credentials on `/api-keys` paths, so a
 * leaked key can never mint or replace credentials. All endpoints operate
 * strictly on the caller's own keys (ownership enforced in the service /
 * here via `user.id`).
 */
@ApiTags("API Keys")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("api-keys")
export class ApiKeysController {
  constructor(private readonly apiKeysService: ApiKeysService) {}

  @Get()
  @ApiOkResponse({ type: [ApiKeyViewDto] })
  @ApiOperation({ summary: "列出我的 API Key（脱敏）" })
  list(@CurrentUser() user: AuthUser) {
    return this.apiKeysService.listForUser(user.id);
  }

  @WriteGuard("api-key", { scope: "authenticated" })
  @Post()
  @ApiCreatedResponse({
    type: ApiKeyCreateResponseDto,
    description: "明文 key 一次性回显",
  })
  @ApiOperation({
    description:
      "明文密钥仅返回一次（`acf_<64 hex>`）；服务端只保存 sha256 哈希，之后无法再取回。",
    summary: "创建 API Key",
  })
  async create(
    @Body() dto: CreateApiKeyDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const { apiKey, plaintext } = await this.apiKeysService.create({
      userId: user.id,
      username: user.username,
      name: dto.name,
      scope: dto.scope,
      scopes: dto.scopes ?? null,
      expiresInDays: dto.expiresInDays,
      ip: req?.ip,
    });
    // One-time plaintext echo — the ONLY place it ever appears.
    return {
      ...apiKey,
      plaintext: `${API_KEY_PLAINTEXT_PREFIX}${plaintext.slice(API_KEY_PLAINTEXT_PREFIX.length)}`,
    };
  }

  /** Soft-revoke (kept for REST semantics symmetry with the sessions API). */
  @WriteGuard("api-key", { scope: "authenticated" })
  @Delete(":id")
  @ApiOkResponse({ type: ApiKeyRevokeResponseDto })
  @ApiOperation({ summary: "撤销（软删除）我的 API Key" })
  async revoke(
    @Param("id", ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const row = await this.apiKeysService.revoke(
      id,
      user.id,
      user.username,
      req?.ip,
    );
    if (!row) throw new AppError("API_KEY_NOT_FOUND", { apiKeyId: id });
    return { success: true, apiKey: row };
  }

  /** Explicit revoke alias (idempotent — re-revoking returns the row). */
  @WriteGuard("api-key", { scope: "authenticated" })
  @Post(":id/revoke")
  @ApiCreatedResponse({ type: ApiKeyRevokeResponseDto })
  @ApiOperation({ summary: "撤销我的 API Key（显式别名，幂等）" })
  async revokeAlias(
    @Param("id", ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const row = await this.apiKeysService.revoke(
      id,
      user.id,
      user.username,
      req?.ip,
    );
    if (!row) throw new AppError("API_KEY_NOT_FOUND", { apiKeyId: id });
    return { success: true, apiKey: row };
  }

  /**
   * Permanent delete — cleanup only.
   *
   * The path is explicit (`/permanent`) so the existing `DELETE /api-keys/:id`
   * soft-revoke contract stays byte-compatible for existing clients. Only
   * inert rows (already revoked, or expired) may be deleted; an active key
   * must be revoked first so its lifecycle keeps a `apikey.revoke` audit row.
   */
  @WriteGuard("api-key", { scope: "authenticated" })
  @Delete(":id/permanent")
  @ApiOkResponse({ type: ApiKeyRevokeResponseDto })
  @ApiOperation({ summary: "永久删除我的 API Key（仅限已吊销/已过期）" })
  async remove(
    @Param("id", ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const row = await this.apiKeysService.remove(
      id,
      user.id,
      user.username,
      req?.ip,
    );
    if (!row) throw new AppError("API_KEY_NOT_FOUND", { apiKeyId: id });
    return { success: true, apiKey: row };
  }
}
