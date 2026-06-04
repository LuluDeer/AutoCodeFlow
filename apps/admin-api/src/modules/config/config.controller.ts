import {
  Controller, Get, Put, Delete,
  Param, Body, UseGuards, Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SystemConfigService } from './config.service';
import { UpsertConfigDto } from './dto/upsert-config.dto';
import { AuditService } from '../audit/audit.service';

@ApiTags('系统配置')
@ApiBearerAuth('JWT')
@UseGuards(JwtAuthGuard)
@Controller('config')
export class ConfigController {
  constructor(
    private readonly configService: SystemConfigService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: '获取所有配置项' })
  findAll() {
    return this.configService.findAll();
  }

  @Get(':key')
  @ApiOperation({ summary: '获取单个配置项' })
  findOne(@Param('key') key: string) {
    return this.configService.findOne(key);
  }

  @Put()
  @ApiOperation({ summary: '新增或更新配置项' })
  async upsert(@Body() dto: UpsertConfigDto, @CurrentUser() user: any, @Req() req: Request) {
    const result = await this.configService.upsert(dto);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: 'config.upsert',
      resource: 'config',
      resourceId: dto.key,
      ip: req.ip,
    });
    return result;
  }

  @Delete(':key')
  @ApiOperation({ summary: '删除配置项' })
  async remove(@Param('key') key: string, @CurrentUser() user: any, @Req() req: Request) {
    const result = await this.configService.remove(key);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: 'config.delete',
      resource: 'config',
      resourceId: key,
      ip: req.ip,
    });
    return result;
  }
}
