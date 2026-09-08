import {
  IsString,
  IsOptional,
  IsObject,
  IsEnum,
  IsNotEmpty,
  IsBoolean,
  MaxLength,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
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
  @IsOptional() @IsString() gitRepo?: string;
  @IsOptional() @IsString() gitBranch?: string;
  @IsOptional() @IsString() gitCommit?: string;
  @IsOptional() @IsObject() manifest?: Record<string, any>;
  @IsOptional() @IsObject() env?: Record<string, string>;
  @IsOptional() @IsString() entrypoint?: string;
  @IsOptional() @IsString() packageUrl?: string;

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

export class UpdateApplicationDto {
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() version?: string;
  @IsOptional() @IsString() runtime?: string;
  @IsOptional() @IsEnum(ApplicationStatus) status?: ApplicationStatus;
  @IsOptional() @IsString() gitRepo?: string;
  @IsOptional() @IsString() gitBranch?: string;
  @IsOptional() @IsString() gitCommit?: string;
  @IsOptional() @IsObject() manifest?: Record<string, any>;
  @IsOptional() @IsObject() env?: Record<string, string>;
  @IsOptional() @IsString() entrypoint?: string;
  @IsOptional() @IsString() packageUrl?: string;
  /** HMAC-SHA256 secret for webhook signature verification. Set to empty string to disable. */
  @IsOptional() @IsString() @MaxLength(256) webhookSecret?: string;

  /** DEP-04: 部署审批流开关（语义同 CreateApplicationDto）。 */
  @IsOptional()
  @IsBoolean()
  approvalRequired?: boolean;
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
}
