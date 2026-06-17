import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Put,
  Param,
  Delete,
  Query,
  UseGuards,
  Req,
  Res,
} from "@nestjs/common";
import { Response } from "express";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBody,
} from "@nestjs/swagger";
import { Request } from "express";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AuthUser } from "../../common/interfaces/auth-user.interface";
import { TaskService } from "./task.service";
import { CreateTaskDto } from "./dto/create-task.dto";
import { UpdateTaskDto } from "./dto/update-task.dto";
import { TriggerTaskDto } from "./dto/trigger-task.dto";
import { RollbackTaskDto } from "./dto/rollback-task.dto";
import { BatchTaskIdsDto } from "./dto/batch-task.dto";
import { PaginationDto } from "../../common/dto/pagination.dto";
import { AuditService } from "../audit/audit.service";

@ApiTags("Task Management")
@ApiBearerAuth("JWT")
@UseGuards(JwtAuthGuard)
@Controller("tasks")
export class TaskController {
  constructor(
    private readonly taskService: TaskService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @ApiOperation({
    summary: "Create task",
    description:
      "Create a new automation task. Supports cron, webhook, and event trigger modes. Tasks start in paused state.",
  })
  @ApiResponse({
    status: 201,
    description: "Task created successfully",
    schema: {
      example: {
        code: 200,
        message: "success",
        data: {
          id: "task-uuid",
          name: "Data sync task",
          description: "Sync database data at midnight daily",
          type: "cron",
          schedule: "0 0 * * *",
          status: "paused",
          createdAt: "2024-01-01T12:00:00Z",
        },
      },
    },
  })
  async create(
    @Body() dto: CreateTaskDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const result = await this.taskService.create(dto);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "task.create",
      resource: "task",
      resourceId: result.id,
      ip: req.ip,
    });
    return result;
  }

  @Get()
  @ApiOperation({
    summary: "List tasks",
    description: "Get task list with pagination and search support. Filter by status.",
  })
  @ApiQuery({ name: "page", required: false, description: "Page number, default 1" })
  @ApiQuery({ name: "pageSize", required: false, description: "Page size, default 20" })
  @ApiQuery({ name: "status", required: false, description: "Filter by status (active/paused/inactive)" })
  @ApiQuery({ name: "name", required: false, description: "Fuzzy search by task name" })
  @ApiQuery({ name: "runtime", required: false, description: "Filter by runtime (python/node/shell)" })
  @ApiResponse({
    status: 200,
    description: "Task list",
    schema: {
      example: {
        code: 200,
        message: "success",
        data: {
          items: [],
          total: 10,
          page: 1,
          limit: 20,
        },
      },
    },
  })
  findAll(@Query() p: PaginationDto) {
    return this.taskService.findAll(p);
  }

  @Post("batch/trigger")
  @ApiOperation({
    summary: "Batch trigger tasks",
    description: "Trigger multiple tasks. Partial failures do not affect other tasks.",
  })
  @ApiResponse({ status: 200, description: "Batch trigger results" })
  @ApiBody({
    description: "Batch trigger parameters",
    schema: {
      example: {
        taskIds: ["task1", "task2", "task3"],
      },
    },
  })
  async batchTrigger(
    @Body() body: BatchTaskIdsDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const results = await Promise.all(
      body.taskIds.map((id) =>
        this.taskService
          .trigger(id, {})
          .catch((err) => ({ id, error: err.message })),
      ),
    );
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "task.batch_trigger",
      resource: "task",
      detail: { taskIds: body.taskIds },
      ip: req.ip,
    });
    return results;
  }

  @Post("batch/pause")
  @ApiOperation({
    summary: "Batch pause tasks",
    description: "Pause multiple tasks. Partial failures do not affect other tasks.",
  })
  @ApiResponse({ status: 200, description: "Batch pause results" })
  @ApiBody({
    description: "Batch pause parameters",
    schema: {
      example: {
        taskIds: ["task1", "task2", "task3"],
      },
    },
  })
  async batchPause(
    @Body() body: BatchTaskIdsDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const results = await Promise.all(
      body.taskIds.map((id) =>
        this.taskService.pause(id).catch((err) => ({ id, error: err.message })),
      ),
    );
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "task.batch_pause",
      resource: "task",
      detail: { taskIds: body.taskIds },
      ip: req.ip,
    });
    return results;
  }

  @Post("batch/resume")
  @ApiOperation({
    summary: "Batch resume tasks",
    description: "Resume multiple tasks. Partial failures do not affect other tasks.",
  })
  @ApiResponse({ status: 200, description: "Batch resume results" })
  @ApiBody({
    description: "Batch resume parameters",
    schema: {
      example: {
        taskIds: ["task1", "task2", "task3"],
      },
    },
  })
  async batchResume(
    @Body() body: BatchTaskIdsDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const results = await Promise.all(
      body.taskIds.map((id) =>
        this.taskService
          .resume(id)
          .catch((err) => ({ id, error: err.message })),
      ),
    );
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "task.batch_resume",
      resource: "task",
      detail: { taskIds: body.taskIds },
      ip: req.ip,
    });
    return results;
  }

  @Post("batch/delete")
  @ApiOperation({
    summary: "Batch delete tasks",
    description: "Delete multiple tasks. Partial failures do not affect other tasks.",
  })
  @ApiResponse({ status: 200, description: "Batch delete results" })
  @ApiBody({
    description: "Batch delete parameters",
    schema: {
      example: {
        taskIds: ["task1", "task2", "task3"],
      },
    },
  })
  async batchDelete(
    @Body() body: BatchTaskIdsDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const results = await Promise.all(
      body.taskIds.map((id) =>
        this.taskService
          .remove(id)
          .catch((err) => ({ id, error: err.message })),
      ),
    );
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "task.batch_delete",
      resource: "task",
      detail: { taskIds: body.taskIds },
      ip: req.ip,
    });
    return results;
  }

  @Get("executions/all")
  @ApiOperation({ summary: "Global execution records" })
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "pageSize", required: false })
  @ApiQuery({ name: "status", required: false })
  @ApiQuery({ name: "taskId", required: false })
  @ApiQuery({ name: "startTime", required: false })
  @ApiQuery({ name: "endTime", required: false })
  allExecutions(
    @Query()
    p: PaginationDto & {
      status?: string;
      taskId?: string;
      startTime?: string;
      endTime?: string;
    },
  ) {
    return this.taskService.getAllExecutions(p);
  }

  @Get("scheduler/stats")
  @ApiOperation({ summary: "Scheduler status" })
  async schedulerStats() {
    return this.taskService.getSchedulerStats();
  }

  @Get(":id/stats")
  @ApiOperation({
    summary: "Task execution stats",
    description: "Get execution statistics for a task: success rate, average duration, and last 20 executions.",
  })
  @ApiParam({ name: "id", description: "Task ID" })
  getStats(@Param("id") id: string) {
    return this.taskService.getExecutionStats(id);
  }

  @Post(":id/suggest-schedule")
  @ApiOperation({
    summary: "AI schedule suggestion",
    description: "Analyze execution history and return an AI-recommended cron expression with reasoning",
  })
  @ApiParam({ name: "id", description: "Task ID" })
  async suggestSchedule(@Param("id") id: string) {
    return this.taskService.suggestSchedule(id);
  }

  @Get(":id")
  @ApiOperation({
    summary: "Task details",
    description: "Get detailed info for a single task including config, status, and execution stats.",
  })
  @ApiParam({ name: "id", description: "Task ID" })
  @ApiResponse({ status: 404, description: "Task not found" })
  findOne(@Param("id") id: string) {
    return this.taskService.findOne(id);
  }

  @Patch(":id")
  @ApiOperation({
    summary: "Update task",
    description: "Update task configuration. Note: running tasks are not immediately affected.",
  })
  @ApiParam({ name: "id", description: "Task ID" })
  @ApiResponse({ status: 200, description: "Updated successfully" })
  @ApiResponse({ status: 404, description: "Task not found" })
  async update(
    @Param("id") id: string,
    @Body() dto: UpdateTaskDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const result = await this.taskService.update(id, dto);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "task.update",
      resource: "task",
      resourceId: id,
      ip: req.ip,
    });
    return result;
  }

  @Put(":id/glue")
  @ApiOperation({
    summary: "Update GLUE script",
    description: "Update the GLUE script source code for online editing of execution logic.",
  })
  @ApiParam({ name: "id", description: "Task ID" })
  @ApiResponse({ status: 200, description: "Script updated" })
  @ApiResponse({ status: 404, description: "Task not found" })
  @ApiBody({
    schema: {
      type: "object",
      properties: { source: { type: "string" }, language: { type: "string" } },
    },
  })
  async updateGlue(
    @Param("id") id: string,
    @Body() body: { source: string; language?: string },
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const result = await this.taskService.updateGlue(
      id,
      body.source,
      body.language,
    );
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "task.updateGlue",
      resource: "task",
      resourceId: id,
      ip: req.ip,
    });
    return result;
  }

  @Delete(":id")
  @ApiOperation({
    summary: "Delete task",
    description: "Delete task. Running executions will be forcefully terminated.",
  })
  @ApiParam({ name: "id", description: "Task ID" })
  @ApiResponse({ status: 200, description: "Deleted successfully" })
  @ApiResponse({ status: 404, description: "Task not found" })
  async remove(
    @Param("id") id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const result = await this.taskService.remove(id);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "task.delete",
      resource: "task",
      resourceId: id,
      ip: req.ip,
    });
    return result;
  }

  @Post(":id/trigger")
  @ApiOperation({
    summary: "Manual trigger",
    description: "Manually trigger task execution. Custom params can override task defaults.",
  })
  @ApiParam({ name: "id", description: "Task ID" })
  @ApiResponse({
    status: 200,
    description: "Trigger successful",
    schema: {
      example: {
        code: 200,
        message: "success",
        data: {
          taskId: "task-uuid",
          executionId: "exec-uuid",
          status: "pending",
        },
      },
    },
  })
  async trigger(
    @Param("id") id: string,
    @Body() dto: TriggerTaskDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const result = await this.taskService.trigger(id, dto);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "task.trigger",
      resource: "task",
      resourceId: id,
      ip: req.ip,
    });
    return result;
  }

  @Get(":id/executions")
  @ApiOperation({
    summary: "Execution records",
    description: "Get the execution history list for a task.",
  })
  @ApiParam({ name: "id", description: "Task ID" })
  @ApiQuery({ name: "page", required: false, description: "Page number" })
  @ApiQuery({ name: "limit", required: false, description: "Page size" })
  @ApiQuery({ name: "status", required: false, description: "Filter by execution status" })
  executions(
    @Param("id") id: string,
    @Query() p: PaginationDto & { status?: string },
  ) {
    return this.taskService.getExecutions(id, p);
  }

  @Get(":id/executions/:execId")
  @ApiOperation({
    summary: "Execution details",
    description: "Get detailed info for a single execution including time, status, and output.",
  })
  @ApiParam({ name: "id", description: "Task ID" })
  @ApiParam({ name: "execId", description: "Execution record ID" })
  @ApiResponse({ status: 404, description: "Execution record not found" })
  execution(@Param("execId") execId: string) {
    return this.taskService.getExecution(execId);
  }

  @Get(":id/executions/:execId/logs")
  @ApiOperation({
    summary: "Execution logs",
    description: "Get execution logs with line-based pagination to avoid memory overload.",
  })
  @ApiParam({ name: "id", description: "Task ID" })
  @ApiParam({ name: "execId", description: "Execution record ID" })
  @ApiQuery({
    name: "fromLine",
    required: false,
    description: "Start line number, default 0",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    description: "Lines per page, default 500, max 2000",
  })
  executionLogs(
    @Param("execId") execId: string,
    @Query("fromLine") fromLine?: string,
    @Query("limit") limit?: string,
  ) {
    return this.taskService.getExecutionLogs(
      execId,
      fromLine ? (parseInt(fromLine, 10) || 0) : 0,
      limit ? Math.min(parseInt(limit, 10) || 500, 2000) : 500,
    );
  }

  @Get(":id/executions/:execId/logs/stream")
  @ApiOperation({
    summary: "Execution log SSE stream",
    description: "Stream execution logs via Server-Sent Events. Sends [DONE] event on completion.",
  })
  @ApiParam({ name: "id", description: "Task ID" })
  @ApiParam({ name: "execId", description: "Execution record ID" })
  async streamLogs(
    @Param("execId") execId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
    res.flushHeaders();

    const ac = new AbortController();
    req.on("close", () => ac.abort());

    const send = (line: string) => {
      res.write(`data: ${JSON.stringify(line)}\n\n`);
    };
    const done = () => {
      res.write(`event: done\ndata: [DONE]\n\n`);
      res.end();
    };

    try {
      await this.taskService.streamExecutionLogs(execId, send, done, ac.signal);
    } catch {
      res.write(`event: error\ndata: stream error\n\n`);
      res.end();
    }
  }

  @Post(":id/rollback")
  @ApiOperation({
    summary: "Git rollback",
    description: "Rollback task to a specific Git commit. Only applies to Git-type tasks.",
  })
  @ApiParam({ name: "id", description: "Task ID" })
  @ApiBody({
    description: "Rollback parameters",
    schema: {
      example: {
        gitCommit: "abc123",
        message: "Rollback to stable version",
      },
    },
  })
  @ApiResponse({ status: 400, description: "Rollback not supported for non-Git tasks" })
  async rollback(
    @Param("id") id: string,
    @Body() dto: RollbackTaskDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const result = await this.taskService.rollback(id, dto);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "task.rollback",
      resource: "task",
      resourceId: id,
      detail: { gitCommit: dto.gitCommit },
      ip: req.ip,
    });
    return result;
  }

  @Post(":id/versions/:versionId/rollback")
  @ApiOperation({
    summary: "Version rollback",
    description: "Rollback task config to a specific historical version.",
  })
  @ApiParam({ name: "id", description: "Task ID" })
  @ApiParam({ name: "versionId", description: "Version ID" })
  @ApiResponse({ status: 200, description: "Rollback successful" })
  @ApiResponse({ status: 404, description: "Task or version not found" })
  async rollbackToVersion(
    @Param("id") id: string,
    @Param("versionId") versionId: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const result = await this.taskService.rollbackToVersion(id, versionId);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "task.rollbackToVersion",
      resource: "task",
      resourceId: id,
      detail: { versionId },
      ip: req.ip,
    });
    return result;
  }

  @Get(":id/versions")
  @ApiOperation({ summary: "Version list", description: "Get task historical version list." })
  @ApiParam({ name: "id", description: "Task ID" })
  getVersions(@Param("id") id: string) {
    return this.taskService.getVersions(id);
  }

  @Get(":id/versions/:versionId1/compare/:versionId2")
  @ApiOperation({
    summary: "Version diff",
    description: "Compare differences between two versions.",
  })
  @ApiParam({ name: "id", description: "Task ID" })
  @ApiParam({ name: "versionId1", description: "Version ID 1" })
  @ApiParam({ name: "versionId2", description: "Version ID 2" })
  @ApiResponse({ status: 200, description: "Version diff" })
  @ApiResponse({ status: 404, description: "Task or version not found" })
  async compareVersions(
    @Param("id") id: string,
    @Param("versionId1") versionId1: string,
    @Param("versionId2") versionId2: string,
  ) {
    return this.taskService.compareVersions(id, versionId1, versionId2);
  }

  @Post(":id/pause")
  @ApiOperation({
    summary: "Pause task",
    description: "Pause task scheduled execution. In-progress executions are not affected.",
  })
  @ApiParam({ name: "id", description: "Task ID" })
  @ApiResponse({ status: 200, description: "Paused successfully" })
  @ApiResponse({ status: 400, description: "Task is already paused" })
  @ApiResponse({ status: 404, description: "Task not found" })
  async pause(
    @Param("id") id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const result = await this.taskService.pause(id);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "task.pause",
      resource: "task",
      resourceId: id,
      ip: req.ip,
    });
    return result;
  }

  @Post(":id/resume")
  @ApiOperation({
    summary: "Resume task",
    description: "Resume task scheduled execution.",
  })
  @ApiParam({ name: "id", description: "Task ID" })
  @ApiResponse({ status: 200, description: "Resumed successfully" })
  @ApiResponse({ status: 400, description: "Task is already running" })
  @ApiResponse({ status: 404, description: "Task not found" })
  async resume(
    @Param("id") id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const result = await this.taskService.resume(id);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "task.resume",
      resource: "task",
      resourceId: id,
      ip: req.ip,
    });
    return result;
  }

  @Post(":id/executions/:execId/analyze")
  @ApiOperation({
    summary: "AI analyze execution",
    description: "Trigger on-demand AI analysis for an execution. Stores result in DB and returns it.",
  })
  @ApiParam({ name: "id", description: "Task ID" })
  @ApiParam({ name: "execId", description: "Execution record ID" })
  @ApiResponse({ status: 200, description: "AI analysis result" })
  async analyzeExecution(
    @Param("execId") execId: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const result = await this.taskService.analyzeExecution(execId);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "task.analyzeExecution",
      resource: "task_execution",
      resourceId: execId,
      ip: req.ip,
    });
    return result;
  }

  @Post(":id/executions/:execId/kill")
  @ApiOperation({
    summary: "Cancel execution",
    description: "Force-cancel a running or pending execution record.",
  })
  @ApiParam({ name: "id", description: "Task ID" })
  @ApiParam({ name: "execId", description: "Execution record ID" })
  @ApiResponse({ status: 200, description: "Cancelled successfully" })
  @ApiResponse({ status: 400, description: "Execution is not in a cancellable state" })
  @ApiResponse({ status: 404, description: "Execution record not found" })
  async killExecution(
    @Param("execId") execId: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const result = await this.taskService.killExecution(execId);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "task.killExecution",
      resource: "task_execution",
      resourceId: execId,
      ip: req.ip,
    });
    return result;
  }

}
