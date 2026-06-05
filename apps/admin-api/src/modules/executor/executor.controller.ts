import { Controller, Get, Post, Body, UseGuards, UnauthorizedException, Headers, Param, Patch, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse, ApiParam, ApiBody, ApiQuery } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { ExecutorService } from './executor.service';
import axios from 'axios';
import { PaginationDto } from '../../common/dto/pagination.dto';

function verifyExecutorToken(authHeader: string | undefined, configService: ConfigService): void {
  const token = configService.get<string>('executor.sharedToken');
  const nodeEnv = configService.get<string>('app.nodeEnv');
  
  if (nodeEnv === 'production' && !token) {
    throw new UnauthorizedException('Executor authentication is required in production');
  }
  
  if (!token) return;
  
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
  @ApiOperation({ 
    summary: '执行器注册', 
    description: '执行器启动时调用此接口注册到管理后台。需要携带共享令牌进行认证。'
  })
  @ApiBody({ 
    description: '注册信息',
    schema: {
      example: {
        address: '192.168.1.100:3002',
        appName: 'executor-node',
        groupName: 'production',
        tags: ['nodejs', 'prod'],
        description: '生产环境 Node.js 执行器'
      }
    }
  })
  @ApiResponse({ 
    status: 200, 
    description: '注册成功',
    schema: {
      example: {
        code: 200,
        message: 'success',
        data: {
          id: 'exec-uuid',
          address: '192.168.1.100:3002',
          appName: 'executor-node',
          status: 'online'
        }
      }
    }
  })
  register(
    @Body() body: any,
    @Headers('authorization') auth: string,
  ) {
    verifyExecutorToken(auth, this.configService);
    return this.svc.register(body);
  }

  @Public()
  @Post('heartbeat')
  @ApiOperation({ 
    summary: '心跳上报', 
    description: '执行器定期调用此接口上报状态。包含 CPU 使用率、内存使用率和运行中任务数。'
  })
  @ApiBody({ 
    description: '心跳数据',
    schema: {
      example: {
        address: '192.168.1.100:3002',
        cpuUsage: 45.5,
        memUsage: 62.3,
        runningTaskCount: 3
      }
    }
  })
  @ApiResponse({ status: 401, description: '无效的执行器令牌' })
  async heartbeat(
    @Body() body: { address: string; cpuUsage?: number; memUsage?: number; runningTaskCount?: number },
    @Headers('authorization') auth: string,
  ) {
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : auth;
    const isValid = await this.svc.validateTokenByAddress(body.address, token);
    if (!isValid) {
      throw new UnauthorizedException('Invalid executor token');
    }
    return this.svc.heartbeat(body.address, body);
  }

  @ApiBearerAuth('JWT')
  @UseGuards(JwtAuthGuard)
  @Get()
  @ApiOperation({ 
    summary: '执行器列表', 
    description: '获取所有执行器的列表，包含在线状态、分组、标签等信息。'
  })
  @ApiResponse({ 
    status: 200, 
    description: '执行器列表',
    schema: {
      example: {
        code: 200,
        message: 'success',
        data: []
      }
    }
  })
  findAll() { return this.svc.findAll(); }

  @ApiBearerAuth('JWT')
  @UseGuards(JwtAuthGuard)
  @Get('groups')
  @ApiOperation({ 
    summary: '获取所有执行器分组', 
    description: '获取系统中所有执行器分组及其执行器数量统计。'
  })
  @ApiResponse({ 
    status: 200, 
    description: '分组列表',
    schema: {
      example: {
        code: 200,
        message: 'success',
        data: [
          { name: 'production', count: 5, onlineCount: 4 },
          { name: 'staging', count: 2, onlineCount: 2 }
        ]
      }
    }
  })
  getGroups() { return this.svc.getGroups(); }

  @ApiBearerAuth('JWT')
  @UseGuards(JwtAuthGuard)
  @Get('tags')
  @ApiOperation({ 
    summary: '获取所有执行器标签', 
    description: '获取系统中所有执行器使用的标签及其统计。'
  })
  @ApiResponse({ 
    status: 200, 
    description: '标签列表',
    schema: {
      example: {
        code: 200,
        message: 'success',
        data: [
          { name: 'nodejs', count: 3 },
          { name: 'python', count: 2 }
        ]
      }
    }
  })
  getTags() { return this.svc.getTags(); }

  @ApiBearerAuth('JWT')
  @UseGuards(JwtAuthGuard)
  @Get(':id')
  @ApiOperation({ 
    summary: '获取单个执行器详情', 
    description: '获取指定执行器的详细信息，包括配置、状态、性能指标等。'
  })
  @ApiParam({ name: 'id', description: '执行器ID' })
  @ApiResponse({ status: 404, description: '执行器不存在' })
  findOne(@Param('id') id: string) {
    return this.svc.findOne(id);
  }

  @ApiBearerAuth('JWT')
  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  @ApiOperation({ 
    summary: '更新执行器元数据', 
    description: '更新执行器的分组、标签、描述和最大并发任务数。'
  })
  @ApiParam({ name: 'id', description: '执行器ID' })
  @ApiBody({ 
    description: '更新参数',
    schema: {
      example: {
        groupName: 'production',
        tags: ['nodejs', 'prod'],
        description: '生产环境执行器',
        maxConcurrentTasks: 10
      }
    }
  })
  @ApiResponse({ status: 404, description: '执行器不存在' })
  update(
    @Param('id') id: string,
    @Body() body: {
      groupName?: string | null;
      tags?: string[] | null;
      description?: string | null;
      maxConcurrentTasks?: number | null;
    },
  ) {
    return this.svc.update(id, body);
  }

  @ApiBearerAuth('JWT')
  @UseGuards(JwtAuthGuard)
  @Post(':id/reload-config')
  @ApiOperation({ 
    summary: '向执行器推送配置热更新', 
    description: '动态更新执行器的配置参数，无需重启执行器。执行器必须处于在线状态。'
  })
  @ApiParam({ name: 'id', description: '执行器ID' })
  @ApiBody({ 
    description: '配置参数',
    schema: {
      example: {
        maxConcurrentTasks: 10,
        taskTimeoutSeconds: 300,
        heartbeatIntervalSeconds: 30,
        adminApiUrl: 'http://admin-api:3001'
      }
    }
  })
  @ApiResponse({ status: 400, description: '执行器离线' })
  async reloadConfig(
    @Param('id') id: string,
    @Body() body: {
      maxConcurrentTasks?: number;
      taskTimeoutSeconds?: number;
      heartbeatIntervalSeconds?: number;
      adminApiUrl?: string;
    },
  ) {
    const executor = await this.svc.findOne(id);
    if (executor.status !== 'online') {
      throw new UnauthorizedException('Executor is offline');
    }
    const token = await this.svc.rotateToken(id);
    const headers = { Authorization: `Bearer ${token.token}` };
    const url = this.svc.getExecutorUrl(executor.address, 'api/config/reload');
    const resp = await axios.post(url, body, { headers, timeout: 10_000 });
    return resp.data;
  }

  @ApiBearerAuth('JWT')
  @UseGuards(JwtAuthGuard)
  @Post(':id/rotate-token')
  @ApiOperation({ 
    summary: '轮换执行器 Token', 
    description: '生成新的执行器认证令牌。新令牌仅在此响应中显示一次，请妥善保存。'
  })
  @ApiParam({ name: 'id', description: '执行器ID' })
  @ApiResponse({ 
    status: 200, 
    description: 'Token 轮换成功',
    schema: {
      example: {
        code: 200,
        message: 'success',
        data: {
          token: 'new-token-value',
          expiresAt: '2024-01-01T12:00:00Z'
        }
      }
    }
  })
  rotateToken(@Param('id') id: string) {
    return this.svc.rotateToken(id);
  }

  @Public()
  @Post('token')
  @ApiOperation({ 
    summary: '获取动态 Token', 
    description: '执行器调用此接口获取动态令牌。使用共享令牌进行初始认证，返回周期性过期的动态令牌。'
  })
  @ApiBody({ 
    description: '获取Token参数',
    schema: {
      example: {
        address: '192.168.1.100:3002',
        appName: 'executor-node'
      }
    }
  })
  @ApiResponse({ status: 401, description: '无效的共享令牌' })
  async getToken(
    @Body() body: { address: string; appName?: string },
    @Headers('authorization') auth: string,
  ) {
    verifyExecutorToken(auth, this.configService);
    
    const executor = await this.svc.register({
      address: body.address,
      appName: body.appName || 'executor',
    });
    
    return this.svc.rotateToken(executor.id);
  }

  @Public()
  @Post('offline')
  @ApiOperation({ 
    summary: '执行器离线通知', 
    description: '执行器优雅停机时调用此接口通知管理后台，标记执行器为离线状态。'
  })
  @ApiBody({ 
    description: '离线参数',
    schema: {
      example: {
        address: '192.168.1.100:3002'
      }
    }
  })
  @ApiResponse({ status: 401, description: '无效的执行器令牌' })
  async offline(
    @Body() body: { address: string },
    @Headers('authorization') auth: string,
  ) {
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : auth;
    const isValid = await this.svc.validateTokenByAddress(body.address, token);
    if (!isValid) {
      throw new UnauthorizedException('Invalid executor token');
    }
    
    await this.svc.markOffline(body.address);
    return { success: true };
  }

  @ApiBearerAuth('JWT')
  @UseGuards(JwtAuthGuard)
  @Get(':id/executions')
  @ApiOperation({ 
    summary: '获取执行器的历史任务执行记录', 
    description: '获取指定执行器执行过的所有任务记录，支持分页。'
  })
  @ApiParam({ name: 'id', description: '执行器ID' })
  @ApiQuery({ name: 'page', required: false, description: '页码' })
  @ApiQuery({ name: 'limit', required: false, description: '每页数量' })
  getExecutorExecutions(@Param('id') id: string, @Query() p: PaginationDto) {
    return this.svc.getExecutorExecutions(id, p);
  }

  @ApiBearerAuth('JWT')
  @UseGuards(JwtAuthGuard)
  @Get(':id/metrics')
  @ApiOperation({ 
    summary: '获取执行器的性能指标', 
    description: '获取执行器最近7天的性能指标，包括总执行次数、成功率、平均执行时间等。'
  })
  @ApiParam({ name: 'id', description: '执行器ID' })
  @ApiResponse({ 
    status: 200, 
    description: '性能指标',
    schema: {
      example: {
        code: 200,
        message: 'success',
        data: {
          totalExecutions: 1000,
          successRate: 98.5,
          avgDurationMs: 1250,
          maxDurationMs: 5000,
          minDurationMs: 100,
          dateRange: '2024-01-01 to 2024-01-07'
        }
      }
    }
  })
  getExecutorMetrics(@Param('id') id: string) {
    return this.svc.getExecutorMetrics(id);
  }
}
