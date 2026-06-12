import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  Query,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { Public } from "../../common/decorators/public.decorator";
import { AppDeploymentService } from "./app-deployment.service";
import { CreateDeploymentDto, DeploymentHeartbeatDto } from "./dto/app-deployment.dto";

@ApiTags("应用部署")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("app-deployments")
export class AppDeploymentController {
  constructor(private readonly svc: AppDeploymentService) {}

  @Get()
  @ApiOperation({ summary: "查询部署列表" })
  findAll(@Query("applicationId") applicationId?: string) {
    return this.svc.findAll(applicationId);
  }

  @Get(":id")
  @ApiOperation({ summary: "查询部署详情" })
  findById(@Param("id") id: string) {
    return this.svc.findById(id);
  }

  @Post("applications/:appId/deploy")
  @ApiOperation({ summary: "将应用指派到执行器" })
  deploy(
    @Param("appId") appId: string,
    @Body() dto: CreateDeploymentDto,
  ) {
    return this.svc.deploy(appId, dto);
  }

  @Post(":id/upgrade")
  @ApiOperation({ summary: "触发覆盖升级" })
  upgrade(@Param("id") id: string) {
    return this.svc.upgrade(id);
  }

  @Post(":id/stop")
  @ApiOperation({ summary: "停止运行中的部署" })
  stop(@Param("id") id: string) {
    return this.svc.stop(id);
  }

  /** Called by executor to report app process status (no JWT needed) */
  @Public()
  @Post("heartbeat")
  @ApiOperation({ summary: "执行器上报应用运行状态（无需 JWT）" })
  heartbeat(@Body() dto: DeploymentHeartbeatDto) {
    return this.svc.handleHeartbeat(dto);
  }
}
