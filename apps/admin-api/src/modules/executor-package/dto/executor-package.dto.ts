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

  // filePath / fileSize 由服务端从上传文件推导（executor-package.service.create），
  // 不属于 multipart 表单字段；此前必填声明会让真实上传请求被全局
  // ValidationPipe（forbidNonWhitelisted）以 400 拒绝。
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
