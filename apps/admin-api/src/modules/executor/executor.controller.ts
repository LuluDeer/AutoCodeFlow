import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { ExecutorService } from './executor.service';

@ApiTags('执行器')
@Controller('executors')
export class ExecutorController {
  constructor(private readonly svc: ExecutorService) {}

  @Public()
  @Post('register')
  @ApiOperation({ summary: '执行器注册' })
  register(@Body() body: any) { return this.svc.register(body); }

  @Public()
  @Post('heartbeat')
  @ApiOperation({ summary: '心跳上报' })
  heartbeat(@Body() body: { address: string; cpuUsage?: number; memUsage?: number; runningTaskCount?: number }) {
    return this.svc.heartbeat(body.address, body);
  }

  @ApiBearerAuth('JWT')
  @UseGuards(JwtAuthGuard)
  @Get()
  @ApiOperation({ summary: '执行器列表' })
  findAll() { return this.svc.findAll(); }
}
