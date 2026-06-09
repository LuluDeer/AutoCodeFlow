import { IsString, IsOptional, IsObject, IsEnum } from 'class-validator';
import { ApplicationStatus } from '../entities/application.entity';

export class CreateApplicationDto {
  @IsString() name: string;
  @IsOptional() @IsString() description?: string;
  @IsString() version: string;
  @IsString() runtime: string;
  @IsOptional() @IsString() gitRepo?: string;
  @IsOptional() @IsString() gitBranch?: string;
  @IsOptional() @IsString() gitCommit?: string;
  @IsOptional() @IsObject() manifest?: Record<string, any>;
  @IsOptional() @IsObject() env?: Record<string, string>;
  @IsOptional() @IsString() entrypoint?: string;
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
}