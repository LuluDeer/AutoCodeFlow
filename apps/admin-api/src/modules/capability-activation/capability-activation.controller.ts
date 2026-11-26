import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import { Roles } from "../../common/decorators/roles.decorator";
import { UserRole } from "../users/entities/user.entity";
import {
  ActivationQueryDto,
  ActivationStatsQueryDto,
} from "./dto/activation-query.dto";
import { CreateActivationDto } from "./dto/create-activation.dto";
import { ActivationLogViewDto } from "./dto/activation-log-view.dto";
import { QuotaStatusQueryDto, SetQuotaDto } from "./dto/quota.dto";
import {
  ActivationStats,
  CapabilityActivationService,
} from "./capability-activation.service";
import { CapabilityActivationLog } from "./entities/activation-log.entity";
import { QuotaService } from "./quota.service";

/**
 * N15 / GCO §11：运行时能力激活日志端点。
 *
 * 全部走全局 JwtAuthGuard（见 capability.controller 同款约定，不叠加
 * @WriteGuard；route-authz-matrix 禁止 @Roles 与 @WriteGuard 共存）。
 *
 *  POST /api/capability-activation          写入一条激活（JWT 可用；内部调用方）
 *  GET  /api/capability-activation          过滤 + 分页查询（ADMIN）
 *  GET  /api/capability-activation/stats    按能力/项目聚合（ADMIN）
 *
 *  N20 showback（同前缀子路径，沿用 ADMIN + JwtAuthGuard，不叠加 WriteGuard）：
 *  PUT  /api/capability-activation/quota         upsert 配额配置（ADMIN）
 *  GET  /api/capability-activation/quota         列出配额配置（ADMIN）
 *  GET  /api/capability-activation/quota-status  配额状态 + 软阈值告警（ADMIN）
 *
 * **无 PATCH / DELETE**：append-only 在路由层即封死。
 *
 * 读取先按简单 ADMIN 处理；项目 admin 的按项目授权是下一轮增强（见回报）。
 */
@ApiTags("Capability Activation")
@ApiBearerAuth("JWT")
@Controller("capability-activation")
export class CapabilityActivationController {
  constructor(
    private readonly svc: CapabilityActivationService,
    private readonly quota: QuotaService,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: "记录一次能力激活（JWT；供 capability/workbench 调用方写入）",
  })
  @ApiOkResponse({ type: ActivationLogViewDto })
  record(@Body() dto: CreateActivationDto): Promise<CapabilityActivationLog> {
    return this.svc.record(dto);
  }

  /** 静态段必须在参数路由之前——本控制器无 @Get(":id")，天然安全。 */
  @Get("stats")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "按 capabilityKey / 项目聚合激活次数（ADMIN）" })
  stats(@Query() query: ActivationStatsQueryDto): Promise<ActivationStats> {
    return this.svc.stats({ from: query.from, to: query.to });
  }

  @Put("quota")
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: "创建或更新按项目/能力的配额配置（ADMIN；落 system_configs）",
  })
  upsertQuota(@Body() dto: SetQuotaDto) {
    return this.quota.upsert(dto);
  }

  @Get("quota")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "列出全部配额配置（ADMIN；无配置返回空数组）" })
  listQuotas() {
    return this.quota.list();
  }

  @Get("quota-status")
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary:
      "按调用次数计算配额状态（ok/warn/exceeded）并触发软阈值告警（ADMIN）",
  })
  quotaStatus(@Query() query: QuotaStatusQueryDto) {
    return this.quota.status(query.windowDays ?? 30);
  }

  @Get()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "过滤 + 分页查询能力激活日志（ADMIN）" })
  query(@Query() query: ActivationQueryDto) {
    return this.svc.query({
      capabilityKey: query.capabilityKey,
      sessionId: query.sessionId,
      userId: query.userId,
      projectId: query.projectId,
      username: query.username,
      result: query.result,
      outcome: query.outcome,
      from: query.from,
      to: query.to,
      page: query.page,
      pageSize: query.pageSize,
    });
  }
}
