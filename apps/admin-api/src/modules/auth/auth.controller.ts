import { Controller, Post, Body, Get, UseGuards, Req } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Request } from "express";
import { AuthService } from "./auth.service";
import { AuditService } from "../audit/audit.service";
import { LoginDto } from "./dto/login.dto";
import { RefreshTokenDto } from "./dto/refresh-token.dto";
import { Public } from "../../common/decorators/public.decorator";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";

@ApiTags("认证")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly auditService: AuditService,
  ) {}

  // N16: tightened to 5 attempts per 60s
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Public()
  @Post("login")
  @ApiOperation({
    summary: "用户登录",
    description:
      "使用用户名和密码登录，返回 Access Token 和 Refresh Token。每分钟最多尝试5次。",
  })
  @ApiResponse({
    status: 200,
    description: "登录成功，返回 accessToken 和 refreshToken",
    schema: { example: { accessToken: "eyJ...", refreshToken: "eyJ..." } },
  })
  @ApiResponse({ status: 401, description: "用户名或密码错误" })
  @ApiResponse({ status: 429, description: "请求过于频繁，触发限流" })
  async login(@Body() loginDto: LoginDto, @Req() req: Request) {
    const result = await this.authService.login(loginDto);
    await this.auditService
      .log({
        userId: (result as any).user?.id,
        username: loginDto.username,
        action: "auth.login",
        resource: "auth",
        ip: req.ip,
      })
      .catch(() => {});
    return result;
  }

  @Public()
  @Post("refresh")
  @ApiOperation({
    summary: "刷新 Token",
    description:
      "使用 Refresh Token 换取新的 Access Token 和 Refresh Token（Token 轮换）。旧 Refresh Token 立即失效。",
  })
  @ApiResponse({
    status: 200,
    description: "Token 刷新成功",
    schema: { example: { accessToken: "eyJ...", refreshToken: "eyJ..." } },
  })
  @ApiResponse({ status: 401, description: "Refresh Token 无效或已过期" })
  refreshToken(@Body() dto: RefreshTokenDto) {
    return this.authService.refreshToken(dto.refreshToken);
  }

  // SEC-02: logout revokes all refresh tokens for the current user
  @UseGuards(JwtAuthGuard)
  @Post("logout")
  @ApiBearerAuth("JWT")
  @ApiOperation({
    summary: "登出（吊销所有 Refresh Token）",
    description:
      "登出当前用户，吊销该用户所有有效的 Refresh Token，防止 Token 被复用。",
  })
  @ApiResponse({
    status: 200,
    description: "登出成功",
    schema: { example: { success: true } },
  })
  @ApiResponse({ status: 401, description: "未认证" })
  async logout(@CurrentUser() user: any, @Req() req: Request) {
    await this.authService.revokeAllForUser(user.id);
    await this.auditService
      .log({
        userId: user.id,
        username: user.username,
        action: "auth.logout",
        resource: "auth",
        ip: req.ip,
      })
      .catch(() => {});
    return { success: true };
  }

  @UseGuards(JwtAuthGuard)
  @Get("profile")
  @ApiBearerAuth("JWT")
  @ApiOperation({
    summary: "获取当前用户信息",
    description: "返回当前登录用户的基本信息，包括 ID、用户名和权限等。",
  })
  @ApiResponse({
    status: 200,
    description: "用户信息",
    schema: { example: { id: 1, username: "admin", roles: ["admin"] } },
  })
  @ApiResponse({ status: 401, description: "未认证" })
  getProfile(@CurrentUser() user: any) {
    return user;
  }
}
