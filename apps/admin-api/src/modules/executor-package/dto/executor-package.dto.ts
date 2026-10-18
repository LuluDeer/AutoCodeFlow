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

  /**
   * §2.1（推广到 `GET /executor-packages`）：**可选**的不透明游标。
   *
   * 只做加性过渡——不传它时行为与引入本字段之前**逐字节不变**（走 OFFSET 分支，
   * 响应里连 `nextCursor` 这个键都不出现）。传了它才切到 keyset 分支。
   *
   * **响应形状**：本端点返回裸 `{items,total}`（不是 paginate() 信封），keyset
   * 分支也**不改变**该形状，只**追加** `nextCursor`。这是刻意的——`items` 被
   * admin-web 的 `listPackages()`（包表分页）与 `listLatest()`（安装向导取最新包）
   * 消费，改成信封会让 `res.items` 变 undefined、包表恒空。
   *
   * 为什么不做 `@Matches` 格式校验：与 `TaskExecutionsQueryDto#cursor` 逐字同因
   * ——合法性判定集中在纯函数 `decodeKeysetCursor` 里，由它抛
   * `VALIDATION_FAILED`（400 + 可操作 detail），而不是让管道抛"字段名数组"让
   * 前端渲染成"参数校验失败"。
   *
   * `name`/`type`/`status`/`platform` 四个过滤器与游标条件是 AND 关系，可任意
   * 组合（本端点排序恒为 `createdAt DESC, id DESC`，没有 sortBy 那类冲突参数）。
   */
  @ApiPropertyOptional({
    description:
      "不透明的 keyset 游标（上一页响应的 nextCursor）。省略时走原有 OFFSET 分页，响应与之前完全一致；传入时走 keyset 分支并在响应中追加 nextCursor。首次进入 keyset 模式传空值（?cursor=）。可与全部过滤器（name/type/status/platform）组合——它们与游标条件取交集。非法游标返回 400（VALIDATION_FAILED），不会静默退回第一页。",
  })
  @IsOptional()
  @IsString()
  cursor?: string;
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
