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
import { ApiProperty, ApiPropertyOptional, PartialType } from "@nestjs/swagger";

export class CreateExecutorPackageDto {
  @ApiProperty({ description: "Package name", maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @ApiProperty({ description: "Package version", maxLength: 64 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  version: string;

  @ApiProperty({ description: "Package type", enum: ExecutorPackageType })
  @IsEnum(ExecutorPackageType)
  type: ExecutorPackageType;

  @ApiPropertyOptional({ description: "Target platform", maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  platform?: string;

  // filePath / fileSize 由服务端从上传文件推导（executor-package.service.create），
  // 不属于 multipart 表单字段；此前必填声明会让真实上传请求被全局
  // ValidationPipe（forbidNonWhitelisted）以 400 拒绝。
  @ApiPropertyOptional({ description: "Checksum", maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  checksum?: string;

  @ApiPropertyOptional({ description: "Package description" })
  @IsOptional()
  @IsString()
  description?: string;
}

// PK-02（DEEP_REVIEW 0ef3bbe）: 手写 Optional 字段改为 PartialType(CreateExecutorPackageDto)。
export class UpdateExecutorPackageDto extends PartialType(
  CreateExecutorPackageDto,
) {
  @ApiPropertyOptional({ description: "File path", maxLength: 1024 })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  filePath?: string;

  @ApiPropertyOptional({ description: "File size in bytes", minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  fileSize?: number;

  @ApiPropertyOptional({
    description: "Package status",
    enum: ExecutorPackageStatus,
  })
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
