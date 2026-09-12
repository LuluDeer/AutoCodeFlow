import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";
import { PROJECT_ROLES } from "./entities/project-member.entity";

/**
 * AUTH-01：Projects 模块 DTO。name 唯一性由 DB unique index 兜底
 * （Postgres unique-violation → 409 Conflict，见 ProjectsService.create）。
 */
export class CreateProjectDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class UpdateProjectDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

/** AUTH-02：新增/修改项目成员（role 三档，@IsIn 与实体常量同源防漂移）。 */
export class UpsertProjectMemberDto {
  @IsInt()
  userId: number;

  @IsIn(PROJECT_ROLES as unknown as string[])
  role: (typeof PROJECT_ROLES)[number];
}

/** AUTH-02：仅改角色（成员必须已存在）。 */
export class UpdateProjectMemberDto {
  @IsIn(PROJECT_ROLES as unknown as string[])
  role: (typeof PROJECT_ROLES)[number];
}
