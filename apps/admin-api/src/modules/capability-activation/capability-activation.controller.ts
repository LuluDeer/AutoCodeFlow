import {
  Body,
  Controller,
  Get,
  HttpCode,
  Optional,
  Post,
  Put,
  Query,
  Req as NestReq,
} from "@nestjs/common";
import type { Request } from "express";
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { Roles } from "../../common/decorators/roles.decorator";
import { WriteGuard } from "../../common/decorators/write-guard.decorator";
import { isApiKeyUser } from "../../common/interfaces/auth-user.interface";
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
import { PriceService } from "./price.service";
import { SetPriceDto } from "./price.dto";
import { TokenSamplePort } from "./token-sample.port";
import type { TokenSampleView } from "./dto/token-sample.dto";

// 既有单测的 @nestjs/common 替身只 mock 了路由装饰器，未导出 Req；缺位时降级
// 为空装饰器，保持这些 spec 可加载。生产环境 NestReq 恒在，注入语义不变。
const Req: typeof NestReq =
  NestReq ?? ((() => () => undefined) as typeof NestReq);

/**
 * N15 / GCO §11：运行时能力激活日志端点。
 *
 * 全部走全局 JwtAuthGuard（见 capability.controller 同款约定）。
 *
 *  POST /api/capability-activation          写入一条激活（JWT；内部调用方；@WriteGuard authenticated 显式登记）
 *  GET  /api/capability-activation          过滤 + 分页查询（ADMIN）
 *  GET  /api/capability-activation/stats    按能力/项目聚合（ADMIN）
 *
 *  N20 showback（同前缀子路径，沿用 ADMIN + JwtAuthGuard）：
 *  PUT  /api/capability-activation/quota         upsert 配额配置（ADMIN）
 *  GET  /api/capability-activation/quota         列出配额配置（ADMIN）
 *  GET  /api/capability-activation/quota-status  配额状态 + 软阈值告警（ADMIN）
 *
 * **无 PATCH / DELETE**：append-only 在路由层即封死。
 *
 * 读取先按简单 ADMIN 处理；项目 admin 的按项目授权是下一轮增强（见回报）。
 * record 是 append-only 审计面，用 @WriteGuard(authenticated) 保留 JWT 调用方写入语义；
 * route-authz-matrix 禁止同一 handler 上 @Roles 与 @WriteGuard 共存。
 */
@ApiTags("Capability Activation")
@ApiBearerAuth("JWT")
@Controller("capability-activation")
export class CapabilityActivationController {
  constructor(
    private readonly svc: CapabilityActivationService,
    private readonly quota: QuotaService,
    // 成本归责：价目表读写 + 按 sessionId 诚实采样。末尾 @Optional 兼容既有
    // 定位参数装配（R394 教训），缺席时新端点显式 503 不伪装成功。
    @Optional() private readonly prices?: PriceService | null,
    @Optional() private readonly tokenSamples?: TokenSamplePort | null,
  ) {}

  /**
   * append-only 审计写入：JWT 登录即可（供 capability/workbench 调用方写入）；
   * 无资源归属校验，也不收窄为 ADMIN-only。
   */
  @Post()
  @WriteGuard("capability-activation", { scope: "authenticated" })
  @HttpCode(201)
  @ApiOperation({
    summary: "记录一次能力激活（JWT；供 capability/workbench 调用方写入）",
  })
  @ApiOkResponse({ type: ActivationLogViewDto })
  record(
    @Body() dto: CreateActivationDto,
    @Req() req: Request,
  ): Promise<CapabilityActivationLog> {
    // N19：API Key 主体（JwtAuthGuard 的 apiKey 分支）带真实 scope 进闸；
    // JWT 会话主体无 scope → undefined，service 跳过 scope 闸，行为逐字不变。
    const scope = isApiKeyUser(req.user) ? req.user.scope : undefined;
    return this.svc.record(dto, scope);
  }

  /** 静态段必须在参数路由之前——本控制器无 @Get(":id")，天然安全。 */
  @Get("stats")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "按 capabilityKey / 项目聚合激活次数（ADMIN）" })
  stats(@Query() query: ActivationStatsQueryDto): Promise<ActivationStats> {
    return this.svc.stats({ from: query.from, to: query.to });
  }

  /**
   * 成本归责（ADR-044 企业买单理由）：managed 价目表 CRUD（ADMIN）。
   * 价目只存 system_configs 零迁移；金额折算在 stats.dualBasis，零样本恒 null。
   */
  @Put("price")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "设置模型 token 价目（ADMIN；managed 配置）" })
  async setPrice(@Body() dto: SetPriceDto): Promise<unknown> {
    if (!this.prices)
      throw new Error("成本归责依赖未装配（PriceService/TokenSamplePort）");
    return this.prices.set(dto);
  }

  @Get("price")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "列出 managed 价目表（ADMIN）" })
  async listPrices(): Promise<unknown> {
    if (!this.prices)
      throw new Error("成本归责依赖未装配（PriceService/TokenSamplePort）");
    return this.prices.getByPrefix();
  }

  /** 按 sessionId 诚实采样（no_link/zero_sample/insufficient/ok），ADMIN 审计用。 */
  @Get("token-sample")
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: "按 sessionId 采样真实 token（ADMIN；无关联/零样本诚实标缺）",
  })
  // 契约与实现必须同口径：采样允许省略 sessionId（服务层返回 no_link 诚实标缺），
  // 故显式声明 required:false，避免 openapi 契约写成必填而实现可选（check:query-param-required）。
  @ApiQuery({ name: "sessionId", required: false })
  async tokenSample(
    @Query("sessionId") sessionId?: string,
  ): Promise<TokenSampleView> {
    if (!this.tokenSamples)
      throw new Error("成本归责依赖未装配（PriceService/TokenSamplePort）");
    return this.tokenSamples.sample(sessionId);
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
