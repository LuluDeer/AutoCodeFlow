import { Controller, Get, Post, Body, Patch, Param, Delete, Query, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
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
  @ApiOperation({ summary: '创建任务' })
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
  @ApiOperation({ summary: '任务列表' })
  findAll(@Query() p: PaginationDto) {
    return this.taskService.findAll(p);
  }

  @Get(':id')
  @ApiOperation({ summary: '任务详情' })
  findOne(@Param('id') id: string) {
    return this.taskService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新任务' })
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
  @ApiOperation({ summary: '删除任务' })
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
  @ApiOperation({ summary: '手动触发' })
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
  @ApiOperation({ summary: '执行记录' })
  executions(@Param('id') id: string, @Query() p: PaginationDto) {
    return this.taskService.getExecutions(id, p);
  }

  @Get(':id/executions/:execId')
  @ApiOperation({ summary: '执行详情' })
  execution(@Param('execId') execId: string) {
    return this.taskService.getExecution(execId);
  }

  @Post(':id/rollback')
  @ApiOperation({ summary: '一键回滚到指定 commit' })
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
}
