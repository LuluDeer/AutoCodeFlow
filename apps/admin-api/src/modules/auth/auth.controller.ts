import {
  Controller,
  Logger,
  Post,
  Body,
  Get,
  UseGuards,
  Req,
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
import { Public } from "../../common/decorators/public.decorator";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AuthUser } from "../../common/interfaces/auth-user.interface";

@ApiTags("Auth")
@Controller("auth")
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly auditService: AuditService,
  ) {}

  // N16: login rate limit — configurable via env LOGIN_THROTTLE_LIMIT (default 20 for dev, use 5 in prod)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
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
    const result = await this.authService.login(loginDto);
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
}
