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
  ConflictException,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { Request } from "express";
import * as bcrypt from "bcrypt";
import { UsersService } from "./users.service";
import { CreateUserDto } from "./dto/create-user.dto";
import { UpdateUserDto } from "./dto/update-user.dto";
import { ListUsersDto } from "./dto/list-users.dto";
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
  // API-07（历史）：曾从携带任务专用过滤字段的 PaginationDto 收窄为 PageQueryDto
  // （name/status/runtime 被 OpenAPI 公示却从未被消费，传了静默无效）。
  // 本轮在收窄后的基础上补一个**真实被消费**的 search 过滤（ListUsersDto）：
  // username/email ILIKE 模糊匹配，服务前端用户管理页的全量搜索——前端原先
  // 只在前端当前页数据里 filter，用户数超过一页时搜索结果不完整。与 API-07
  // 的区别：字段进入 service 查询条件并如实写进 OpenAPI，不再有静默忽略。
  findAll(@Query() pagination: ListUsersDto) {
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

    // 审计 E-P2-S4：普通用户自改 username 时做唯一性占用校验。
    // 旧实现：自改 username 直接 Object.assign → save，撞 user.username 唯一索引
    // 时冒成裸 500（23505），对前端不可读。此处前置校验：目标 username 已被他人
    // 占用 → 409。管理员改他人账号不在本分支（admin 不受此自改限制）。
    if (!isAdmin && dto.username) {
      const existing = await this.usersService.findByUsername(dto.username);
      if (existing && existing.id !== id) {
        throw new ConflictException("Username is already taken");
      }
    }

    // A-7（R3-A 审计）：自改 email 同形态预检——email 与 username 同为唯一列，
    // 旧实现只预检 username，自改 email 撞 user.email 唯一索引（23505）同样
    // 冒成裸 500。目标 email 已被他人占用 → 409（与 username 同文案形态）。
    // 管理员改他人账号不在本分支（仍由服务层/DB 约束兜底）。
    if (!isAdmin && dto.email) {
      const existingEmail = await this.usersService.findByEmail(dto.email);
      if (existingEmail && existingEmail.id !== id) {
        throw new ConflictException("Email is already taken");
      }
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
