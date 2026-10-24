import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  UseGuards,
  Query,
  Headers,
  ParseUUIDPipe,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiOkResponse,
  ApiCreatedResponse,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { Public } from "../../common/decorators/public.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { UserRole } from "../users/entities/user.entity";
import { AppDeploymentService } from "./app-deployment.service";
import { DeploymentTriggerType } from "./entities/app-deployment.entity";
import { ExecutorService } from "../executor/executor.service";
// ARCH-23 / N-12（2026-10-07 批）：App Deployment 域响应契约（11 端点此前 0 覆盖）。
import {
  AppDeploymentResponseDto,
  AppDeploymentStatsDto,
  DeploymentRemoveResponseDto,
  PaginatedAppDeploymentsDto,
  AppDeploymentEventsPageDto,
} from "./dto/app-deployment-response.dto";
import { ApiHeader } from "@nestjs/swagger";
import {
  CreateDeploymentDto,
  DeploymentHeartbeatDto,
  ApprovalActionDto,
  ListDeploymentEventsQueryDto,
} from "./dto/app-deployment.dto";
import { DeploymentApprovalStatus } from "./entities/app-deployment.entity";
import { IsOptional, IsUUID, IsInt, Min, Max, IsEnum } from "class-validator";
import { Type } from "class-transformer";
import { ApiPropertyOptional } from "@nestjs/swagger";
// SEC-09: 限流分域——部署/审批/upgrade/stop 属集群干预写面，挂中档
// OPS_THROTTLE（默认 30/min）。装饰器求值期读取属 ARCH-27 显式豁免
//（见 src/config/throttle-profiles.ts 头注；heartbeat @Public 机器回调不挂档位）。
import { Throttle } from "@nestjs/throttler";
import { OPS_THROTTLE } from "../../config/throttle-profiles";
import { WriteGuard } from "../../common/decorators/write-guard.decorator";
// LANG-ERR-01: 用户可见报错改为稳定错误码（文案由前端按用户语言渲染）。
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";

class ListDeploymentsQueryDto {
  @ApiPropertyOptional({ description: "按应用 ID 过滤" })
  @IsOptional()
  @IsUUID()
  applicationId?: string;

  @ApiPropertyOptional({
    enum: DeploymentApprovalStatus,
    description:
      "DEP-04：按审批状态过滤（例如用 pending_approval 拉取审批收件箱）",
  })
  @IsOptional()
  @IsEnum(DeploymentApprovalStatus)
  approvalStatus?: DeploymentApprovalStatus;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}

@ApiTags("App Deployment")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("app-deployments")
export class AppDeploymentController {
  constructor(
    private readonly svc: AppDeploymentService,
    private readonly executorService: ExecutorService,
  ) {}

  @Get()
  @ApiOperation({ summary: "列出部署" })
  // N-12: 裸 {data,total} 分页（无页元数据），行 env/嵌套 application.env 掩码。
  @ApiOkResponse({ type: PaginatedAppDeploymentsDto })
  findAll(@Query() query: ListDeploymentsQueryDto) {
    return this.svc.findAll(
      query.applicationId,
      query.page ?? 1,
      query.pageSize ?? 20,
      query.approvalStatus,
    );
  }

  /**
   * 应用列表页的部署统计（每应用一行聚合）。
   *
   * 路由顺序约束：必须声明在 `@Get(":id")` **之前**，否则 "stats" 会被
   * `:id` 捕获 → ParseUUIDPipe 直接 400（与 executor.controller 的
   * `@Get("picker")` 同一坑，见该文件路由顺序注记）。
   *
   * 读面、无 @Roles（与 findAll 一致，登录即可）；也不额外挂 @Throttle ——
   * 它正是为消除列表页 N+1 扇出而生的单一入口，走全局档即可。
   */
  @Get("stats")
  @ApiOperation({
    description:
      "每个至少有一次部署的应用返回一行。用于替代应用列表页原先逐个应用发起的扇出请求（N 个请求共用同一个限流桶）。",
    summary: "各应用的部署统计（聚合）",
  })
  @ApiOkResponse({ type: [AppDeploymentStatsDto] })
  findStats() {
    return this.svc.findStats();
  }

  /**
   * R4（部署模型评审 §4.1A）：应用的不可变部署事件流（append-only 动作
   * 追溯——deploy 新建/复用、审批三动作、upgrade、stop、remove、卡死扫死）。
   *
   * 路由顺序约束：同 stats——必须声明在 `@Get(":id")` 之前，否则
   * "applications" 会被 `:id` 捕获 → ParseUUIDPipe 400。
   *
   * 读面、无 @Roles（与 findAll/stats 一致，登录即可）；分页默认 50、上限 200
   * （对齐 /applications/:id/releases），不额外挂 @Throttle（走全局档）。
   */
  @Get("applications/:appId/events")
  @ApiOperation({
    description:
      "R4（部署模型评审 2026-10-23 §4.1A）：不可变部署事件流（append-only）。每个部署域写动作一行短事实快照（事件类型/版本事实/操作人）；事件无 UPDATE/DELETE 路径，remove 事件比部署行活得久（事件表无外键）。分页默认 50、上限 200，按 createdAt 倒序。事件 detail 由写入侧保证不含 env 密钥",
    summary: "列出应用的部署事件流（不可变动作追溯）",
  })
  @ApiOkResponse({
    type: AppDeploymentEventsPageDto,
    description: "裸四键信封（data/total/page/pageSize），同 /releases 形态",
  })
  listApplicationEvents(
    @Param("appId") appId: string,
    @Query() query: ListDeploymentEventsQueryDto,
  ) {
    // 过滤参数（eventType/since/until）透传 service；DTO 已校验枚举值与
    // ISO 8601 形态，这里不做二次解析。
    return this.svc.getEventsByApp(
      appId,
      query.page ?? 1,
      query.pageSize ?? 50,
      {
        eventType: query.eventType,
        since: query.since,
        until: query.until,
      },
    );
  }

  @Get(":id")
  @ApiOperation({ summary: "获取部署详情" })
  @ApiOkResponse({ type: AppDeploymentResponseDto })
  findById(@Param("id") id: string) {
    return this.svc.findById(id);
  }

  // R1: deploy/upgrade/stop are cluster-mutating routes (assign work to
  // executors, restart processes, kill runs). Listing/details stay open
  // to any authenticated user. The @Public() heartbeat below is a
  // machine-to-machine callback with X-Executor-Token auth — it carries
  // no @Roles metadata, so the global RolesGuard skips it.
  // SEC-09: 中档限流（部署干预写面，OPS_THROTTLE 默认 30/min）
  @Throttle({ default: OPS_THROTTLE })
  @Post("applications/:appId/deploy")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "将应用分配到执行器" })
  // POST 无 @HttpCode → 实际 201（下同：approve/reject/cancel/upgrade/stop）。
  @ApiCreatedResponse({
    type: AppDeploymentResponseDto,
    description: "脱敏后的部署行（需要审批的应用返回 pending_approval 请求行）",
  })
  deploy(
    @Param("appId") appId: string,
    @Body() dto: CreateDeploymentDto,
    // DEP-04: 提交人身份进审批痕迹（approvalRequired 应用）或未来审计扩展。
    @CurrentUser() user: { id: number; username: string },
  ) {
    // FEAT-20: 部署触发来源落列（manual + JWT 用户名）。
    return this.svc.deploy(
      appId,
      dto,
      user ? { id: user.id, name: user.username } : undefined,
      user
        ? {
            operator: user.username,
            triggerType: DeploymentTriggerType.MANUAL,
          }
        : undefined,
    );
  }

  // ---------------------------------------------------------------------
  // DEP-04: deployment approval flow (second-person rule enforced in the
  // service — the approver must differ from the requester recorded on the
  // pending row; the requester's own exit is DELETE :id/approval/cancel).
  // ---------------------------------------------------------------------

  @Get("approvals/pending")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "列出待审批的部署" })
  @ApiOkResponse({ type: PaginatedAppDeploymentsDto })
  listPendingApprovals(@Query() query: ListDeploymentsQueryDto) {
    return this.svc.findAll(
      query.applicationId,
      query.page ?? 1,
      query.pageSize ?? 20,
      DeploymentApprovalStatus.PENDING_APPROVAL,
    );
  }

  // SEC-09: 中档限流（部署干预写面，OPS_THROTTLE 默认 30/min）
  @Throttle({ default: OPS_THROTTLE })
  @Post(":id/approval/approve")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "审批通过待处理的部署（第二人审批）" })
  @ApiCreatedResponse({
    type: AppDeploymentResponseDto,
    description: "已审批通过并已派发的行",
  })
  approve(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ApprovalActionDto,
    @CurrentUser() user: { id: number; username: string },
  ) {
    // FEAT-20: 审批通过=实际派发动作，行覆写 approval 语义 + 审批人用户名。
    return this.svc.approveDeployment(
      id,
      { id: user?.id ?? null, name: user?.username ?? null },
      dto?.reason,
      user?.username
        ? {
            operator: user.username,
            triggerType: DeploymentTriggerType.APPROVAL,
          }
        : undefined,
    );
  }

  // SEC-09: 中档限流（部署干预写面，OPS_THROTTLE 默认 30/min）
  @Throttle({ default: OPS_THROTTLE })
  @Post(":id/approval/reject")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "驳回待处理的部署（第二人审批）" })
  @ApiCreatedResponse({
    type: AppDeploymentResponseDto,
    description: "已驳回的行",
  })
  reject(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ApprovalActionDto,
    @CurrentUser() user: { id: number; username: string },
  ) {
    return this.svc.rejectDeployment(
      id,
      { id: user?.id ?? null, name: user?.username ?? null },
      dto?.reason,
    );
  }

  // SEC-09: 中档限流（部署干预写面，OPS_THROTTLE 默认 30/min）
  @Throttle({ default: OPS_THROTTLE })
  @Post(":id/approval/cancel")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "撤销自己发起的待审批部署请求（仅发起人）" })
  @ApiCreatedResponse({
    type: AppDeploymentResponseDto,
    description: "已撤销的行",
  })
  cancel(
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: number; username: string },
  ) {
    return this.svc.cancelDeployment(id, {
      id: user?.id ?? null,
      name: user?.username ?? null,
    });
  }

  // SEC-09: 中档限流（部署干预写面，OPS_THROTTLE 默认 30/min）
  @Throttle({ default: OPS_THROTTLE })
  @Post(":id/upgrade")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "触发叠加升级" })
  @ApiCreatedResponse({
    type: AppDeploymentResponseDto,
    description: "处于 upgrading 状态的行",
  })
  upgrade(
    @Param("id") id: string,
    @CurrentUser() user: { id: number; username: string },
  ) {
    // FEAT-20: 升级动作落 upgrade 语义 + 操作人用户名。
    return this.svc.upgrade(
      id,
      user
        ? {
            operator: user.username,
            triggerType: DeploymentTriggerType.UPGRADE,
          }
        : undefined,
    );
  }

  // SEC-09: 中档限流（部署干预写面，OPS_THROTTLE 默认 30/min）
  @Throttle({ default: OPS_THROTTLE })
  @Post(":id/stop")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "停止运行中的部署" })
  @ApiCreatedResponse({
    type: AppDeploymentResponseDto,
    description: "已停止的行",
  })
  stop(@Param("id") id: string) {
    return this.svc.stop(id);
  }

  /**
   * 删除部署记录（用户报障：失败的部署记录无法删除，「重新部署」后旧行永久残留）。
   *
   * 只接受终态行（FAILED / STOPPED）；在途行、运行中行、待审批行一律 409 并说明
   * 正确的出口（等它结束 / 先 stop / 走 reject 或 cancel）。语义与守卫详见
   * AppDeploymentService.removeDeployment 的方法注释。
   */
  // SEC-09: 中档限流（部署干预写面，OPS_THROTTLE 默认 30/min）
  @Throttle({ default: OPS_THROTTLE })
  @Delete(":id")
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    description:
      "从历史中移除已进入终态的部署行。进行中、运行中和待审批的部署会被拒绝并返回 409——请先停止运行中的部署；待审批的请用驳回/撤销。",
    summary: "删除已结束的部署记录（failed/stopped）",
  })
  @ApiOkResponse({ type: DeploymentRemoveResponseDto })
  remove(
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: number; username: string },
  ) {
    return this.svc.removeDeployment(id, {
      id: user?.id,
      username: user?.username,
    });
  }

  /**
   * Called by executor to report app process status.
   * SEC-03: Requires X-Executor-Token header — validated against the executor's
   * per-executor bcrypt token (or legacy shared token fallback).
   */
  @Public()
  @WriteGuard("deployment", {
    scope: "token",
    reason: "执行器持 X-Executor-Token 上报应用运行态（机器面，非用户会话）",
  })
  @Post("heartbeat")
  @ApiOperation({ summary: "执行器上报应用运行状态（需要 X-Executor-Token）" })
  @ApiHeader({
    name: "x-executor-token",
    required: true,
    description: "执行器令牌（按执行器的或共享的）",
  })
  // POST 无 @HttpCode → 实际 201；handleHeartbeat 返回 void → envelope data null。
  @ApiCreatedResponse({
    description: "状态已记录；信封 data 为 null",
    schema: { nullable: true },
  })
  async heartbeat(
    @Body() dto: DeploymentHeartbeatDto,
    @Headers("x-executor-token") token: string | undefined,
  ) {
    if (!token) {
      throw new AppError(ErrorCode.EXECUTOR_HEARTBEAT_TOKEN_MISSING);
    }
    // Look up deployment to find the associated executor
    const deployment = await this.svc.findById(dto.deploymentId);
    const executorId = deployment?.executorId;
    if (!executorId) {
      throw new AppError(ErrorCode.EXECUTOR_HEARTBEAT_NO_EXECUTOR);
    }
    const valid = await this.executorService.validateExecutorToken(
      executorId,
      token,
    );
    if (!valid) {
      throw new AppError(ErrorCode.EXECUTOR_HEARTBEAT_TOKEN_INVALID);
    }
    return this.svc.handleHeartbeat(dto);
  }
}
