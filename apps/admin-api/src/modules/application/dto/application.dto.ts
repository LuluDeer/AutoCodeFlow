import {
  IsString,
  IsOptional,
  IsObject,
  IsEnum,
  IsNotEmpty,
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
}
