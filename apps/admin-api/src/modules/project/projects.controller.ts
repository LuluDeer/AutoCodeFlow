import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { UserRole } from "../users/entities/user.entity";
import { ProjectsService } from "./projects.service";
import { CreateProjectDto, UpdateProjectDto } from "./project.dto";
import { Project } from "./project.entity";

/**
 * AUTH-01（多租户 Project，第一批后端）：
 * GET /projects 全员可读（任何登录用户都需要选项目上下文）；
 * POST/PATCH/DELETE 仅 ADMIN——项目是租户边界资源，写面收紧到管理员，
 * 与 Users 模块的 RolesGuard 形态一致。
 */
@UseGuards(JwtAuthGuard)
@Controller("projects")
export class ProjectsController {
  constructor(private readonly service: ProjectsService) {}

  @Get()
  async findAll(): Promise<Project[]> {
    return this.service.findAll();
  }

  @Get(":id")
  async findOne(@Param("id", ParseUUIDPipe) id: string): Promise<Project> {
    return this.service.findOne(id);
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post()
  async create(@Body() dto: CreateProjectDto): Promise<Project> {
    return this.service.create(dto);
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch(":id")
  async update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateProjectDto,
  ): Promise<Project> {
    return this.service.update(id, dto);
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @Delete(":id")
  @HttpCode(200)
  async remove(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<{ deleted: boolean }> {
    return this.service.remove(id);
  }
}
