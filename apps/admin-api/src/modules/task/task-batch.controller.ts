import {
  Controller,
  Post,
  Body,
  UseGuards,
  Req,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
  ApiBody,
} from "@nestjs/swagger";
import { Request } from "express";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { TaskService } from "./task.service";
import { BatchTaskIdsDto } from "./dto/batch-task.dto";
import { AuditService } from "../audit/audit.service";

/**
 * 批量操作控制器 — 独立 Controller 避免与 :id 参数路由冲突
 * 路径: POST /api/tasks/batch/trigger|pause|resume|delete
 */
@ApiTags("任务管理")
@ApiBearerAuth("JWT")
@UseGuards(JwtAuthGuard)
@Controller("tasks-batch")
export class TaskBatchController {
  constructor(
    private readonly taskService: TaskService,
    private readonly audit: AuditService,
  ) {}

  @Post("trigger")
  @ApiOperation({
    summary: "批量触发任务",
    description: "批量触发多个任务执行。部分任务失败不会影响其他任务。",
  })
  @ApiResponse({ status: 200, description: "批量触发结果列表" })
  @ApiBody({
    description: "批量触发参数",
    schema: { example: { taskIds: ["uuid-1", "uuid-2"] } },
  })
  async batchTrigger(
    @Body() body: BatchTaskIdsDto,
    @CurrentUser() user: any,
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

  @Post("pause")
  @ApiOperation({
    summary: "批量暂停任务",
    description: "批量暂停多个任务。部分任务失败不会影响其他任务。",
  })
  @ApiResponse({ status: 200, description: "批量暂停结果列表" })
  async batchPause(
    @Body() body: BatchTaskIdsDto,
    @CurrentUser() user: any,
    @Req() req: Request,
  ) {
    const results = await Promise.all(
      body.taskIds.map((id) =>
        this.taskService
          .pause(id)
          .catch((err) => ({ id, error: err.message })),
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

  @Post("resume")
  @ApiOperation({
    summary: "批量恢复任务",
    description: "批量恢复多个任务。部分任务失败不会影响其他任务。",
  })
  @ApiResponse({ status: 200, description: "批量恢复结果列表" })
  async batchResume(
    @Body() body: BatchTaskIdsDto,
    @CurrentUser() user: any,
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

  @Post("delete")
  @ApiOperation({
    summary: "批量删除任务",
    description: "批量删除多个任务。部分任务失败不会影响其他任务。",
  })
  @ApiResponse({ status: 200, description: "批量删除结果列表" })
  async batchDelete(
    @Body() body: BatchTaskIdsDto,
    @CurrentUser() user: any,
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
}
