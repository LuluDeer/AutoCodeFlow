import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Optional,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Roles } from "../../common/decorators/roles.decorator";
import { WriteGuard } from "../../common/decorators/write-guard.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AuthUser } from "../../common/interfaces/auth-user.interface";
import { ParseUuidShapePipe } from "../../common/pipes/parse-uuid-shape.pipe";
import { UserRole } from "../users/entities/user.entity";
import {
  CapabilityService,
  CapabilityActor,
  CapabilityResolution,
  CapabilityDump,
} from "./capability.service";
import { Capability } from "./entities/capability.entity";
import {
  CreateCapabilityDto,
  UpdateCapabilityDto,
} from "./dto/create-capability.dto";
import {
  CapabilityDumpResponseDto,
  CapabilityResolutionResponseDto,
  ResolveCapabilityDto,
} from "./dto/resolve-capability.dto";
import { TransferCapabilityDto } from "./dto/transfer-capability.dto";
import { CapabilityViewDto } from "./dto/capability-view.dto";
import { CapabilityGenerationRegistry } from "./capability-generation.registry";

/**
 * ADR-040 / P1：Capability 注册表端点（管理台，全部走全局 JwtAuthGuard）。
 *
 *  GET    /api/capabilities                 列表（JWT 可读，任意登录角色）
 *  POST   /api/capabilities/resolve         合并查询（JWT 只读，任意登录角色；@WriteGuard authenticated 仅登记写面）
 *  GET    /api/capabilities/:key/dump       三栏审计（JWT 只读，凭据脱敏）
 *  POST   /api/capabilities                 新建（ADMIN）
 *  PATCH  /api/capabilities/:id             局部更新（ADMIN，合并后重跑确定性校验）
 *  DELETE /api/capabilities/:id             删除（ADMIN）
 *  POST   /api/capabilities/:id/transfer    所有权移交（ADMIN，新 owner + backer 双签）
 *
 * 真正写状态的端点用 @Roles(ADMIN) 角色门控（全站 JwtAuthGuard + RolesGuard 全局生效）；
 * resolve 是语义只读的 POST，WriteScope 无 read，故用 @WriteGuard(authenticated) 显式登记既有 JWT 契约，
 * 不收窄为 ADMIN。route-authz-matrix 禁止同一 handler 上 @Roles 与 @WriteGuard 共存。
 */
@ApiTags("Capabilities")
@ApiBearerAuth("JWT")
@Controller("capabilities")
export class CapabilityController {
  constructor(
    private readonly svc: CapabilityService,
    // N23：内存单测常以单参实例化本控制器，registry 缺席即 fail-open 走旧 service。
    @Optional() private readonly generation?: CapabilityGenerationRegistry,
  ) {}

  @Get()
  @ApiOperation({ summary: "列出全部 capability" })
  @ApiResponse({
    status: 200,
    description: "capability 列表",
    type: [CapabilityViewDto],
  })
  list(): Promise<Capability[]> {
    return this.svc.findAll();
  }

  /**
   * 语义只读：POST 仅因 layers/rules 请求体复杂而不用 GET；service.resolveFor 只查注册表并计算，不落库。
   * 保持原「任意登录用户可读」契约：不加 ADMIN；WriteScope 无 read，故用 authenticated 做写面显式登记。
   */
  @Post("resolve")
  @WriteGuard("capability-resolution", { scope: "authenticated" })
  @HttpCode(200)
  @ApiOperation({ summary: "解析 capability 的最终生效配置（JWT 只读）" })
  @ApiResponse({
    status: 200,
    description: "生效配置 + 策略结论 + 可选的可达性降级标记",
    type: CapabilityResolutionResponseDto,
  })
  @ApiResponse({ status: 400, description: "key 未注册 / layers 非法" })
  resolve(@Body() dto: ResolveCapabilityDto): Promise<CapabilityResolution> {
    // N23：优先读 generation swap 当前代；空态回退 service（既有 resolve 逐字不变）。
    if (!this.generation) return this.svc.resolveFor(dto);
    return this.generation.resolve(dto, () => this.svc.resolveFor(dto));
  }

  @Get(":key/dump")
  @ApiOperation({
    summary: "导出 capability 三栏配置审计（JWT 只读，凭据脱敏）",
  })
  @ApiParam({ name: "key", description: "capability key（非 UUID）" })
  // R292：两个 query 参数在实现签名里是真可选（?: string），
  // Nest 具名 @Query 会被 Swagger 推断为 required:true，故显式标注纠正。
  @ApiQuery({ name: "projectLayer", required: false, type: String })
  @ApiQuery({ name: "privateLayer", required: false, type: String })
  @ApiResponse({
    status: 200,
    description: "分层来源 / 生效值 / 来源层的三栏审计 + 可选的可达性降级标记",
    type: CapabilityDumpResponseDto,
  })
  @ApiResponse({ status: 400, description: "key 未注册 / 下层 JSON 非法" })
  dump(
    @Param("key") key: string,
    @Query("projectLayer") projectLayer?: string,
    @Query("privateLayer") privateLayer?: string,
  ): Promise<CapabilityDump> {
    return this.svc.dumpFor(key, projectLayer, privateLayer);
  }

  @Post()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "新建 capability（ADMIN）" })
  @ApiResponse({
    status: 201,
    description: "已创建的 capability",
    type: CapabilityViewDto,
  })
  @ApiResponse({ status: 400, description: "字段/scope/manifest 非法" })
  create(
    @Body() dto: CreateCapabilityDto,
    @CurrentUser() user: AuthUser,
  ): Promise<Capability> {
    return this.svc.create(dto, this.actor(user));
  }

  @Patch(":id")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "局部更新 capability（ADMIN）" })
  @ApiParam({ name: "id", description: "capability UUID" })
  @ApiResponse({
    status: 200,
    description: "更新后的 capability",
    type: CapabilityViewDto,
  })
  @ApiResponse({ status: 400, description: "字段/scope/manifest 非法" })
  @ApiResponse({ status: 404, description: "capability 不存在" })
  update(
    @Param("id", ParseUuidShapePipe) id: string,
    @Body() dto: UpdateCapabilityDto,
    @CurrentUser() user: AuthUser,
  ): Promise<Capability> {
    return this.svc.update(id, dto, this.actor(user));
  }

  /**
   * N16 所有权移交：ADMIN-only 中台管控动作。新 owner + backer 双签由 DTO 形态闸
   * 强制（缺任一字段 400）；svc.transfer 复用 update 的合并校验与乐观锁，
   * 并补一条 capability.transfer 治理审计（owner/backer 前后值），不引入旁路写库。
   */
  @Post(":id/transfer")
  @Roles(UserRole.ADMIN)
  @HttpCode(200)
  @ApiOperation({
    summary: "移交 capability 所有权（ADMIN；新 owner + backer 双签）",
  })
  @ApiParam({ name: "id", description: "capability UUID" })
  @ApiResponse({
    status: 200,
    description: "移交后的 capability",
    type: CapabilityViewDto,
  })
  @ApiResponse({
    status: 400,
    description: "owner/backer 缺失、空串或非字符串（须双签）",
  })
  @ApiResponse({ status: 403, description: "非 ADMIN 无权移交" })
  @ApiResponse({ status: 404, description: "capability 不存在" })
  transfer(
    @Param("id", ParseUuidShapePipe) id: string,
    @Body() dto: TransferCapabilityDto,
    @CurrentUser() user: AuthUser,
  ): Promise<Capability> {
    return this.svc.transfer(
      id,
      { owner: dto.owner, backer: dto.backer },
      this.actor(user),
    );
  }

  @Delete(":id")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "删除 capability（ADMIN）" })
  @ApiParam({ name: "id", description: "capability UUID" })
  @ApiResponse({ status: 200, description: "已删除" })
  @ApiResponse({ status: 404, description: "capability 不存在" })
  async remove(
    @Param("id", ParseUuidShapePipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<{ ok: true }> {
    await this.svc.remove(id, this.actor(user));
    return { ok: true };
  }

  private actor(user: AuthUser): CapabilityActor {
    return { id: user.id, username: user.username, role: user.role };
  }
}
