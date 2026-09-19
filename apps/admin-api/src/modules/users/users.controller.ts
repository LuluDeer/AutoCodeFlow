import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ParseIntPipe,
  Query,
  UseGuards,
  Req,
  ForbiddenException,
  BadRequestException,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { Request } from "express";
import * as bcrypt from "bcrypt";
import { UsersService } from "./users.service";
import { CreateUserDto } from "./dto/create-user.dto";
import { UpdateUserDto } from "./dto/update-user.dto";
import { PageQueryDto } from "../../common/dto/pagination.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AuthUser } from "../../common/interfaces/auth-user.interface";
import { AuditService } from "../audit/audit.service";
import { UserRole } from "./entities/user.entity";
import { WriteGuard } from "../../common/decorators/write-guard.decorator";

@ApiTags("Users")
@ApiBearerAuth("JWT")
@UseGuards(JwtAuthGuard)
@Controller("users")
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly audit: AuditService,
  ) {}

  // S11: only admins can create users
  @Post()
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Create user" })
  async create(
    @Body() dto: CreateUserDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const result = await this.usersService.create(dto);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "user.create",
      resource: "user",
      resourceId: String(result.id),
      ip: req.ip,
    });
    return result;
  }

  @Get()
  // M-4: only admins may enumerate user accounts (and their lockedUntil /
  // loginFailCount state). Otherwise any authenticated user could harvest
  // the directory and lockout schedule.
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Get user list" })
  // API-07（本轮体验审查）：改用 PageQueryDto（只有 page/pageSize）。
  // 原用 PaginationDto，而后者携带**任务专用**的 name/status/runtime 三个
  // 过滤字段——于是本端点的 OpenAPI 参数表上出现了
  // `name` = "Fuzzy search by task name"，而 `usersService.findAll` 只读
  // page/pageSize，**完全忽略**它。调用方传 `?name=alice` 会拿到 HTTP 200 +
  // 未过滤的全量用户列表，**无法分辨"没有匹配"与"过滤没生效"**。整个响应
  // 没有任何信号说明参数被忽略了。
  // 改为不含过滤字段的基类后，契约如实；被移除的字段本就被忽略，故这是纯
  // 契约收窄，运行时行为零变化。
  findAll(@Query() pagination: PageQueryDto) {
    return this.usersService.findAll(pagination);
  }

  @Get(":id")
  // Same protection for single-user lookup: non-admins can only fetch their
  // own profile; admins can fetch anyone. The service helper returns null
  // for missing users so callers never leak existence via 404 (H-3).
  @ApiOperation({ summary: "Get user details" })
  async findOne(
    @Param("id", ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    const isAdmin = user?.role === UserRole.ADMIN;
    if (!isAdmin && user?.id !== id) {
      throw new ForbiddenException("You can only view your own account");
    }
    const found = await this.usersService.findByIdOrNull(id);
    if (!found) throw new ForbiddenException("User not found");
    return found;
  }

  // S11+S12: admin can update any user; non-admin can only update their own profile
  // S12: when updating password, current password must be verified first
  @WriteGuard("user", { scope: "authenticated" })
  @Patch(":id")
  @ApiOperation({ summary: "Update user" })
  async update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateUserDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const isAdmin = user?.role === UserRole.ADMIN;
    if (!isAdmin && user?.id !== id) {
      throw new ForbiddenException("You can only update your own account");
    }

    // SEC: prevent privilege escalation — non-admins cannot change their own role
    if (!isAdmin && dto.role !== undefined) {
      throw new ForbiddenException("Only admins can change user roles");
    }

    // S12: non-admins must supply currentPassword when changing their password
    if (dto.password && !isAdmin) {
      const currentPassword: string | undefined = dto.currentPassword;
      if (!currentPassword) {
        throw new BadRequestException(
          "currentPassword is required when changing password",
        );
      }
      const existingUser = await this.usersService.findByIdRaw(id);
      if (!existingUser) throw new BadRequestException("User not found");
      const valid = await bcrypt.compare(
        currentPassword,
        existingUser.password,
      );
      if (!valid) {
        throw new BadRequestException("currentPassword is incorrect");
      }
    }

    const result = await this.usersService.update(id, dto);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "user.update",
      resource: "user",
      resourceId: String(id),
      ip: req.ip,
    });
    return result;
  }

  // S11: only admins can delete users
  @Delete(":id")
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Delete user" })
  async remove(
    @Param("id", ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    // R-14: 透传发起者——服务层据此拒绝自删（并保留最后一名管理员）。
    const result = await this.usersService.remove(id, user?.id);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "user.delete",
      resource: "user",
      resourceId: String(id),
      ip: req.ip,
    });
    return result;
  }
}
