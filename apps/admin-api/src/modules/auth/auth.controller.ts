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
  ApiCreatedResponse,
  ApiOkResponse,
} from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Request } from "express";
import { AuthService } from "./auth.service";
import { AuditService } from "../audit/audit.service";
import { LoginDto } from "./dto/login.dto";
import { RefreshTokenDto } from "./dto/refresh-token.dto";
import { TotpCodeDto, TotpDisableDto, TotpVerifyDto } from "./dto/totp.dto";
// ARCH-23 / N-12：响应体 DTO——此前这些端点只有 description 没有 type，
// openapi.json 里对应 2xx 无 schema，前端无法生成类型（详见该 DTO 文件头注）。
import {
  TotpSetupResponseDto,
  TotpEnableResponseDto,
  TotpDisableResponseDto,
  AuthSessionRowDto,
  RevokeOthersResponseDto,
} from "./dto/auth-response.dto";
import { SseTicketResponseDto } from "./dto/sse-ticket.dto";
import { Public } from "../../common/decorators/public.decorator";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AuthUser } from "../../common/interfaces/auth-user.interface";
// ARCH-27: 装饰器参数在模块求值期（类定义时）确定，ConfigService 在该时点
// 尚不存在 —— 必须经唯一的 env 收口 util 读取，禁止裸 process.env。
import { getEnvVar } from "../../config/env";
// SEC-09: 限流分域严格档（auth 敏写面）。同样是装饰器求值期读取，
// 与 LOGIN_THROTTLE_LIMIT 同款 W-22 豁免（main.ts 预载 .env 兜底）。
import { AUTH_THROTTLE } from "../../config/throttle-profiles";
import { WriteGuard } from "../../common/decorators/write-guard.decorator";
import { SessionRevokeResponseDto } from "./dto/misc-response.dto";
// F-56：sessions/:id 形态管道（非法 id 400 INVALID_VALUE_FORMAT，替代
// 200 {success:false}）。
import { ParseIntShapePipe } from "../../common/pipes/parse-int-shape.pipe";
import {
  AuthLogoutDto,
  AuthProfileDto,
  AuthTokensDto,
} from "../../common/dto/misc-2xx-response.dto";

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
 *
 * SEC-09 限流分域（本控制器）：login 保留 LOGIN_THROTTLE_LIMIT=20 契约，
 * refresh + totp/* 改挂严格档 AUTH_THROTTLE（默认 10/min，env
 * THROTTLE_AUTH_LIMIT/TTL 可调）——档位定义与分域矩阵见
 * src/config/throttle-profiles.ts。
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

  // N16: login rate limit — configurable via env LOGIN_THROTTLE_LIMIT
  // (default 20 for dev, use 5 in prod). SEC-09 分域后 login 契约刻意保持
  // 不变（既有 e2e/文档依赖 20/min 档；其余 auth 敏写面走 AUTH_THROTTLE
  // 严格档，见 throttle-profiles.ts 分域矩阵）。
  @Throttle({
    default: {
      ttl: 60_000,
      limit: LOGIN_THROTTLE_LIMIT,
    },
  })
  @Public()
  @WriteGuard("session", {
    scope: "public",
    reason: "凭据交换入口，此时尚无会话可依赖（限流 20/min 兜底）",
  })
  @Post("login")
  @ApiOperation({
    description:
      // R-22（DEEP_REVIEW 0ef3bbe）: Swagger 文案与实际限流值对齐——文案直接
      // 内插 LOGIN_THROTTLE_LIMIT（本文件顶部，默认 20/min，env 可覆盖），
      // 杜绝再次漂移。旧文案硬编码 "Max5 attempts per minute" 与实际 20 不符。
      `使用用户名和密码登录，返回 Access Token 与 Refresh Token。每分钟最多 ${LOGIN_THROTTLE_LIMIT} 次尝试。`,
    summary: "用户登录",
  })
  @ApiResponse({ status: 401, description: "用户名或密码错误" })
  @ApiResponse({
    status: 429,
    description: "请求过于频繁，已触发限流",
  })
  @ApiResponse({
    status: 200,
    description: "双 token 或 {totpRequired:true}（SEC-03 二段登录）",
    content: {
      "application/json": {
        schema: {
          oneOf: [
            { $ref: "#/components/schemas/AuthTokensDto" },
            {
              type: "object",
              properties: { totpRequired: { type: "boolean", enum: [true] } },
              required: ["totpRequired"],
            },
          ],
        },
      },
    },
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

  @Throttle({ default: AUTH_THROTTLE })
  @Public()
  @WriteGuard("session", {
    scope: "public",
    reason: "凭 refresh token 换新会话，access token 此时已过期",
  })
  @Post("refresh")
  @ApiOkResponse({
    type: AuthTokensDto,
    description: "token rotation：旧 refresh 立即失效",
  })
  @ApiOperation({
    description:
      "使用 Refresh Token 换取新的 Access Token 与 Refresh Token（token rotation）。旧 Refresh Token 立即失效。",
    summary: "刷新令牌",
  })
  @ApiResponse({
    status: 401,
    description: "Refresh Token 无效或已过期",
  })
  refreshToken(@Body() dto: RefreshTokenDto, @Req() req: Request) {
    // REFRESH-META（审计 P2）：把当前请求的 UA/IP 交给轮换，配合
    // AuthService 对「被消费那一行」的继承，保证会话列表的设备/来源列
    // 在多次轮换后仍然可读（此前轮换出的行恒为 null）。
    return this.authService.refreshToken(dto.refreshToken, requestMeta(req));
  }

  // SEC-02: logout revokes all refresh tokens for the current user
  @UseGuards(JwtAuthGuard)
  @WriteGuard("session", { scope: "authenticated" })
  @Post("logout")
  @ApiBearerAuth("JWT")
  @ApiOkResponse({ type: AuthLogoutDto })
  @ApiOperation({
    description:
      "登出当前用户并撤销其所有有效的 Refresh Token，防止令牌被重复使用。",
    summary: "登出（撤销全部 Refresh Token）",
  })
  @ApiResponse({ status: 401, description: "未认证" })
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

  // A5（DEEP_REVIEW §七 A5）：SSE 短效票据换取端点。
  // EventSource 不能带 Authorization 头，此前前端把 access token（15min）
  // 直接拼进 `?access_token=`；现在改为先经本端点（常规 bearer 头）换一枚
  // 30 秒有效、且只能在三条 /stream 路由上使用的专用票据。
  @UseGuards(JwtAuthGuard)
  @WriteGuard("sse-ticket", { scope: "authenticated" })
  @Post("sse-ticket")
  @ApiBearerAuth("JWT")
  @ApiOperation({
    description:
      "用当前会话换取一枚 30 秒有效、限定路径的票据，作为 SSE 流式路由上的 ?ticket= 使用（EventSource 无法设置请求头）。",
    summary: "签发短效 SSE 票据",
  })
  @ApiCreatedResponse({
    description: "票据已签发",
    type: SseTicketResponseDto,
  })
  @ApiResponse({ status: 401, description: "未认证" })
  issueSseTicket(@CurrentUser() user: AuthUser) {
    return this.authService.issueSseTicket(user);
  }

  @UseGuards(JwtAuthGuard)
  @Get("profile")
  @ApiBearerAuth("JWT")
  @ApiOperation({
    description: "返回当前登录用户的基本信息，包括 ID、用户名与角色。",
    summary: "获取当前用户信息",
  })
  @ApiOkResponse({
    type: AuthProfileDto,
    description: "AuthUser 原样（roles 不在 AuthUser——role 单值）",
  })
  @ApiResponse({ status: 401, description: "未认证" })
  getProfile(@CurrentUser() user: AuthUser) {
    return user;
  }

  // ─── SEC-03: TOTP two-factor auth ─────────────────────────────────────────

  /** SEC-03: stage a fresh TOTP secret; active only after a verified enable. */
  @UseGuards(JwtAuthGuard)
  @WriteGuard("account", { scope: "authenticated" })
  @Post("totp/setup")
  @ApiBearerAuth("JWT")
  @Throttle({ default: AUTH_THROTTLE })
  @ApiOperation({
    description:
      "生成 Base32 密钥与 otpauth:// URL，并以预登记（未启用）状态保存。用认证器中的有效验证码调用 POST /auth/totp/enable 即可启用。",
    summary: "预登记 TOTP 密钥（可选启用 2FA，第 1 步）",
  })
  @ApiResponse({
    status: 200,
    description: "已预登记的密钥 + otpauth URL",
    type: TotpSetupResponseDto,
  })
  @ApiResponse({ status: 400, description: "TOTP 已启用" })
  totpSetup(@CurrentUser() user: AuthUser) {
    return this.authService.totpSetup(user.id);
  }

  /** SEC-03: verify a code against the staged secret and activate 2FA. */
  @UseGuards(JwtAuthGuard)
  @WriteGuard("account", { scope: "authenticated" })
  @Post("totp/enable")
  @ApiBearerAuth("JWT")
  @Throttle({ default: AUTH_THROTTLE })
  @ApiOperation({
    description: "用预登记的密钥校验一个有效验证码，然后置 totpEnabled=true。",
    summary: "启用 TOTP（可选启用 2FA，第 2 步）",
  })
  @ApiResponse({
    status: 200,
    description: "TOTP 已启用",
    type: TotpEnableResponseDto,
  })
  @ApiResponse({ status: 400, description: "验证码错误，或没有预登记的密钥" })
  totpEnable(@CurrentUser() user: AuthUser, @Body() dto: TotpCodeDto) {
    return this.authService.totpEnable(user.id, dto.code);
  }

  /**
   * SEC-03: disable TOTP — requires password or a valid TOTP code so a
   * stolen access token alone cannot turn 2FA off.
   */
  @UseGuards(JwtAuthGuard)
  @WriteGuard("account", { scope: "authenticated" })
  @Post("totp/disable")
  @ApiBearerAuth("JWT")
  @Throttle({ default: AUTH_THROTTLE })
  @ApiOperation({
    description: "需要账户密码或有效的 TOTP 验证码作为确认。",
    summary: "停用 TOTP",
  })
  @ApiResponse({
    status: 200,
    description: "TOTP 已停用（或本来未启用）",
    type: TotpDisableResponseDto,
  })
  @ApiResponse({ status: 401, description: "确认失败" })
  // F-53（UIAUDIT P2-2）：body 换 class DTO——此前内联类型使全局
  // whitelist+forbidNonWhitelisted 对本面失效（多余字段静默收下）。
  totpDisable(
    @CurrentUser() user: AuthUser,
    @Body() dto: TotpDisableDto,
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
  @Throttle({ default: AUTH_THROTTLE })
  @Public()
  @WriteGuard("session", {
    scope: "public",
    reason: "登录第二步，凭 login 阶段签发的一次性 TOTP ticket",
  })
  @Post("totp/verify")
  @ApiOperation({
    description:
      "重新校验用户名+密码，验证 6 位 TOTP 验证码，并签发 accessToken/refreshToken。在 /auth/login 返回 { totpRequired: true } 之后调用。",
    summary: "完成 TOTP 登录（第二因子）",
  })
  @ApiResponse({ status: 401, description: "凭据或 TOTP 验证码错误" })
  @ApiOkResponse({
    type: AuthTokensDto,
    description: "双 token（二段登录成功）",
  })
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
    description:
      "每个活跃（未撤销、未过期）的 refresh token 一行。与调用者 access token 的 sid 声明匹配的那一行会标记 current=true。",
    summary: "列出我的活跃登录会话",
  })
  @ApiResponse({
    status: 200,
    description: "会话列表",
    type: [AuthSessionRowDto],
  })
  listSessions(@CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.authService.listSessions(user.id, sidOf(req));
  }

  /** SEC-03: revoke one of my sessions by refresh_tokens row id. */
  @UseGuards(JwtAuthGuard)
  @WriteGuard("session", { scope: "authenticated" })
  @Delete("sessions/:id")
  @ApiOkResponse({ type: SessionRevokeResponseDto })
  @ApiBearerAuth("JWT")
  @ApiOperation({
    description:
      "将指定的 refresh token 行标记为已撤销（DR-04 语义——该 refresh JWT 立即不可用）。会强制校验归属；传入他人的/已吊销的 id 返回 404。",
    summary: "撤销我的一个会话",
  })
  @ApiResponse({ status: 200, description: "会话已撤销" })
  // F-56（UIAUDIT 后端轮 P3-3）：错误语义归位——
  //   · id 形态非法 → 400 INVALID_VALUE_FORMAT（ParseIntShapePipe，与 users
  //     同源管道；此前返回 200 {success:false}，HTTP 成功/语义失败的双层
  //     解读与全站「错误必 4xx+errorCode」形态相悖）；
  //   · 不存在/不属于你 → 404（SESSION_NOT_FOUND 码，目录状态从 401 归位为
  //     404——该码只服务本撤销面，401 会触发 admin-web axios 拦截器的
  //     「会话过期」处理链（静默跳登录），把「吊销一条已死会话」放大成
  //     整页登出；归属反枚举不受影响：他人 id 与不存在 id 同形 404）。
  @ApiResponse({ status: 404, description: "会话不存在或已吊销" })
  async revokeSession(
    @Param("id", ParseIntShapePipe) id: number,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    await this.authService.revokeSession(user.id, id);
    await this.auditService
      .log({
        userId: user.id,
        username: user.username,
        action: "auth.session.revoke",
        resource: "auth",
        resourceId: String(id),
        ip: req.ip,
      })
      .catch((err: unknown) =>
        this.logger.warn(`audit log failed on session revoke: ${err}`),
      );
    return { success: true };
  }

  /** SEC-03: revoke every session of mine except the current one. */
  @UseGuards(JwtAuthGuard)
  @WriteGuard("session", { scope: "authenticated" })
  @Post("sessions/revoke-others")
  @ApiBearerAuth("JWT")
  @ApiOperation({
    description:
      "对其他设备做批量远程登出。若 access token 没有 sid 声明，则退化为撤销全部会话（故障安全策略：绝不保留未知会话）。",
    summary: "撤销除当前会话外我的全部会话",
  })
  @ApiResponse({
    status: 200,
    description: "撤销数量",
    type: RevokeOthersResponseDto,
  })
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
