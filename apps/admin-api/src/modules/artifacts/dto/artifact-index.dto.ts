import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsISO8601,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from "class-validator";
import { Transform, Type } from "class-transformer";
import { PageQueryDto } from "../../../common/dto/pagination.dto";
import { ARTIFACT_EXTENSION_FILTERS } from "../artifacts.constants";

/**
 * ARTIFACTS-INDEX-46：GET /artifacts 查询参数。
 *
 * 继承 PageQueryDto（API-07 教训：分页与业务过滤分层——本端点消费
 * applicationId/taskId/q/from/to/ext 真实过滤器，故在此显式声明，不混入通用基类）。
 */
export class ListArtifactRowsDto extends PageQueryDto {
  @ApiPropertyOptional({
    format: "uuid",
    description:
      "按应用过滤（冗余自任务行 tasks.applicationId 的写时快照；任务未挂应用/应用已删的产物行不命中）",
  })
  @IsOptional()
  @Type(() => String)
  @IsUUID()
  applicationId?: string;

  @ApiPropertyOptional({
    format: "uuid",
    description: "按任务过滤（冗余自执行行 task_executions.taskId）",
  })
  @IsOptional()
  @Type(() => String)
  @IsUUID()
  taskId?: string;

  @ApiPropertyOptional({
    description:
      "文件名关键字（name ILIKE 不区分大小写模糊匹配；长度上限 100，trim 后空串视为未传）",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Type(() => String)
  q?: string;

  @ApiPropertyOptional({
    format: "date-time",
    description:
      "仅返回 createdAt >= 该时刻的产物（ISO-8601 闭区间起点；非法格式 400 VALIDATION_FAILED）",
  })
  @IsOptional()
  @IsISO8601()
  @Type(() => String)
  from?: string;

  @ApiPropertyOptional({
    format: "date-time",
    description:
      "仅返回 createdAt <= 该时刻的产物（ISO-8601 闭区间终点；from>to 400 VALIDATION_FAILED）",
  })
  @IsOptional()
  @IsISO8601()
  @Type(() => String)
  to?: string;

  @ApiPropertyOptional({
    enum: [...ARTIFACT_EXTENSION_FILTERS],
    description:
      "按扩展名过滤（小写、不带点；命中文件名末尾的 .<ext>；不在白名单 400 VALIDATION_FAILED）",
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  @IsIn([...ARTIFACT_EXTENSION_FILTERS])
  ext?: string;

  @ApiPropertyOptional({
    description:
      "只看当前登录用户作为任务属主的交付物（role=user 的归属过滤之上再收紧；true/1 视为开启）",
    type: Boolean,
  })
  @IsOptional()
  @Transform(
    ({ value }) =>
      value === true || value === "true" || value === "1" || value === 1,
  )
  @IsBoolean()
  mine?: boolean;

  @ApiPropertyOptional({
    enum: ["me"],
    description:
      "mine 的别名写法：owner=me 等价于 mine=true；不接受他人 userId（role=user 的可见范围恒由服务端归属判定决定）",
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  @IsIn(["me"])
  owner?: "me";
}

/**
 * GET /artifacts 的响应行（execution_artifacts 行投影）。
 *
 * ARCH-23 先例：实体无 @ApiProperty 不进契约——响应 DTO 显式列字段，
 * 排除 execution/task 关联对象（只下发 id 列，避免嵌套实体形状固化）。
 */
export class ExecutionArtifactRowDto {
  @ApiProperty({ format: "uuid" })
  id: string;

  @ApiProperty({ format: "uuid", description: "所属执行 ID" })
  executionId: string;

  @ApiProperty({ format: "uuid", description: "所属任务 ID（冗余快照）" })
  taskId: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      "所属应用 ID（冗余快照；null = 任务未挂应用或应用已删除——SET NULL 语义）",
  })
  applicationId: string | null;

  @ApiProperty({ description: "产物裸文件名" })
  name: string;

  @ApiProperty({ description: "字节数" })
  size: number;

  @ApiProperty({ description: "存储字节的 sha256" })
  sha256: string;

  @ApiProperty({ description: "索引行创建时间（ISO-8601，随终态回调写入）" })
  createdAt: Date;
}
