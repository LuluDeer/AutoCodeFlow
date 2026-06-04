import { Controller, Post, Body, Get, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { AuditService } from '../audit/audit.service';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { Public } from '../../common/decorators/public.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('认证')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly auditService: AuditService,
  ) {}

  // N16: tightened to 5 attempts per 60s
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Public()
  @Post('login')
  @ApiOperation({ summary: '用户登录' })
  async login(@Body() loginDto: LoginDto, @Req() req: Request) {
    const result = await this.authService.login(loginDto);
    await this.auditService.log({
      userId: (result as any).user?.id,
      username: loginDto.username,
      action: 'auth.login',
      resource: 'auth',
      ip: req.ip,
    }).catch(() => {});
    return result;
  }

  @Public()
  @Post('refresh')
  @ApiOperation({ summary: '刷新 Token' })
  refreshToken(@Body() dto: RefreshTokenDto) {
    return this.authService.refreshToken(dto.refreshToken);
  }

  // SEC-02: logout revokes all refresh tokens for the current user
  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: '登出（吊销所有 Refresh Token）' })
  async logout(@CurrentUser() user: any, @Req() req: Request) {
    await this.authService.revokeAllForUser(user.id);
    await this.auditService.log({
      userId: user.id,
      username: user.username,
      action: 'auth.logout',
      resource: 'auth',
      ip: req.ip,
    }).catch(() => {});
    return { success: true };
  }

  @UseGuards(JwtAuthGuard)
  @Get('profile')
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: '获取当前用户信息' })
  getProfile(@CurrentUser() user: any) {
    return user;
  }
}
