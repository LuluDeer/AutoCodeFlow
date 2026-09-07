import {
  Controller,
  Logger,
  Post,
  Body,
  Get,
  Delete,
  UseGuards,
  Req,
  Param,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
} from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Request } from "express";
import { AuthService } from "./auth.service";
import { AuditService } from "../audit/audit.service";
import { LoginDto } from "./dto/login.dto";
import { RefreshTokenDto } from "./dto/refresh-token.dto";
import { TotpCodeDto, TotpVerifyDto } from "./dto/totp.dto";
import { Public } from "../../common/decorators/public.decorator";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AuthUser } from "../../common/interfaces/auth-user.interface";
// ARCH-27: 装饰器参数在模块求值期（类定义时）确定，ConfigService 在该时点
// 尚不存在 —— 必须经唯一的 env 收口 util 读取，禁止裸 process.env。
import { getEnvVar } from "../../config/env";

/** SEC-03: extract session id (sid) claim from the verified access token. */
function sidOf(req: Request): string | null {
  const sid = (req as any)?.user?.sid;
  return typeof sid === "string" && sid.length > 0 ? sid : null;
}

/** SEC-03: issuance-time metadata for the session list. */
function requestMeta(req: Request): {
  userAgent: string | null;
  ip: string | null;
} {
  const ua = req?.headers?.["user-agent"];
  return {
    userAgent: typeof ua === "string" ? ua.slice(0, 256) : null,
    ip: typeof req?.ip === "string" ? req.ip : null,
  };
}

/**
 * N16: login 路由限流上限（默认 20，env LOGIN_THROTTLE_LIMIT 可覆盖，
 * 生产建议 5）。
 *
 * W-22（windows-findings）前科现场：@Throttle 的参数在装饰器求值期读取，
 * 早于 ConfigModule 生命周期应用 .env。修复 = main.ts 在 import app.module
 * 前预载 .env（见 main.ts 头部，由 src/__tests__/main-env-preload.spec.ts
 * 守护）+ 本处经 src/config/env.ts 的 getEnvVar() 统一收口。这里保留
 * 模块求值期直读是 ARCH-27 审计后的显式豁免（配置值已同步注册到
 * configuration.ts throttle.loginLimit 供运行时一致性检查与文档化）。
 */
const LOGIN_THROTTLE_LIMIT = Number(getEnvVar("LOGIN_THROTTLE_LIMIT")) || 20;

@ApiTags("Auth")
@Controller("auth")
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly auditService: AuditService,
  ) {}

  // N16: login rate limit — configurable via env LOGIN_THROTTLE_LIMIT (default 20 for dev, use 5 in prod)
  @Throttle({
    default: {
      ttl: 60_000,
      limit: LOGIN_THROTTLE_LIMIT,
    },
  })
  @Public()
  @Post("login")
  @ApiOperation({
    summary: "User login",
    description:
      "Login with username and password, returns Access Token and Refresh Token. Max5 attempts per minute.",
  })
  @ApiResponse({
    status: 200,
    description: "Login successful, returns accessToken and refreshToken",
    schema: { example: { accessToken: "eyJ...", refreshToken: "eyJ..." } },
  })
  @ApiResponse({ status: 401, description: "Invalid username or password" })
  @ApiResponse({
    status: 429,
    description: "Too many requests, rate limit exceeded",
  })
  async login(@Body() loginDto: LoginDto, @Req() req: Request) {
    const result = await this.authService.login(loginDto, requestMeta(req));
    await this.auditService
      .log({
        userId: undefined,
        username: loginDto.username,
        action: "auth.login",
        resource: "auth",
        ip: req.ip,
      })
      .catch((err: unknown) =>
        this.logger.warn(`audit log failed on login: ${err}`),
      );
    return result;
  }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Public()
  @Post("refresh")
  @ApiOperation({
    summary: "Refresh token",
    description:
      "Use Refresh Token to obtain new Access Token and Refresh Token (token rotation). Old Refresh Token is immediately invalidated.",
  })
  @ApiResponse({
    status: 200,
    description: "Token refreshed successfully",
    schema: { example: { accessToken: "eyJ...", refreshToken: "eyJ..." } },
  })
  @ApiResponse({
    status: 401,
    description: "Refresh Token is invalid or expired",
  })
  refreshToken(@Body() dto: RefreshTokenDto) {
    return this.authService.refreshToken(dto.refreshToken);
  }

  // SEC-02: logout revokes all refresh tokens for the current user
  @UseGuards(JwtAuthGuard)
  @Post("logout")
  @ApiBearerAuth("JWT")
  @ApiOperation({
    summary: "Logout (revoke all Refresh Tokens)",
    description:
      "Logout current user and revoke all valid Refresh Tokens to prevent token reuse.",
  })
  @ApiResponse({
    status: 200,
    description: "Logout successful",
    schema: { example: { success: true } },
  })
  @ApiResponse({ status: 401, description: "Unauthenticated" })
  async logout(@CurrentUser() user: AuthUser, @Req() req: Request) {
    await this.authService.revokeAllForUser(user.id);
    await this.auditService
      .log({
        userId: user.id,
        username: user.username,
        action: "auth.logout",
        resource: "auth",
        ip: req.ip,
      })
      .catch((err: unknown) =>
        this.logger.warn(`audit log failed on logout: ${err}`),
      );
    return { success: true };
  }

  @UseGuards(JwtAuthGuard)
  @Get("profile")
  @ApiBearerAuth("JWT")
  @ApiOperation({
    summary: "Get current user info",
    description:
      "Return basic info of the current logged-in user including ID, username, and roles.",
  })
  @ApiResponse({
    status: 200,
    description: "User info",
    schema: { example: { id: 1, username: "admin", roles: ["admin"] } },
  })
  @ApiResponse({ status: 401, description: "Unauthenticated" })
  getProfile(@CurrentUser() user: AuthUser) {
    return user;
  }

  // ─── SEC-03: TOTP two-factor auth ─────────────────────────────────────────

  /** SEC-03: stage a fresh TOTP secret; active only after a verified enable. */
  @UseGuards(JwtAuthGuard)
  @Post("totp/setup")
  @ApiBearerAuth("JWT")
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({
    summary: "Stage a TOTP secret (2FA opt-in, step 1)",
    description:
      "Generates a Base32 secret and otpauth:// URL, stores it in staged (disabled) state. " +
      "Call POST /auth/totp/enable with a valid code from the authenticator to activate.",
  })
  @ApiResponse({ status: 200, description: "Staged secret + otpauth URL" })
  @ApiResponse({ status: 400, description: "TOTP already enabled" })
  totpSetup(@CurrentUser() user: AuthUser) {
    return this.authService.totpSetup(user.id);
  }

  /** SEC-03: verify a code against the staged secret and activate 2FA. */
  @UseGuards(JwtAuthGuard)
  @Post("totp/enable")
  @ApiBearerAuth("JWT")
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({
    summary: "Enable TOTP (2FA opt-in, step 2)",
    description:
      "Verifies one valid code against the staged secret, then sets totpEnabled=true.",
  })
  @ApiResponse({ status: 200, description: "TOTP enabled" })
  @ApiResponse({ status: 400, description: "Invalid code or nothing staged" })
  totpEnable(@CurrentUser() user: AuthUser, @Body() dto: TotpCodeDto) {
    return this.authService.totpEnable(user.id, dto.code);
  }

  /**
   * SEC-03: disable TOTP — requires password or a valid TOTP code so a
   * stolen access token alone cannot turn 2FA off.
   */
  @UseGuards(JwtAuthGuard)
  @Post("totp/disable")
  @ApiBearerAuth("JWT")
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({
    summary: "Disable TOTP",
    description:
      "Requires the account password or a valid TOTP code as confirmation.",
  })
  @ApiResponse({ status: 200, description: "TOTP disabled (or was not on)" })
  @ApiResponse({ status: 401, description: "Confirmation failed" })
  totpDisable(
    @CurrentUser() user: AuthUser,
    @Body() dto: { password?: string; code?: string },
  ) {
    return this.authService.totpDisable(user.id, {
      password: dto?.password,
      code: dto?.code,
    });
  }

  /**
   * SEC-03: second login step for TOTP-enabled accounts. Public (like
   * /auth/login) and separately rate-limited; re-validates credentials
   * before checking the code, so it cannot bypass the password check.
   */
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Public()
  @Post("totp/verify")
  @ApiOperation({
    summary: "Complete TOTP login (second factor)",
    description:
      "Re-validates username+password, verifies the 6-digit TOTP code, and issues " +
      "accessToken/refreshToken. Called after /auth/login returned { totpRequired: true }.",
  })
  @ApiResponse({
    status: 200,
    description: "Tokens issued",
    schema: {
      example: { accessToken: "eyJ...", refreshToken: "eyJ..." },
    },
  })
  @ApiResponse({ status: 401, description: "Invalid credentials or TOTP code" })
  totpVerifyLogin(@Body() dto: TotpVerifyDto, @Req() req: Request) {
    return this.authService.totpVerifyLogin({
      username: dto.username,
      password: dto.password,
      code: dto.code,
      meta: requestMeta(req),
    });
  }

  // ─── SEC-03: session management (refresh token revocation UI surface) ─────

  /** SEC-03: list my active sessions; the caller's own row is marked current. */
  @UseGuards(JwtAuthGuard)
  @Get("sessions")
  @ApiBearerAuth("JWT")
  @ApiOperation({
    summary: "List my active login sessions",
    description:
      "One row per active (non-revoked, non-expired) refresh token. The row matching " +
      "the sid claim of the caller's access token is flagged current=true.",
  })
  @ApiResponse({ status: 200, description: "Session list" })
  listSessions(@CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.authService.listSessions(user.id, sidOf(req));
  }

  /** SEC-03: revoke one of my sessions by refresh_tokens row id. */
  @UseGuards(JwtAuthGuard)
  @Delete("sessions/:id")
  @ApiBearerAuth("JWT")
  @ApiOperation({
    summary: "Revoke one of my sessions",
    description:
      "Marks the given refresh token row revoked (DR-04 semantics — the refresh " +
      "JWT becomes unusable immediately). Ownership is enforced; foreign ids get 401.",
  })
  @ApiResponse({ status: 200, description: "Session revoked" })
  @ApiResponse({ status: 401, description: "Session not found or not yours" })
  async revokeSession(
    @Param("id") id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const sessionId = Number(id);
    if (!Number.isInteger(sessionId)) {
      return { success: false };
    }
    await this.authService.revokeSession(user.id, sessionId);
    await this.auditService
      .log({
        userId: user.id,
        username: user.username,
        action: "auth.session.revoke",
        resource: "auth",
        resourceId: id,
        ip: req.ip,
      })
      .catch((err: unknown) =>
        this.logger.warn(`audit log failed on session revoke: ${err}`),
      );
    return { success: true };
  }

  /** SEC-03: revoke every session of mine except the current one. */
  @UseGuards(JwtAuthGuard)
  @Post("sessions/revoke-others")
  @ApiBearerAuth("JWT")
  @ApiOperation({
    summary: "Revoke all my sessions except the current one",
    description:
      "Bulk remote-logout of other devices. Without a sid claim this degenerates to " +
      "revoking ALL sessions (fail-safe, never keeps unknown sessions).",
  })
  @ApiResponse({ status: 200, description: "Revocation count" })
  async revokeOtherSessions(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const result = await this.authService.revokeOtherSessions(
      user.id,
      sidOf(req),
    );
    await this.auditService
      .log({
        userId: user.id,
        username: user.username,
        action: "auth.session.revoke_others",
        resource: "auth",
        ip: req.ip,
      })
      .catch((err: unknown) =>
        this.logger.warn(`audit log failed on revoke-others: ${err}`),
      );
    return result;
  }
}
