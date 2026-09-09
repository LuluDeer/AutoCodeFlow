import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";

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
