import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  Query,
  Headers,
  UnauthorizedException,
  ParseUUIDPipe,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { Public } from "../../common/decorators/public.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { UserRole } from "../users/entities/user.entity";
import { AppDeploymentService } from "./app-deployment.service";
import { ExecutorService } from "../executor/executor.service";
import { ApiHeader } from "@nestjs/swagger";
import {
  CreateDeploymentDto,
  DeploymentHeartbeatDto,
  ApprovalActionDto,
} from "./dto/app-deployment.dto";
import { DeploymentApprovalStatus } from "./entities/app-deployment.entity";
import {
  IsOptional,
  IsUUID,
  IsInt,
  Min,
  Max,
  IsEnum,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiPropertyOptional } from "@nestjs/swagger";
// SEC-09: 限流分域——部署/审批/upgrade/stop 属集群干预写面，挂中档
// OPS_THROTTLE（默认 30/min）。装饰器求值期读取属 ARCH-27 显式豁免
//（见 src/config/throttle-profiles.ts 头注；heartbeat @Public 机器回调不挂档位）。
import { Throttle } from "@nestjs/throttler";
import { OPS_THROTTLE } from "../../config/throttle-profiles";

class ListDeploymentsQueryDto {
  @ApiPropertyOptional({ description: "Filter by application ID" })
  @IsOptional()
  @IsUUID()
  applicationId?: string;

  @ApiPropertyOptional({
    description:
      "DEP-04: filter by approval status (e.g. pending_approval for the approval inbox)",
    enum: DeploymentApprovalStatus,
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
  @ApiOperation({ summary: "List deployments" })
  findAll(@Query() query: ListDeploymentsQueryDto) {
    return this.svc.findAll(
      query.applicationId,
      query.page ?? 1,
      query.pageSize ?? 20,
      query.approvalStatus,
    );
  }

  @Get(":id")
  @ApiOperation({ summary: "Get deployment details" })
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
  @ApiOperation({ summary: "Assign application to executor" })
  deploy(
    @Param("appId") appId: string,
    @Body() dto: CreateDeploymentDto,
    // DEP-04: 提交人身份进审批痕迹（approvalRequired 应用）或未来审计扩展。
    @CurrentUser() user: { id: number; username: string },
  ) {
    return this.svc.deploy(
      appId,
      dto,
      user ? { id: user.id, name: user.username } : undefined,
    );
  }

  // ---------------------------------------------------------------------
  // DEP-04: deployment approval flow (second-person rule enforced in the
  // service — the approver must differ from the requester recorded on the
  // pending row; the requester's own exit is DELETE :id/approval/cancel).
  // ---------------------------------------------------------------------

  @Get("approvals/pending")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "List deployments awaiting approval" })
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
  @ApiOperation({ summary: "Approve a pending deployment (second person)" })
  approve(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ApprovalActionDto,
    @CurrentUser() user: { id: number; username: string },
  ) {
    return this.svc.approveDeployment(
      id,
      { id: user?.id ?? null, name: user?.username ?? null },
      dto?.reason,
    );
  }

  // SEC-09: 中档限流（部署干预写面，OPS_THROTTLE 默认 30/min）
  @Throttle({ default: OPS_THROTTLE })
  @Post(":id/approval/reject")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Reject a pending deployment (second person)" })
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
  @ApiOperation({
    summary: "Cancel own pending deployment request (requester only)",
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
  @ApiOperation({ summary: "Trigger overlay upgrade" })
  upgrade(@Param("id") id: string) {
    return this.svc.upgrade(id);
  }

  // SEC-09: 中档限流（部署干预写面，OPS_THROTTLE 默认 30/min）
  @Throttle({ default: OPS_THROTTLE })
  @Post(":id/stop")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Stop running deployment" })
  stop(@Param("id") id: string) {
    return this.svc.stop(id);
  }

  /**
   * Called by executor to report app process status.
   * SEC-03: Requires X-Executor-Token header — validated against the executor's
   * per-executor bcrypt token (or legacy shared token fallback).
   */
  @Public()
  @Post("heartbeat")
  @ApiOperation({
    summary: "Executor reports app runtime status (requires X-Executor-Token)",
  })
  @ApiHeader({
    name: "x-executor-token",
    required: true,
    description: "Executor token (per-executor or shared)",
  })
  async heartbeat(
    @Body() dto: DeploymentHeartbeatDto,
    @Headers("x-executor-token") token: string | undefined,
  ) {
    if (!token) {
      throw new UnauthorizedException("Missing X-Executor-Token header");
    }
    // Look up deployment to find the associated executor
    const deployment = await this.svc.findById(dto.deploymentId);
    const executorId = deployment?.executorId;
    if (!executorId) {
      throw new UnauthorizedException(
        "Cannot verify token: deployment has no associated executor",
      );
    }
    const valid = await this.executorService.validateExecutorToken(
      executorId,
      token,
    );
    if (!valid) {
      throw new UnauthorizedException("Invalid executor token");
    }
    return this.svc.handleHeartbeat(dto);
  }
}
