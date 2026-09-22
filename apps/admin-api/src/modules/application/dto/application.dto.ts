import { PartialType, ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsOptional,
  IsObject,
  IsEnum,
  IsNotEmpty,
  IsBoolean,
  MaxLength,
} from "class-validator";
import { ApplicationStatus } from "../entities/application.entity";

export class CreateApplicationDto {
  @ApiProperty({ description: "Unique application name", maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({ description: "Application description" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ description: "Application version number", example: "1.0.0" })
  @IsString()
  @IsNotEmpty()
  version: string;

  @ApiProperty({ description: "Runtime type", example: "node" })
  @IsString()
  @IsNotEmpty()
  runtime: string;

  // PK-02（DEEP_REVIEW 0ef3bbe）: 补 @ApiPropertyOptional 使 openapi schema 非空
  @ApiPropertyOptional() @IsOptional() @IsString() gitRepo?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() gitBranch?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() gitCommit?: string;
  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  manifest?: Record<string, any>;
  @ApiPropertyOptional({ type: Object }) @IsOptional() @IsObject() env?: Record<
    string,
    string
  >;
  @ApiPropertyOptional() @IsOptional() @IsString() entrypoint?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() packageUrl?: string;

  /** DEP-04: 部署审批流开关（开启后 deploy 冻结为待审批行，需第二人放行）。 */
  @ApiPropertyOptional({
    description:
      "DEP-04: require second-person approval before new deployments dispatch",
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  approvalRequired?: boolean;
}

// PK-02（DEEP_REVIEW 0ef3bbe）: 手写 Optional 字段改为 PartialType(CreateApplicationDto)。
export class UpdateApplicationDto extends PartialType(CreateApplicationDto) {
  @ApiPropertyOptional({
    description: "Application status",
    enum: ApplicationStatus,
  })
  @IsOptional()
  @IsEnum(ApplicationStatus)
  status?: ApplicationStatus;

  /** HMAC-SHA256 secret for webhook signature verification. Set to empty string to disable. */
  @ApiPropertyOptional({
    description:
      "HMAC-SHA256 secret for webhook signature verification. Set to empty string to disable.",
    maxLength: 256,
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  webhookSecret?: string;
}

/**
 * ARCH-003: multipart upload fields go through the global ValidationPipe
 * (whitelist + forbidNonWhitelisted) instead of bare @Body("name") strings,
 * so overlong/malformed fields are rejected with 400 before touching disk.
 */
export class UploadApplicationDto {
  @ApiProperty({ description: "Application name", maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({
    description: "Runtime type",
    example: "node",
    maxLength: 50,
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  runtime?: string;

  /**
   * 上传即产生版本（方案 A）。可选——不传时行为与既往完全一致（只替换包
   * 文件，不动版本号）。传了则把 application.version 抬到该值，并写一条
   * application_versions 快照，使详情页版本列表立刻可见。
   */
  @ApiPropertyOptional({
    description:
      "Version number to record for this upload (e.g. 1.0.1). Omit to keep the current version.",
    example: "1.0.1",
    maxLength: 50,
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  version?: string;
}
