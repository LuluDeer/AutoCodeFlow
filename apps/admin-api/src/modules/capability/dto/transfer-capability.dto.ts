import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, MaxLength } from "class-validator";

/**
 * N16 所有权移交请求体（ADMIN-only 中台管控动作）。
 *
 * 移交必须「双签」：新 owner（发布者身份键）与 backer（部门/角色背书）同时非空。
 * 两个字段都不带 @IsOptional —— 只传 owner 或缺 backer 时，全局 ValidationPipe
 * 直接 400，杜绝「孤儿化」半签落库。字段长度与 capability.entity 的
 * varchar(128) 列宽、CreateCapabilityDto 的 owner/backer 闸同口径。
 */
export class TransferCapabilityDto {
  @ApiProperty({
    example: "user:42|alice",
    maxLength: 128,
    description: "新发布者身份键（必填非空字符串，最长 128 字符）",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  owner: string;

  @ApiProperty({
    example: "role:platform-eng",
    maxLength: 128,
    description: "新部门/角色背书（必填非空字符串，最长 128 字符；非个人）",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  backer: string;
}
