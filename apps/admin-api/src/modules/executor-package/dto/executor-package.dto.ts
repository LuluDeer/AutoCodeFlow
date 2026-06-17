import {
  IsString,
  IsEnum,
  IsOptional,
  IsNumber,
  IsNotEmpty,
  MaxLength,
  Min,
} from "class-validator";
import { Type } from "class-transformer";
import {
  ExecutorPackageType,
  ExecutorPackageStatus,
} from "../executor-package.entity";
import { PaginationDto } from "../../../common/dto/pagination.dto";

export class CreateExecutorPackageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  version: string;

  @IsEnum(ExecutorPackageType)
  type: ExecutorPackageType;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  platform?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  filePath: string;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  fileSize: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  checksum?: string;

  @IsOptional()
  @IsString()
  description?: string;
}

export class UpdateExecutorPackageDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  version?: string;

  @IsOptional()
  @IsEnum(ExecutorPackageType)
  type?: ExecutorPackageType;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  platform?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  filePath?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  fileSize?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  checksum?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(ExecutorPackageStatus)
  status?: ExecutorPackageStatus;
}

export class QueryExecutorPackageDto extends PaginationDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsEnum(ExecutorPackageType)
  type?: ExecutorPackageType;

  @IsOptional()
  @IsEnum(ExecutorPackageStatus)
  status?: ExecutorPackageStatus;

  @IsOptional()
  @IsString()
  platform?: string;
}
