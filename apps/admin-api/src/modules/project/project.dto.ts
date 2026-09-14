import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional, PartialType } from "@nestjs/swagger";
import { PROJECT_ROLES, ProjectRole } from "./entities/project-member.entity";

/**
 * AUTH-01：Projects 模块 DTO。name 唯一性由 DB unique index 兜底
 * （Postgres unique-violation → 409 Conflict，见 ProjectsService.create）。
 */
export class CreateProjectDto {
  @ApiProperty({ description: "Project name", minLength: 1, maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({ description: "Project description", maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

// PK-02（DEEP_REVIEW 0ef3bbe）: 手写 Optional 字段改为 PartialType(CreateProjectDto)。
export class UpdateProjectDto extends PartialType(CreateProjectDto) {}

/** AUTH-02：新增/修改项目成员（role 三档，@IsIn 与实体常量同源防漂移）。 */
export class UpsertProjectMemberDto {
  @ApiProperty({ description: "User ID", type: "integer" })
  @IsInt()
  userId: number;

  @ApiProperty({ description: "Project role", enum: PROJECT_ROLES })
  @IsIn(PROJECT_ROLES as unknown as string[])
  role: (typeof PROJECT_ROLES)[number];
}

/** AUTH-02：仅改角色（成员必须已存在）。PK-02: 改用 PartialType(UpsertProjectMemberDto)。 */
export class UpdateProjectMemberDto extends PartialType(UpsertProjectMemberDto) {}

/**
 * AUTH-02 后续：项目列表行视图（GET /projects 响应）。
 *
 * 相比 Project 实体多一个 `myRole`——当前请求主体在该项目的成员角色，
 * 非成员（含 ADMIN 主体的非成员行）为 null。admin-web 用它渲染「我的角色」
 * 徽标与写面门控；读面过滤语义见 projects.controller.findAll。
 * 形态对齐 DEP-01 AppReleaseRow 先例：响应视图行用 interface（该端点
 * 历史上无 swagger response schema，零 openapi 漂移）。
 */
export interface ProjectViewRow {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  myRole: ProjectRole | null;
}
