import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  ForbiddenException,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { UserRole } from "../users/entities/user.entity";
import { ProjectsService } from "./projects.service";
import { ProjectAccessService } from "./project-access.service";
import {
  CreateProjectDto,
  UpdateProjectDto,
  UpsertProjectMemberDto,
  UpdateProjectMemberDto,
} from "./project.dto";
import { Project, DEFAULT_PROJECT_ID } from "./project.entity";
import type { ProjectMemberView } from "./project-access.service";

/**
 * AUTH-01（多租户 Project，第一批后端）：
 * GET /projects 全员可读（任何登录用户都需要选项目上下文）；
 * POST/PATCH/DELETE 仅 ADMIN——项目是租户边界资源，写面收紧到管理员，
 * 与 Users 模块的 RolesGuard 形态一致。
 */
@UseGuards(JwtAuthGuard)
@Controller("projects")
export class ProjectsController {
  constructor(
    private readonly service: ProjectsService,
    private readonly access: ProjectAccessService,
  ) {}

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

  // -----------------------------------------------------------------------
  // AUTH-02：项目成员与角色
  //
  // 写面（任免/改角色/移除）保持 ADMIN-only——项目角色是租户级授权，把
  // 「谁能在项目里做什么」交给项目内 admin 自管会带来提权链（项目 admin
  // 给自己 editor 之外还能改别人），本批不引入嵌套授权治理。角色**消费面**
  // （任务/应用写面、执行类写面）才是 AUTH-02 的放行增量所在。
  // 读面：成员本人可看自己所属项目的成员列表（viewer 也需要知道同项目协作
  // 者），ADMIN 全量。
  // -----------------------------------------------------------------------

  @Get(":id/members")
  async listMembers(
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: number; role: UserRole } | undefined,
  ): Promise<ProjectMemberView[]> {
    // 默认项目恒可读：它是「未分配资源」的归属视图，读它不构成越权。
    if (user?.role !== UserRole.ADMIN && id !== DEFAULT_PROJECT_ID) {
      const role = await this.access.resolveRole(user?.id, id);
      if (!role) {
        throw new ForbiddenException("You are not a member of this project");
      }
    }
    return this.access.listMembers(id);
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post(":id/members")
  async addMember(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpsertProjectMemberDto,
  ): Promise<ProjectMemberView> {
    return this.access.addMember(id, dto.userId, dto.role);
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch(":id/members/:userId")
  async updateMember(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("userId", ParseIntPipe) userId: number,
    @Body() dto: UpdateProjectMemberDto,
  ): Promise<ProjectMemberView> {
    return this.access.updateMember(id, userId, dto.role);
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @Delete(":id/members/:userId")
  @HttpCode(200)
  async removeMember(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("userId", ParseIntPipe) userId: number,
  ): Promise<{ deleted: boolean }> {
    return this.access.removeMember(id, userId);
  }

  /** AUTH-02：当前登录用户在各项目中的角色（admin-web 用它渲染可用项目）。 */
  @Get("me/roles")
  async myRoles(
    @CurrentUser() user: { id: number; role: UserRole } | undefined,
  ): Promise<{
    userId: number | null;
    isAdmin: boolean;
    memberships: ProjectMemberView[];
  }> {
    return {
      userId: user?.id ?? null,
      isAdmin: user?.role === UserRole.ADMIN,
      memberships: user?.id ? await this.access.listRolesForUser(user.id) : [],
    };
  }
}
