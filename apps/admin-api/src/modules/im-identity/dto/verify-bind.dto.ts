import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { IM_PLATFORMS } from "../entities/im-identity.entity";
import { PROJECT_ROLES } from "../../project/entities/project-member.entity";

/**
 * N6：Gateway sender 校验通过后把 IM 身份绑定到平台 user。
 *
 * DTO 只做形态校验（平台枚举 / sender 长度 / user id 为正整数 / 项目角色枚举）；
 * 「user 必须真实存在」「sender 签名必须验过」这两条语义在 service 层，
 * 因为单测以内存 repo 直接调 service，不能只靠 class-validator。
 */
export class VerifyBindDto {
  @ApiProperty({ enum: IM_PLATFORMS, example: "wecom" })
  @IsString()
  @IsIn([...IM_PLATFORMS])
  platform: string;

  @ApiProperty({ example: "zhangsan", description: "IM 平台内的 sender id" })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  imSenderId: string;

  @ApiProperty({ example: 42, description: "平台 users 表主键" })
  @IsInt()
  @Min(1)
  platformUserId: number;

  @ApiPropertyOptional({ description: "项目 id；省略 = 不归属具体项目" })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({ enum: PROJECT_ROLES, description: "项目角色" })
  @IsOptional()
  @IsString()
  @IsIn([...PROJECT_ROLES])
  projectRole?: string;
}
