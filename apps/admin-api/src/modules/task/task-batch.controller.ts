import { Controller, Post, Body, UseGuards, Req } from "@nestjs/common";
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
import { AuthUser } from "../../common/interfaces/auth-user.interface";
import { TaskService } from "./task.service";
import { BatchTaskIdsDto } from "./dto/batch-task.dto";
import { AuditService } from "../audit/audit.service";
// SEC-09: 限流分域——批量触发属触发写面，挂中档 OPS_THROTTLE（默认
// 30/min，批量入口一次请求即派发 N 个执行，比单任务 trigger 更该限）。
// 装饰器求值期读取属 ARCH-27 显式豁免（见 src/config/throttle-profiles.ts）。
import { Throttle } from "@nestjs/throttler";
import { OPS_THROTTLE } from "../../config/throttle-profiles";

/**
 * Batch operations controller — separate controller to avoid :id param route conflicts
 * Routes: POST /api/tasks/batch/trigger|pause|resume|delete
 */
@ApiTags("Task Management")
@ApiBearerAuth("JWT")
@UseGuards(JwtAuthGuard)
@Controller("tasks-batch")
export class TaskBatchController {
  constructor(
    private readonly taskService: TaskService,
    private readonly audit: AuditService,
  ) {}

  @Throttle({ default: OPS_THROTTLE })
  @Post("trigger")
  @ApiOperation({
    summary: "Batch trigger tasks",
    description:
      "Trigger multiple tasks. Partial failures do not affect other tasks.",
  })
  @ApiResponse({ status: 200, description: "Batch trigger results" })
  @ApiBody({
    description: "Batch trigger parameters",
    schema: { example: { taskIds: ["uuid-1", "uuid-2"] } },
  })
  async batchTrigger(
    @Body() body: BatchTaskIdsDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const results = await Promise.all(
      body.taskIds.map((id) =>
        // R-02: 透传 user（对照 TaskController.batchTrigger 的正确写法）——
        // 漏传时 service 侧 user 为 undefined，viewer/ADMIN 判定失真。
        this.taskService
          .trigger(id, {}, user)
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
    summary: "Batch pause tasks",
    description:
      "Pause multiple tasks. Partial failures do not affect other tasks.",
  })
  @ApiResponse({ status: 200, description: "Batch pause results" })
  async batchPause(
    @Body() body: BatchTaskIdsDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const results = await Promise.all(
      body.taskIds.map((id) =>
        // R-02: 透传 user（对照 TaskController.batchPause 的正确写法）
        this.taskService
          .pause(id, user)
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
    summary: "Batch resume tasks",
    description:
      "Resume multiple tasks. Partial failures do not affect other tasks.",
  })
  @ApiResponse({ status: 200, description: "Batch resume results" })
  async batchResume(
    @Body() body: BatchTaskIdsDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const results = await Promise.all(
      body.taskIds.map((id) =>
        // R-02: 透传 user（对照 TaskController.batchResume 的正确写法）
        this.taskService
          .resume(id, user)
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
    summary: "Batch delete tasks",
    description:
      "Delete multiple tasks. Partial failures do not affect other tasks.",
  })
  @ApiResponse({ status: 200, description: "Batch delete results" })
  async batchDelete(
    @Body() body: BatchTaskIdsDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const results = await Promise.all(
      body.taskIds.map((id) =>
        // R-02: 透传 user——漏传时 assertCanWrite 的 ADMIN/属主判定双双
        // 不成立，批量删除对所有人恒 403（错误被 .catch 吞成 {id,error}）。
        this.taskService
          .remove(id, user)
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
