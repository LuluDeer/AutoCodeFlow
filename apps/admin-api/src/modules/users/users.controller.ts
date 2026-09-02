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
import { PaginationDto } from "../../common/dto/pagination.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AuthUser } from "../../common/interfaces/auth-user.interface";
import { AuditService } from "../audit/audit.service";
import { UserRole } from "./entities/user.entity";

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
  findAll(@Query() pagination: PaginationDto) {
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
    const result = await this.usersService.remove(id);
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
