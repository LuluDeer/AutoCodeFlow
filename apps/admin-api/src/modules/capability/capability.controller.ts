import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import { ResolveCapabilityDto } from "./dto/resolve-capability.dto";
import { CapabilityViewDto } from "./dto/capability-view.dto";

/**
 * ADR-040 / P1：Capability 注册表端点（管理台，全部走全局 JwtAuthGuard）。
 *
 *  GET    /api/capabilities                 列表（JWT 可读，任意登录角色）
 *  POST   /api/capabilities/resolve         合并查询（JWT 只读，任意登录角色）
 *  GET    /api/capabilities/:key/dump       三栏审计（JWT 只读，凭据脱敏）
 *  POST   /api/capabilities                 新建（ADMIN）
 *  PATCH  /api/capabilities/:id             局部更新（ADMIN，合并后重跑确定性校验）
 *  DELETE /api/capabilities/:id             删除（ADMIN）
 *
 * 写端点用 @Roles(ADMIN) 角色门控（全站 JwtAuthGuard + RolesGuard 全局生效），
 * 不叠加 @WriteGuard（route-authz-matrix 禁止 @Roles 与 @WriteGuard 共存）。
 */
@ApiTags("Capabilities")
@ApiBearerAuth("JWT")
@Controller("capabilities")
export class CapabilityController {
  constructor(private readonly svc: CapabilityService) {}

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

  @Post("resolve")
  @HttpCode(200)
  @ApiOperation({ summary: "解析 capability 的最终生效配置（JWT 只读）" })
  @ApiResponse({ status: 200, description: "生效配置 + 策略结论" })
  @ApiResponse({ status: 400, description: "key 未注册 / layers 非法" })
  resolve(@Body() dto: ResolveCapabilityDto): Promise<CapabilityResolution> {
    return this.svc.resolveFor(dto);
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
    description: "分层来源 / 生效值 / 来源层的三栏审计",
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
