import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Req,
  NotFoundException,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
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
import { API_KEY_SCOPES, API_KEY_PLAINTEXT_PREFIX } from "./api-key.util";
import { ApiKeyScope } from "./entities/api-key.entity";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AuthUser } from "../../common/interfaces/auth-user.interface";
import type { Request } from "express";

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
    message:
      "scopes 仅支持 task:trigger（空格分隔词表；当前无其他扩展域）",
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
  @ApiOperation({ summary: "List my API Keys (masked)" })
  list(@CurrentUser() user: AuthUser) {
    return this.apiKeysService.listForUser(user.id);
  }

  @Post()
  @ApiOperation({
    summary: "Create an API Key",
    description:
      "Returns the plaintext key ONCE (`acf_<64 hex>`); it is stored only as a sha256 hash and can never be retrieved again.",
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
  @Delete(":id")
  @ApiOperation({ summary: "Revoke (soft-delete) my API Key" })
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
    if (!row) throw new NotFoundException(`API Key #${id} not found`);
    return { success: true, apiKey: row };
  }

  /** Explicit revoke alias (idempotent — re-revoking returns the row). */
  @Post(":id/revoke")
  @ApiOperation({ summary: "Revoke my API Key (explicit alias, idempotent)" })
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
    if (!row) throw new NotFoundException(`API Key #${id} not found`);
    return { success: true, apiKey: row };
  }
}
