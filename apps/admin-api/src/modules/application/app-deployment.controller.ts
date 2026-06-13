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
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { Public } from "../../common/decorators/public.decorator";
import { AppDeploymentService } from "./app-deployment.service";
import { ExecutorService } from "../executor/executor.service";
import { ApiHeader } from "@nestjs/swagger";
import { CreateDeploymentDto, DeploymentHeartbeatDto } from "./dto/app-deployment.dto";
import { PaginationDto } from "../../common/dto/pagination.dto";

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
  findAll(
    @Query("applicationId") applicationId?: string,
    @Query() pagination?: PaginationDto,
  ) {
    const page = pagination?.page ?? 1;
    const limit = pagination?.pageSize ?? 20;
    return this.svc.findAll(applicationId, page, limit);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get deployment details" })
  findById(@Param("id") id: string) {
    return this.svc.findById(id);
  }

  @Post("applications/:appId/deploy")
  @ApiOperation({ summary: "Assign application to executor" })
  deploy(
    @Param("appId") appId: string,
    @Body() dto: CreateDeploymentDto,
  ) {
    return this.svc.deploy(appId, dto);
  }

  @Post(":id/upgrade")
  @ApiOperation({ summary: "Trigger overlay upgrade" })
  upgrade(@Param("id") id: string) {
    return this.svc.upgrade(id);
  }

  @Post(":id/stop")
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
  @ApiOperation({ summary: "Executor reports app runtime status (requires X-Executor-Token)" })
  @ApiHeader({ name: "x-executor-token", required: true, description: "Executor token (per-executor or shared)" })
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
      throw new UnauthorizedException("Cannot verify token: deployment has no associated executor");
    }
    const valid = await this.executorService.validateExecutorToken(executorId, token);
    if (!valid) {
      throw new UnauthorizedException("Invalid executor token");
    }
    return this.svc.handleHeartbeat(dto);
  }
}
