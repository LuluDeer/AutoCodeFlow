import {
  IsString,
  IsEnum,
  IsOptional,
  IsNumber,
  IsNotEmpty,
  MaxLength,
  Min,
  IsArray,
  IsUUID,
  ArrayMaxSize,
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

// 审计 E-P2-S3：push 端点入参此前是 `@Body("executorIds") executorIds?: string[]`
// 内联类型，完全不走 class-validator。executorIds 是目标执行器 ID 列表——
// 旧实现既不校验元素形态（任意字符串都被透传给 pushToExecutors 去 HTTP 调用），
// 也没有数组长度上限（可传数万条）。现抽 DTO：元素必须是 v4 UUID，且 ≤100 个。
export class PushExecutorPackageDto {
  @ApiPropertyOptional({
    description:
      "Target executor ID list (v4 UUIDs, <=100). Empty/omitted = push to all online executors",
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsUUID("4", { each: true })
  @ArrayMaxSize(100)
  executorIds?: string[];
}
