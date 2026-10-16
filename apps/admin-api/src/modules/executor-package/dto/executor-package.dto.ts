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
  @ApiProperty({
    maxLength: 255,
    description: "包名称",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @ApiProperty({
    maxLength: 64,
    description: "包版本",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  version: string;

  @ApiProperty({
    enum: ExecutorPackageType,
    description: "包类型",
  })
  @IsEnum(ExecutorPackageType)
  type: ExecutorPackageType;

  @ApiPropertyOptional({
    maxLength: 128,
    description: "目标平台",
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  platform?: string;

  // filePath / fileSize 由服务端从上传文件推导（executor-package.service.create），
  // 不属于 multipart 表单字段；此前必填声明会让真实上传请求被全局
  // ValidationPipe（forbidNonWhitelisted）以 400 拒绝。
  @ApiPropertyOptional({
    maxLength: 64,
    description: "校验和",
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  checksum?: string;

  @ApiPropertyOptional({ description: "包描述" })
  @IsOptional()
  @IsString()
  description?: string;
}

// PK-02（DEEP_REVIEW 0ef3bbe）: 手写 Optional 字段改为 PartialType(CreateExecutorPackageDto)。
export class UpdateExecutorPackageDto extends PartialType(
  CreateExecutorPackageDto,
) {
  @ApiPropertyOptional({
    maxLength: 1024,
    description: "文件路径",
  })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  filePath?: string;

  @ApiPropertyOptional({
    minimum: 0,
    description: "文件字节数",
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  fileSize?: number;

  @ApiPropertyOptional({
    enum: ExecutorPackageStatus,
    description: "包状态",
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
    type: [String],
    description:
      "目标执行器 ID 列表（v4 UUID，<=100）。为空或缺省 = 推送到所有在线执行器",
  })
  @IsOptional()
  @IsArray()
  @IsUUID("4", { each: true })
  @ArrayMaxSize(100)
  executorIds?: string[];
}
