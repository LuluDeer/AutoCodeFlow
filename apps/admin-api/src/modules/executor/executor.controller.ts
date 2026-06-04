import { Controller, Get, Post, Body, UseGuards, UnauthorizedException, Headers, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { ExecutorService } from './executor.service';

/** Verify the shared EXECUTOR_TOKEN sent by executor-node / executor-python.
 *  S5/S14: register and heartbeat are @Public (no JWT) but must carry the
 *  internal shared secret so arbitrary clients cannot spoof executor state.
 */
function verifyExecutorToken(authHeader: string | undefined, configService: ConfigService): void {
  const token = configService.get<string>('executor.sharedToken');
  if (!token) return; // token not configured -> skip check (dev mode)
  const provided = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  if (!provided || provided !== token) {
    throw new UnauthorizedException('Invalid executor token');
  }
}

@ApiTags('执行器')
@Controller('executors')
export class ExecutorController {
  constructor(
    private readonly svc: ExecutorService,
    private readonly configService: ConfigService,
  ) {}

  @Public()
  @Post('register')
  @ApiOperation({ summary: '执行器注册' })
  register(
    @Body() body: any,
    @Headers('authorization') auth: string,
  ) {
    verifyExecutorToken(auth, this.configService);
    return this.svc.register(body);
  }

  @Public()
  @Post('heartbeat')
  @ApiOperation({ summary: '心跳上报' })
  heartbeat(
    @Body() body: { address: string; cpuUsage?: number; memUsage?: number; runningTaskCount?: number },
    @Headers('authorization') auth: string,
  ) {
    verifyExecutorToken(auth, this.configService);
    return this.svc.heartbeat(body.address, body);
  }

  @ApiBearerAuth('JWT')
  @UseGuards(JwtAuthGuard)
  @Get()
  @ApiOperation({ summary: '执行器列表' })
  findAll() { return this.svc.findAll(); }

  // SEC-03: rotate per-executor token; returns new raw token (shown once)
  @ApiBearerAuth('JWT')
  @UseGuards(JwtAuthGuard)
  @Post(':id/rotate-token')
  @ApiOperation({ summary: '轮换执行器 Token（返回新 token，仅显示一次）' })
  rotateToken(@Param('id') id: string) {
    return this.svc.rotateToken(id);
  }
}
