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
import { WriteGuard } from "../../common/decorators/write-guard.decorator";

/**
 * Batch operations controller — separate controller to avoid :id param route conflicts.
 * Routes: POST /api/tasks-batch/trigger|pause|resume|delete
 *
 * PK-20（DEEP_REVIEW 0ef3bbe）: **DEPRECATED** 双事实源收敛。批量能力此前同时
 * 存在两套路由——本控制器 `/tasks-batch/*` 与 TaskController 内 `/tasks/batch/*`
 * （与 task 资源 RESTful 风格一致，已为 canonical 主路由）。两套实现已对齐调用
 * 同一 TaskService 方法（trigger/pause/resume/remove，R-02 user 透传两处一致），
 * 无逻辑漂移；本控制器不再删除（避免破坏既有前端/SDK 调用方），仅标记 deprecated。
 *
 * 迁移路线：调用方请改用 `/api/tasks/batch/trigger|pause|resume|delete`（同 body
 * 形状 BatchTaskIdsDto、同响应、同审计 action）。待前端/SDK 全量切换后，本控制器
 * 整文件删除。
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
  @WriteGuard("task", {
    scope: "project-role",
    reason:
      "只做项目角色校验（assertCanOperate 仅显式拒绝 viewer），属主收紧待 ADR-013 产品拍板",
  })
  @Post("trigger")
  @ApiOperation({
    summary: "Batch trigger tasks (deprecated)",
    deprecated: true,
    description:
      "PK-20 DEPRECATED: 改用 POST /api/tasks/batch/trigger（同 body/响应/审计）。" +
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

  @WriteGuard("task", {
    scope: "project-role",
    reason:
      "只做项目角色校验（assertCanOperate 仅显式拒绝 viewer），属主收紧待 ADR-013 产品拍板",
  })
  @Post("pause")
  @ApiOperation({
    summary: "Batch pause tasks (deprecated)",
    deprecated: true,
    description:
      "PK-20 DEPRECATED: 改用 POST /api/tasks/batch/pause（同 body/响应/审计）。" +
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

  @WriteGuard("task", {
    scope: "project-role",
    reason:
      "只做项目角色校验（assertCanOperate 仅显式拒绝 viewer），属主收紧待 ADR-013 产品拍板",
  })
  @Post("resume")
  @ApiOperation({
    summary: "Batch resume tasks (deprecated)",
    deprecated: true,
    description:
      "PK-20 DEPRECATED: 改用 POST /api/tasks/batch/resume（同 body/响应/审计）。" +
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

  @WriteGuard("task", { scope: "ownership" })
  @Post("delete")
  @ApiOperation({
    summary: "Batch delete tasks (deprecated)",
    deprecated: true,
    description:
      "PK-20 DEPRECATED: 改用 POST /api/tasks/batch/delete（同 body/响应/审计）。" +
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
