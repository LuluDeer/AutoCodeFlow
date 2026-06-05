import { Controller, Get, Post, Body, Patch, Param, Delete, Query, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse, ApiParam, ApiQuery, ApiBody } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TaskService } from './task.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { TriggerTaskDto } from './dto/trigger-task.dto';
import { RollbackTaskDto } from './dto/rollback-task.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { AuditService } from '../audit/audit.service';

@ApiTags('任务管理')
@ApiBearerAuth('JWT')
@UseGuards(JwtAuthGuard)
@Controller('tasks')
export class TaskController {
  constructor(
    private readonly taskService: TaskService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @ApiOperation({ 
    summary: '创建任务', 
    description: '创建一个新的自动化任务，支持定时调度、Webhook触发和事件触发三种模式。任务创建后默认处于暂停状态，需要手动触发或等待定时触发。'
  })
  @ApiResponse({ 
    status: 201, 
    description: '任务创建成功',
    schema: {
      example: {
        code: 200,
        message: 'success',
        data: {
          id: 'task-uuid',
          name: '数据同步任务',
          description: '每天凌晨同步数据库数据',
          type: 'cron',
          schedule: '0 0 * * *',
          status: 'paused',
          createdAt: '2024-01-01T12:00:00Z'
        }
      }
    }
  })
  async create(@Body() dto: CreateTaskDto, @CurrentUser() user: any, @Req() req: Request) {
    const result = await this.taskService.create(dto);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: 'task.create',
      resource: 'task',
      resourceId: result.id,
      ip: req.ip,
    });
    return result;
  }

  @Get()
  @ApiOperation({ 
    summary: '任务列表', 
    description: '获取任务列表，支持分页和搜索。可通过状态筛选任务。'
  })
  @ApiQuery({ name: 'page', required: false, description: '页码，默认1' })
  @ApiQuery({ name: 'limit', required: false, description: '每页数量，默认20' })
  @ApiQuery({ name: 'status', required: false, description: '任务状态过滤' })
  @ApiQuery({ name: 'keyword', required: false, description: '关键词搜索' })
  @ApiResponse({ 
    status: 200, 
    description: '任务列表',
    schema: {
      example: {
        code: 200,
        message: 'success',
        data: {
          items: [],
          total: 10,
          page: 1,
          limit: 20
        }
      }
    }
  })
  findAll(@Query() p: PaginationDto) {
    return this.taskService.findAll(p);
  }

  @Get(':id')
  @ApiOperation({ 
    summary: '任务详情', 
    description: '获取单个任务的详细信息，包括配置、状态和执行统计。'
  })
  @ApiParam({ name: 'id', description: '任务ID' })
  @ApiResponse({ status: 404, description: '任务不存在' })
  findOne(@Param('id') id: string) {
    return this.taskService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ 
    summary: '更新任务', 
    description: '更新任务配置。注意：正在执行中的任务不会立即应用新配置。'
  })
  @ApiParam({ name: 'id', description: '任务ID' })
  @ApiResponse({ status: 404, description: '任务不存在' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateTaskDto,
    @CurrentUser() user: any,
    @Req() req: Request,
  ) {
    const result = await this.taskService.update(id, dto);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: 'task.update',
      resource: 'task',
      resourceId: id,
      ip: req.ip,
    });
    return result;
  }

  @Delete(':id')
  @ApiOperation({ 
    summary: '删除任务', 
    description: '删除指定任务。正在执行中的任务会被强制终止。'
  })
  @ApiParam({ name: 'id', description: '任务ID' })
  @ApiResponse({ status: 404, description: '任务不存在' })
  async remove(@Param('id') id: string, @CurrentUser() user: any, @Req() req: Request) {
    const result = await this.taskService.remove(id);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: 'task.delete',
      resource: 'task',
      resourceId: id,
      ip: req.ip,
    });
    return result;
  }

  @Post(':id/trigger')
  @ApiOperation({ 
    summary: '手动触发', 
    description: '手动触发任务执行。可以传递自定义参数覆盖任务默认参数。'
  })
  @ApiParam({ name: 'id', description: '任务ID' })
  @ApiResponse({ 
    status: 200, 
    description: '触发成功',
    schema: {
      example: {
        code: 200,
        message: 'success',
        data: {
          taskId: 'task-uuid',
          executionId: 'exec-uuid',
          status: 'pending'
        }
      }
    }
  })
  async trigger(
    @Param('id') id: string,
    @Body() dto: TriggerTaskDto,
    @CurrentUser() user: any,
    @Req() req: Request,
  ) {
    const result = await this.taskService.trigger(id, dto);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: 'task.trigger',
      resource: 'task',
      resourceId: id,
      ip: req.ip,
    });
    return result;
  }

  @Get(':id/executions')
  @ApiOperation({ 
    summary: '执行记录', 
    description: '获取任务的执行历史记录列表。'
  })
  @ApiParam({ name: 'id', description: '任务ID' })
  @ApiQuery({ name: 'page', required: false, description: '页码' })
  @ApiQuery({ name: 'limit', required: false, description: '每页数量' })
  @ApiQuery({ name: 'status', required: false, description: '执行状态过滤' })
  executions(@Param('id') id: string, @Query() p: PaginationDto) {
    return this.taskService.getExecutions(id, p);
  }

  @Get(':id/executions/:execId')
  @ApiOperation({ 
    summary: '执行详情', 
    description: '获取单次执行的详细信息，包括执行时间、状态、输出结果等。'
  })
  @ApiParam({ name: 'id', description: '任务ID' })
  @ApiParam({ name: 'execId', description: '执行记录ID' })
  @ApiResponse({ status: 404, description: '执行记录不存在' })
  execution(@Param('execId') execId: string) {
    return this.taskService.getExecution(execId);
  }

  @Get(':id/executions/:execId/logs')
  @ApiOperation({ 
    summary: '执行日志', 
    description: '获取执行日志，支持按行分页加载，避免大日志占用过多内存。'
  })
  @ApiParam({ name: 'id', description: '任务ID' })
  @ApiParam({ name: 'execId', description: '执行记录ID' })
  @ApiQuery({ name: 'fromLine', required: false, description: '起始行号，默认0' })
  executionLogs(
    @Param('execId') execId: string,
    @Query('fromLine') fromLine?: string,
  ) {
    return this.taskService.getExecutionLogs(execId, fromLine ? parseInt(fromLine, 10) : 0);
  }

  @Post(':id/rollback')
  @ApiOperation({ 
    summary: '一键回滚', 
    description: '将任务回滚到指定的Git commit版本。仅适用于Git类型的任务。'
  })
  @ApiParam({ name: 'id', description: '任务ID' })
  @ApiBody({ 
    description: '回滚参数',
    schema: {
      example: {
        gitCommit: 'abc123',
        message: '回滚到稳定版本'
      }
    }
  })
  @ApiResponse({ status: 400, description: '非Git类型任务不支持回滚' })
  async rollback(
    @Param('id') id: string,
    @Body() dto: RollbackTaskDto,
    @CurrentUser() user: any,
    @Req() req: Request,
  ) {
    const result = await this.taskService.rollback(id, dto);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: 'task.rollback',
      resource: 'task',
      resourceId: id,
      detail: { gitCommit: dto.gitCommit },
      ip: req.ip,
    });
    return result;
  }

  @Post(':id/pause')
  @ApiOperation({ 
    summary: '暂停任务', 
    description: '暂停任务的定时调度和触发。已提交的执行任务不受影响。'
  })
  @ApiParam({ name: 'id', description: '任务ID' })
  @ApiResponse({ status: 400, description: '任务已处于暂停状态' })
  async pause(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Req() req: Request,
  ) {
    const result = await this.taskService.pause(id);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: 'task.pause',
      resource: 'task',
      resourceId: id,
      ip: req.ip,
    });
    return result;
  }

  @Post(':id/resume')
  @ApiOperation({ 
    summary: '恢复任务', 
    description: '恢复任务的定时调度和触发。'
  })
  @ApiParam({ name: 'id', description: '任务ID' })
  @ApiResponse({ status: 400, description: '任务已处于运行状态' })
  async resume(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Req() req: Request,
  ) {
    const result = await this.taskService.resume(id);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: 'task.resume',
      resource: 'task',
      resourceId: id,
      ip: req.ip,
    });
    return result;
  }

  @Post('batch/trigger')
  @ApiOperation({ 
    summary: '批量触发任务', 
    description: '批量触发多个任务执行。部分任务失败不会影响其他任务。'
  })
  @ApiBody({ 
    description: '批量触发参数',
    schema: {
      example: {
        taskIds: ['task1', 'task2', 'task3']
      }
    }
  })
  async batchTrigger(
    @Body() body: { taskIds: string[] },
    @CurrentUser() user: any,
    @Req() req: Request,
  ) {
    const results = await Promise.all(
      body.taskIds.map(id => this.taskService.trigger(id, {}).catch(err => ({ id, error: err.message }))),
    );
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: 'task.batch_trigger',
      resource: 'task',
      detail: { taskIds: body.taskIds },
      ip: req.ip,
    });
    return results;
  }

  @Post('batch/pause')
  @ApiOperation({ 
    summary: '批量暂停任务', 
    description: '批量暂停多个任务。部分任务失败不会影响其他任务。'
  })
  @ApiBody({ 
    description: '批量暂停参数',
    schema: {
      example: {
        taskIds: ['task1', 'task2', 'task3']
      }
    }
  })
  async batchPause(
    @Body() body: { taskIds: string[] },
    @CurrentUser() user: any,
    @Req() req: Request,
  ) {
    const results = await Promise.all(
      body.taskIds.map(id => this.taskService.pause(id).catch(err => ({ id, error: err.message }))),
    );
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: 'task.batch_pause',
      resource: 'task',
      detail: { taskIds: body.taskIds },
      ip: req.ip,
    });
    return results;
  }

  @Post('batch/resume')
  @ApiOperation({ 
    summary: '批量恢复任务', 
    description: '批量恢复多个任务。部分任务失败不会影响其他任务。'
  })
  @ApiBody({ 
    description: '批量恢复参数',
    schema: {
      example: {
        taskIds: ['task1', 'task2', 'task3']
      }
    }
  })
  async batchResume(
    @Body() body: { taskIds: string[] },
    @CurrentUser() user: any,
    @Req() req: Request,
  ) {
    const results = await Promise.all(
      body.taskIds.map(id => this.taskService.resume(id).catch(err => ({ id, error: err.message }))),
    );
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: 'task.batch_resume',
      resource: 'task',
      detail: { taskIds: body.taskIds },
      ip: req.ip,
    });
    return results;
  }

  @Post('batch/delete')
  @ApiOperation({ 
    summary: '批量删除任务', 
    description: '批量删除多个任务。部分任务失败不会影响其他任务。'
  })
  @ApiBody({ 
    description: '批量删除参数',
    schema: {
      example: {
        taskIds: ['task1', 'task2', 'task3']
      }
    }
  })
  async batchDelete(
    @Body() body: { taskIds: string[] },
    @CurrentUser() user: any,
    @Req() req: Request,
  ) {
    const results = await Promise.all(
      body.taskIds.map(id => this.taskService.remove(id).catch(err => ({ id, error: err.message }))),
    );
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: 'task.batch_delete',
      resource: 'task',
      detail: { taskIds: body.taskIds },
      ip: req.ip,
    });
    return results;
  }
}
